/**
 * The counting rules and the rollup, which are the parts that can silently
 * report wrong numbers. A range request counted as a download would inflate
 * one resumed ISO into dozens, and a rollup that writes kv from the request
 * path would lose counts - neither shows up as an error.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describe, resolveAlias, record, rollup, MONTH_KEY } from '../src/index.js';

/** Collects what the worker would have written. */
function fakeEnv({ rows = [] } = {}) {
  const points = [];
  const kv = new Map();
  return {
    points,
    kv,
    ANALYTICS_ENGINE: { writeDataPoint: (p) => points.push(p) },
    STATS: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => void kv.set(k, v),
    },
    ACCOUNT_ID: 'acct',
    ANALYTICS_TOKEN: 'token',
    _rows: rows,
  };
}

const KEY = 'rc-202609071023/manjaro-xfce-26.1.1-unstable-260907-linux72.iso';

test('a whole-image GET is counted once, with every axis', () => {
  const env = fakeEnv();
  record(env, KEY, 200, 'GET');
  assert.equal(env.points.length, 1);
  const [p] = env.points;
  assert.deepEqual(p.blobs, [
    'rc-202609071023',
    'xfce',
    'unstable',
    '26.1.1',
    'linux72',
  ]);
  assert.deepEqual(p.doubles, [1]);
  // one index only, and it must fit 96 bytes
  assert.equal(p.indexes.length, 1);
  assert.ok(p.indexes[0].length <= 96);
});

test('a resumed download does not inflate the count', () => {
  const env = fakeEnv();
  // a download manager fetching one ISO in eight parts
  for (let i = 0; i < 8; i += 1) record(env, KEY, 206, 'GET');
  assert.equal(env.points.length, 0, 'range requests must not count');
});

test('revalidation and HEAD do not count', () => {
  const env = fakeEnv();
  record(env, KEY, 304, 'GET');
  record(env, KEY, 200, 'HEAD');
  assert.equal(env.points.length, 0);
});

test('only the image counts, not what verifies it', () => {
  const env = fakeEnv();
  for (const suffix of ['.iso.sig', '.iso.sha256', '.iso.pkgs']) {
    record(env, `rc-1/manjaro-xfce-26.1.1-unstable-260907-linux72${suffix}`, 200, 'GET');
  }
  assert.equal(env.points.length, 0, 'signatures are not downloads');
});

test('a stable image, which carries no branch field, counts as stable', () => {
  const env = fakeEnv();
  record(env, 'rc-1/manjaro-gnome-26.1.1-260907-linux66.iso', 200, 'GET');
  assert.equal(env.points.length, 1);
  assert.equal(env.points[0].blobs[2], 'stable');
});

test('kde-dev is not read as kde', () => {
  const env = fakeEnv();
  record(env, 'rc-1/manjaro-kde-dev-26.1.1-testing-260907-linux72.iso', 200, 'GET');
  assert.equal(env.points[0].blobs[1], 'kde-dev');
});

test('a name missing version and kernel still counts', () => {
  const env = fakeEnv();
  record(env, 'rc-1/manjaro-sway-unstable.iso', 200, 'GET');
  assert.equal(env.points.length, 1, 'an odd name must not drop the download');
});

test('a key with no release prefix is ignored rather than throwing', () => {
  const env = fakeEnv();
  record(env, 'manjaro-xfce-26.1.1-unstable-260907-linux72.iso', 200, 'GET');
  assert.equal(env.points.length, 0);
});

test('an unbound dataset does not break serving', () => {
  const env = fakeEnv();
  delete env.ANALYTICS_ENGINE;
  assert.doesNotThrow(() => record(env, KEY, 200, 'GET'));
});

test('the month key is the month that closed, not the run month', () => {
  // the cron fires on the 2nd; it must archive the previous month
  const fired = new Date('2026-03-02T03:17:00Z');
  const previous = new Date(
    Date.UTC(fired.getUTCFullYear(), fired.getUTCMonth() - 1, 1),
  );
  assert.equal(MONTH_KEY(previous), '2026-02');
  // and across a year boundary
  const january = new Date('2026-01-02T03:17:00Z');
  assert.equal(
    MONTH_KEY(new Date(Date.UTC(january.getUTCFullYear(), january.getUTCMonth() - 1, 1))),
    '2025-12',
  );
});

test('the rollup aggregates to edition and branch and indexes the month', async () => {
  const env = fakeEnv();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { edition: 'xfce', branch: 'unstable', downloads: '12' },
        { edition: 'xfce', branch: 'stable', downloads: '30' },
        { edition: 'sway', branch: 'unstable', downloads: '7' },
      ],
    }),
  });
  const written = await rollup(env, '2026-02');
  assert.equal(written, 3);
  assert.deepEqual(JSON.parse(env.kv.get('month:2026-02')), {
    xfce: { unstable: 12, stable: 30 },
    sway: { unstable: 7 },
  });
  assert.deepEqual(JSON.parse(env.kv.get('months')), ['2026-02']);
});

test('re-running the rollup does not duplicate the month index', async () => {
  const env = fakeEnv();
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ edition: 'xfce', branch: 'stable', downloads: '1' }] }),
  });
  await rollup(env, '2026-02');
  await rollup(env, '2026-02');
  assert.deepEqual(JSON.parse(env.kv.get('months')), ['2026-02']);
});

test('an empty month writes nothing rather than an empty archive', async () => {
  const env = fakeEnv();
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
  assert.equal(await rollup(env, '2026-02'), 0);
  assert.equal(env.kv.size, 0);
});

test('describe and resolveAlias still behave', () => {
  assert.deepEqual(describe('manjaro-xfce-26.1.1-unstable-260907-linux72.iso'), {
    edition: 'xfce',
    branch: 'unstable',
    suffix: '.iso',
  });
  const objects = [
    { key: 'rc-1/manjaro-xfce-26.1.0-unstable-260901-linux72.iso' },
    { key: 'rc-2/manjaro-xfce-26.1.1-unstable-260907-linux72.iso' },
  ];
  assert.equal(
    resolveAlias(objects, 'xfce', 'unstable', '.iso').key,
    'rc-2/manjaro-xfce-26.1.1-unstable-260907-linux72.iso',
  );
});
