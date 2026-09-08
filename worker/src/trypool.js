/**
 * Admission control for "try Manjaro in the browser" (#24).
 *
 * The cost of this feature is bounded by refusing work, not by scaling to
 * meet it: a fixed number of desktops per region, and a visitor who arrives
 * when they are all taken is told their place in line rather than given a
 * new machine. tryomarchy.dev runs the same shape - a pool of 300 and a
 * launcher that retries on 503 - which is why a front page day lengthens
 * the queue instead of multiplying the bill.
 *
 * Everything here is accounting. Starting the container is a separate
 * concern and deliberately not done in this file: a slot is a reservation,
 * and what fills it is the caller's business.
 */

/**
 * Desktops per region. The total is the only number that bounds spend, so
 * it is written here rather than derived: 20 slots x 15 minutes, at the
 * ~$0.03 per session measured in #24, is a worst case of roughly $1,750 a
 * month if every slot stays saturated for a month - and realistic use sits
 * far below that, as tryomarchy's own 5-of-300 utilisation shows.
 */
export const POOLS = {
  WEUR: 8,
  EEUR: 2,
  ENAM: 6,
  WNAM: 2,
  APSE: 1,
  OC: 1,
};

export const TOTAL_POOL = Object.values(POOLS).reduce((a, b) => a + b, 0);

/** How long a session lives before it is reclaimed, and how far extend() moves it. */
export const SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * A waiter is remembered only long enough to give the next probe a stable
 * position. The client retries every ~3s, so anything older than this has
 * gone away rather than moved up the queue.
 */
export const WAITER_TTL_MS = 12 * 1000;

/**
 * Cloudflare reports a continent, not one of our region names. The mapping
 * is coarse on purpose: a visitor routed to the wrong pool waits for the
 * wrong queue, which is a worse experience than a slightly slower stream,
 * so wide buckets beat precise ones with nothing in them.
 */
export function regionFor(cf) {
  const continent = cf?.continent;
  const longitude = Number(cf?.longitude);
  switch (continent) {
    case 'EU':
      // the split is by longitude, not country: EEUR exists to keep a
      // small eastern pool from being consumed by western traffic
      return Number.isFinite(longitude) && longitude > 20 ? 'EEUR' : 'WEUR';
    case 'NA':
      return Number.isFinite(longitude) && longitude < -100 ? 'WNAM' : 'ENAM';
    case 'AS':
      return 'APSE';
    case 'OC':
      return 'OC';
    // Africa and South America have no pool of their own; they get the
    // nearest one that does rather than being refused outright
    case 'AF':
      return 'WEUR';
    case 'SA':
      return 'ENAM';
    default:
      return 'WEUR';
  }
}

const uuid = () => crypto.randomUUID();

/**
 * One Durable Object holds the whole pool.
 *
 * Not one per region: the status endpoint reports every region at once, and
 * a single object answers that from memory instead of fanning out. The
 * write rate this has to survive is a handful per second, far below what
 * one object handles.
 */
export class TryPool {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
    // Every handler is a read-modify-write of the same two records, so they
    // run one at a time. A durable object's input gating already stops two
    // requests interleaving around an await, but the accounting is the only
    // thing keeping spend bounded, so it does not rest on that: without
    // this, eight concurrent claims against a pool of eight served
    // fourteen, each having read the census before any had written.
    this.chain = Promise.resolve();
  }

  /** Run fn with no other handler between its read and its write. */
  #serialize(fn) {
    const result = this.chain.then(fn, fn);
    // a rejection must not poison the chain for every later request
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Sessions and waiters that are still live, with the expired dropped. */
  async #live(now) {
    const sessions = (await this.storage.get('sessions')) ?? {};
    const waiters = (await this.storage.get('waiters')) ?? {};
    let changed = false;
    for (const [id, s] of Object.entries(sessions)) {
      if (s.expiresAt <= now) {
        delete sessions[id];
        changed = true;
      }
    }
    for (const [id, w] of Object.entries(waiters)) {
      if (w.seenAt + WAITER_TTL_MS <= now) {
        delete waiters[id];
        changed = true;
      }
    }
    if (changed) await this.#save(sessions, waiters);
    return { sessions, waiters };
  }

  async #save(sessions, waiters) {
    await this.storage.put({ sessions, waiters });
    // the alarm exists to reclaim a session whose tab closed without
    // telling us; without it a crashed client would hold a slot forever
    const next = Math.min(
      ...Object.values(sessions).map((s) => s.expiresAt),
      ...Object.values(waiters).map((w) => w.seenAt + WAITER_TTL_MS),
      Infinity,
    );
    if (Number.isFinite(next)) await this.storage.setAlarm(next);
  }

  /** A strictly increasing arrival number, so the queue has a real order. */
  async #nextSeq() {
    const seq = ((await this.storage.get('seq')) ?? 0) + 1;
    await this.storage.put({ seq });
    return seq;
  }

  async alarm() {
    await this.#live(Date.now());
  }

  /** Used and capacity per region, plus the totals the status page shows. */
  #census(sessions, waiters) {
    const regions = {};
    for (const [name, pool] of Object.entries(POOLS)) {
      regions[name] = { used: 0, pool };
    }
    for (const s of Object.values(sessions)) {
      // a region that has been removed from POOLS still has its sessions
      // counted, or the totals would not add up while they drain
      regions[s.region] ??= { used: 0, pool: 0 };
      regions[s.region].used += 1;
    }
    return {
      used: Object.keys(sessions).length,
      pool: TOTAL_POOL,
      waiting: Object.keys(waiters).length,
      regions,
    };
  }

  fetch(request) {
    return this.#serialize(() => this.#handle(request));
  }

  async #handle(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const { sessions, waiters } = await this.#live(now);

    if (url.pathname === '/status') {
      return Response.json(this.#census(sessions, waiters));
    }

    if (url.pathname === '/claim') {
      const region = url.searchParams.get('region') ?? 'WEUR';
      const census = this.#census(sessions, waiters);
      const inRegion = census.regions[region] ?? { used: 0, pool: 0 };

      if (inRegion.used >= inRegion.pool) {
        // remembering the waiter is what makes the position stable across
        // retries; a ticket the client sends back keeps its place
        const ticket = url.searchParams.get('ticket') ?? uuid();
        const known = waiters[ticket];
        // Order is a counter, not a clock. Arrivals within the same
        // millisecond are common, and ordering those by their random
        // ticket made "who is first" a coin flip between two visitors who
        // both saw position 1.
        const seq = known?.seq ?? (await this.#nextSeq());
        waiters[ticket] = { region, seenAt: now, seq };
        await this.#save(sessions, waiters);
        const queue = Object.entries(waiters)
          .filter(([, w]) => w.region === region)
          .sort(([, a], [, b]) => a.seq - b.seq);
        const position = queue.findIndex(([k]) => k === ticket) + 1;
        return Response.json(
          { ticket, position, retryMs: 3000, ...this.#census(sessions, waiters) },
          { status: 503 },
        );
      }

      const id = uuid();
      sessions[id] = { region, expiresAt: now + SESSION_TTL_MS };
      // claiming consumes the ticket: holding a slot and a place in line
      // would let one visitor block the queue behind them
      const ticket = url.searchParams.get('ticket');
      if (ticket) delete waiters[ticket];
      await this.#save(sessions, waiters);
      return Response.json({
        id,
        region,
        expiresAt: sessions[id].expiresAt,
        ttlMs: SESSION_TTL_MS,
      });
    }

    if (url.pathname === '/extend') {
      const id = url.searchParams.get('id');
      const session = sessions[id];
      // an expired session is already gone from #live, so this is also the
      // answer for "my tab was asleep for an hour"
      if (!session) return new Response('no such session', { status: 404 });
      session.expiresAt = now + SESSION_TTL_MS;
      await this.#save(sessions, waiters);
      return Response.json({ id, expiresAt: session.expiresAt });
    }

    if (url.pathname === '/release') {
      const id = url.searchParams.get('id');
      if (!sessions[id]) return new Response('no such session', { status: 404 });
      delete sessions[id];
      await this.#save(sessions, waiters);
      // freeing a slot the moment a tab closes is what keeps a small pool
      // usable; the TTL is the fallback for clients that never say goodbye
      return Response.json({ released: id, ...this.#census(sessions, waiters) });
    }

    return new Response('not found', { status: 404 });
  }
}
