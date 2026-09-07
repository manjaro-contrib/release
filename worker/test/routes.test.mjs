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
    ANALYTICS_ENGINE: { writeDataPoint: () => {} },
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
  assert.match(
    seen.at(-1),
    /timestamp >= toDateTime\('2026-02-01 00:00:00'\)/,
    'february, not march',
  );
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
  e.ANALYTICS_ENGINE = { writeDataPoint: (p) => written.push(p) };
  e.BUCKET.get = async () => ({
    body: 'bytes',
    writeHttpMetadata: () => {},
    httpEtag: '"x"',
  });
  await worker.fetch(get('/rc-1/manjaro-xfce-26.1.1-unstable-260907-linux72.iso'), e);
  assert.equal(written.length, 1, 'counting must not depend on the read token');
});

test('the listing links to the stats page', async () => {
  // it shipped unlinked once: the page worked and nothing pointed at it
  const e = env();
  e.BUCKET.list = async () => ({
    objects: [{ key: 'rc-1/manjaro-sway-26.1.1-unstable-260907-linux72.iso', size: 1 }],
    truncated: false,
  });
  const html = await (await worker.fetch(get('/'), e)).text();
  assert.match(html, /href="\/stats"/);
});

test('the stats page links back out of itself', async () => {
  stubFetch([{ label: 'sway', downloads: '1' }]);
  const html = await (await worker.fetch(get('/stats'), env())).text();
  assert.match(html, /href="\/stats"/, 'the shared footer carries the link');
});

const ARCHIVE = {
  months: JSON.stringify(['2026-07', '2026-08', '2026-09']),
  'month:2026-08': JSON.stringify({ xfce: { stable: 30, unstable: 12 } }),
};

test('the landing page lists the archived months, newest first', async () => {
  // they exist in kv but were unreachable without guessing the query string
  stubFetch([{ label: 'xfce', downloads: '5' }]);
  const html = await (await worker.fetch(get('/stats'), env({ kv: ARCHIVE }))).text();
  assert.match(html, /archive/);
  const order = [...html.matchAll(/month=(\d{4}-\d{2})/g)].map((m) => m[1]);
  assert.deepEqual(order, ['2026-09', '2026-08', '2026-07']);
});

test('an archived month links its siblings and marks itself', async () => {
  stubFetch([]);
  const html = await (
    await worker.fetch(get('/stats?month=2026-08'), env({ kv: ARCHIVE }))
  ).text();
  assert.match(html, /42 downloads/);
  assert.match(html, /month=2026-07/);
  // in the archive list the current month is plain text, not a link.
  // The breadcrumb still links it, which is what a breadcrumb does.
  const archive = html.slice(html.indexOf('<h2>archive'));
  assert.match(archive, /<b>2026-08<\/b>/);
  assert.doesNotMatch(archive, /href="\/stats\?month=2026-08"/);
});

test('a month with nothing archived still offers the ones that exist', async () => {
  stubFetch([]);
  const html = await (
    await worker.fetch(get('/stats?month=1999-01'), env({ kv: ARCHIVE }))
  ).text();
  assert.match(html, /nothing archived/);
  assert.match(html, /month=2026-08/, 'a dead end must still lead somewhere');
});

test('a drilled-down view does not carry the archive', async () => {
  // the months aggregate everything, so listing them under a filtered
  // view would offer a link that silently drops the filter
  stubFetch([{ label: 'unstable', downloads: '3' }]);
  const html = await (
    await worker.fetch(get('/stats?edition=xfce'), env({ kv: ARCHIVE }))
  ).text();
  assert.doesNotMatch(html, /archive/);
});

test('with no archive yet, no empty section appears', async () => {
  stubFetch([{ label: 'xfce', downloads: '1' }]);
  const html = await (await worker.fetch(get('/stats'), env())).text();
  assert.doesNotMatch(html, /archive/);
});

test('the favicon is served, and declared in the page', async () => {
  const res = await worker.fetch(get('/favicon.svg'), env());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const body = await res.text();
  assert.match(body, /^<svg /);
  assert.doesNotMatch(body, /<!--/, 'comments are stripped from the inlined copy');

  // a browser that is not told will only guess /favicon.ico
  stubFetch([{ label: 'sway', downloads: '1' }]);
  const html = await (await worker.fetch(get('/stats'), env())).text();
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
});

test('an .ico request gets the same svg', async () => {
  const res = await worker.fetch(get('/favicon.ico'), env());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<svg /);
});

test('the favicon route does not shadow a release object', async () => {
  // a release is a prefix, so favicon.svg can only ever be at the root
  const e = env();
  let asked = null;
  e.BUCKET.get = async (k) => {
    asked = k;
    return null;
  };
  await worker.fetch(get('/rc-1/favicon.svg'), e);
  assert.equal(asked, 'rc-1/favicon.svg', 'a nested path still reaches the bucket');
});
