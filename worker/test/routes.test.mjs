/**
 * The routes, driven through the real fetch handler.
 *
 * /stats must be matched before the alias pattern, or it would be read as
 * an edition named "stats"; and a drill-down link must carry the filters
 * already applied, or clicking one resets the view.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from '../src/index.js';

function env({ sql = [], kv = {} } = {}) {
  const store = new Map(Object.entries(kv));
  return {
    BUCKET: {
      list: async () => ({ objects: [], truncated: false }),
      get: async () => null,
    },
    DOWNLOADS: { writeDataPoint: () => {} },
    STATS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    ACCOUNT_ID: 'acct',
    ANALYTICS_TOKEN: 'tok',
    _sql: sql,
  };
}

/** Capture the sql the handler sends, and answer with fixed rows. */
function stubFetch(rows) {
  const seen = [];
  global.fetch = async (_url, init) => {
    seen.push(init.body);
    return { ok: true, json: async () => ({ data: rows }) };
  };
  return seen;
}

const get = (path) => new Request(`https://manjaro.download${path}`);

test('/stats renders and is not mistaken for an alias', async () => {
  stubFetch([
    { label: 'xfce', downloads: '40' },
    { label: 'sway', downloads: '10' },
  ]);
  const res = await worker.fetch(get('/stats'), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /xfce/);
  assert.match(html, /50 downloads/, 'the total is the sum of the rows');
  assert.match(html, /by edition/);
});

test('a drill-down link keeps the filters already applied', async () => {
  stubFetch([{ label: 'unstable', downloads: '5' }]);
  const res = await worker.fetch(get('/stats?edition=xfce'), env());
  const html = await res.text();
  // pinned on edition, so the next axis is branch, and the link must carry both
  assert.match(html, /by branch/);
  assert.match(html, /edition=xfce/);
  assert.match(html, /branch=unstable/);
});

test('the filters reach the query, quoted', async () => {
  const seen = stubFetch([{ label: 'rc-1', downloads: '1' }]);
  await worker.fetch(get("/stats?edition=x'y&branch=stable"), env());
  const sql = seen.at(-1);
  assert.match(sql, /blob2 = 'x''y'/, 'a quote must be escaped, not passed through');
  assert.match(sql, /blob3 = 'stable'/);
});

test('an archived month is answered from kv, without a query', async () => {
  const seen = stubFetch([]);
  const res = await worker.fetch(
    get('/stats?month=2026-02'),
    env({ kv: { 'month:2026-02': JSON.stringify({ xfce: { stable: 30, unstable: 12 } }) } }),
  );
  const html = await res.text();
  assert.equal(seen.length, 0, 'an archived month must not hit analytics engine');
  assert.match(html, /42 downloads/);
  assert.match(html, /xfce stable/);
});

test('a month with nothing archived says so rather than erroring', async () => {
  stubFetch([]);
  const res = await worker.fetch(get('/stats?month=1999-01'), env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /nothing archived/);
});

test('stats.json exposes the archive and the recent detail', async () => {
  stubFetch([
    { release: 'rc-1', edition: 'xfce', branch: 'stable', version: '26.1.1', kernel: 'linux72', downloads: '3' },
  ]);
  const res = await worker.fetch(
    get('/stats.json'),
    env({
      kv: {
        months: JSON.stringify(['2026-02']),
        'month:2026-02': JSON.stringify({ xfce: { stable: 30 } }),
      },
    }),
  );
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.deepEqual(body.months, { '2026-02': { xfce: { stable: 30 } } });
  assert.equal(body.recent[0].release, 'rc-1');
});

test('an alias still resolves, so the new routes did not shadow it', async () => {
  const e = env();
  e.BUCKET.list = async () => ({
    objects: [{ key: 'rc-2/manjaro-sway-26.1.1-unstable-260907-linux72.iso', size: 1 }],
    truncated: false,
  });
  const res = await worker.fetch(get('/sway-unstable.iso'), e);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/rc-2/manjaro-sway-26.1.1-unstable-260907-linux72.iso');
});

test('the scheduled handler archives the month that closed', async () => {
  const seen = stubFetch([{ edition: 'xfce', branch: 'stable', downloads: '4' }]);
  const e = env();
  const waits = [];
  await worker.scheduled(
    { scheduledTime: Date.parse('2026-03-02T03:17:00Z') },
    e,
    { waitUntil: (p) => waits.push(p) },
  );
  await Promise.all(waits);
  assert.match(seen.at(-1), /toDate\('2026-02-01'\)/, 'february, not march');
  assert.equal(await e.STATS.get('month:2026-02'), JSON.stringify({ xfce: { stable: 4 } }));
});

test('without the token, /stats says so rather than erroring', async () => {
  stubFetch([]);
  const e = env();
  delete e.ANALYTICS_TOKEN;
  const res = await worker.fetch(get('/stats'), e);
  assert.equal(res.status, 200, 'a public page must not 500 while unconfigured');
  assert.match(await res.text(), /not configured/);
});

test('without the token, stats.json still publishes the archive', async () => {
  stubFetch([]);
  const e = env({
    kv: {
      months: JSON.stringify(['2026-02']),
      'month:2026-02': JSON.stringify({ xfce: { stable: 30 } }),
    },
  });
  delete e.ANALYTICS_TOKEN;
  const res = await worker.fetch(get('/stats.json'), e);
  const body = await res.json();
  assert.deepEqual(body.months, { '2026-02': { xfce: { stable: 30 } } });
  assert.deepEqual(body.recent, [], 'recent needs the token; the archive does not');
});

test('a download is still counted while stats are unconfigured', async () => {
  const e = env();
  delete e.ANALYTICS_TOKEN;
  const written = [];
  e.DOWNLOADS = { writeDataPoint: (p) => written.push(p) };
  e.BUCKET.get = async () => ({
    body: 'bytes',
    writeHttpMetadata: () => {},
    httpEtag: '"x"',
  });
  await worker.fetch(get('/rc-1/manjaro-xfce-26.1.1-unstable-260907-linux72.iso'), e);
  assert.equal(written.length, 1, 'counting must not depend on the read token');
});
