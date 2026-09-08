/**
 * The pool exists to refuse work, so what matters is what happens when it
 * is full: a queue with a stable position, and slots that come back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TryPool, POOLS, TOTAL_POOL, SESSION_TTL_MS, regionFor } from '../src/trypool.js';

/** A storage stub with the put({...}) and get() shapes the class uses. */
function storage() {
  const map = new Map();
  return {
    map,
    alarm: null,
    async get(k) {
      return map.get(k);
    },
    async put(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async setAlarm(t) {
      this.alarm = t;
    },
  };
}

const pool = () => {
  const st = storage();
  return { obj: new TryPool({ storage: st }), st };
};

const call = (obj, path, params = {}) =>
  obj.fetch(
    new Request(
      `https://pool/${path}?${new URLSearchParams(params)}`,
      { method: 'POST' },
    ),
  );

test('a claim in a full region is queued, not served', async () => {
  const { obj } = pool();
  const region = 'OC'; // pool of 1, so one claim saturates it
  const first = await call(obj, 'claim', { region });
  assert.equal(first.status, 200);

  const second = await call(obj, 'claim', { region });
  assert.equal(second.status, 503);
  const body = await second.json();
  assert.equal(body.position, 1);
  assert.ok(body.retryMs > 0, 'the client is told when to come back');
  assert.ok(body.ticket, 'and given something to hold its place with');
});

test('a waiter keeps its position across retries', async () => {
  const { obj } = pool();
  await call(obj, 'claim', { region: 'OC' });

  const a = await (await call(obj, 'claim', { region: 'OC' })).json();
  const b = await (await call(obj, 'claim', { region: 'OC' })).json();
  assert.equal(a.position, 1);
  assert.equal(b.position, 2);

  // the first waiter comes back with its ticket and must not lose its place
  const again = await (
    await call(obj, 'claim', { region: 'OC', ticket: a.ticket })
  ).json();
  assert.equal(again.position, 1);
  assert.equal(again.ticket, a.ticket);
});

test('releasing a session frees the slot for the next visitor', async () => {
  const { obj } = pool();
  const held = await (await call(obj, 'claim', { region: 'OC' })).json();
  assert.equal((await call(obj, 'claim', { region: 'OC' })).status, 503);

  const freed = await call(obj, 'release', { id: held.id });
  assert.equal(freed.status, 200);
  assert.equal((await freed.json()).used, 0);

  assert.equal((await call(obj, 'claim', { region: 'OC' })).status, 200);
});

test('a session past its ttl stops holding a slot', async () => {
  const { obj } = pool();
  const held = await (await call(obj, 'claim', { region: 'OC' })).json();
  assert.equal((await call(obj, 'claim', { region: 'OC' })).status, 503);

  const real = Date.now;
  Date.now = () => real() + SESSION_TTL_MS + 1;
  try {
    // the abandoned tab's slot is reclaimed without anyone calling release
    assert.equal((await call(obj, 'claim', { region: 'OC' })).status, 200);
    assert.equal((await call(obj, 'extend', { id: held.id })).status, 404);
  } finally {
    Date.now = real;
  }
});

test('extend moves the deadline of a live session', async () => {
  const { obj } = pool();
  const held = await (await call(obj, 'claim', { region: 'OC' })).json();
  const real = Date.now;
  Date.now = () => real() + 60_000;
  try {
    const body = await (await call(obj, 'extend', { id: held.id })).json();
    assert.ok(
      body.expiresAt > held.expiresAt,
      'a visitor who is still watching keeps the machine',
    );
  } finally {
    Date.now = real;
  }
});

test('claiming consumes the ticket, so a slot and a place are not held at once', async () => {
  const { obj } = pool();
  const held = await (await call(obj, 'claim', { region: 'OC' })).json();
  const waiter = await (await call(obj, 'claim', { region: 'OC' })).json();
  await call(obj, 'release', { id: held.id });

  const served = await call(obj, 'claim', { region: 'OC', ticket: waiter.ticket });
  assert.equal(served.status, 200);
  const status = await (await obj.fetch(new Request('https://pool/status'))).json();
  assert.equal(status.waiting, 0, 'the queue empties as it is served');
});

test('one region filling up does not deny another', async () => {
  const { obj } = pool();
  await call(obj, 'claim', { region: 'OC' });
  assert.equal((await call(obj, 'claim', { region: 'OC' })).status, 503);
  assert.equal((await call(obj, 'claim', { region: 'WEUR' })).status, 200);
});

test('status accounts for every region and the pool total', async () => {
  const { obj } = pool();
  await call(obj, 'claim', { region: 'WEUR' });
  const body = await (await obj.fetch(new Request('https://pool/status'))).json();
  assert.equal(body.pool, TOTAL_POOL);
  assert.equal(body.used, 1);
  assert.deepEqual(Object.keys(body.regions).sort(), Object.keys(POOLS).sort());
  assert.equal(
    Object.values(body.regions).reduce((a, r) => a + r.pool, 0),
    TOTAL_POOL,
    'the advertised capacity is the sum of the regions',
  );
});

test('the pool cannot be oversubscribed by concurrent claims', async () => {
  const { obj } = pool();
  const region = 'WEUR';
  const results = await Promise.all(
    Array.from({ length: POOLS[region] + 6 }, () => call(obj, 'claim', { region })),
  );
  const served = results.filter((r) => r.status === 200).length;
  assert.equal(served, POOLS[region], 'exactly the pool size, no more');
});

test('the region comes from the continent, and everywhere gets one', async () => {
  assert.equal(regionFor({ continent: 'EU', longitude: '8.6' }), 'WEUR');
  assert.equal(regionFor({ continent: 'EU', longitude: '30.5' }), 'EEUR');
  assert.equal(regionFor({ continent: 'NA', longitude: '-74' }), 'ENAM');
  assert.equal(regionFor({ continent: 'NA', longitude: '-122' }), 'WNAM');
  // no pool of their own: served by the nearest that has one, not refused
  assert.equal(regionFor({ continent: 'AF' }), 'WEUR');
  assert.equal(regionFor({ continent: 'SA' }), 'ENAM');
  // cloudflare sends no cf object at all for some requests
  assert.equal(regionFor(undefined), 'WEUR');
  assert.equal(regionFor({ continent: 'EU' }), 'WEUR');
});
