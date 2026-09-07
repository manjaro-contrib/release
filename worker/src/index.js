/**
 * Serves the release ISOs from R2, with a listing per release.
 *
 * The Jekyll site it replaces rendered a release.json that the publish job
 * had to keep in sync, so the page could disagree with the bucket. Listing
 * R2 directly removes that: the page cannot show an ISO that is not there,
 * or miss one that is.
 */

import { FAVICON } from './favicon.js';

const TITLE = 'Manjaro Sway release candidates';

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function humanSize(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}


const EDITIONS = ['kde-dev', 'gnome-next', 'kde', 'gnome', 'xfce', 'cinnamon', 'i3', 'sway'];
const BRANCHES = ['unstable', 'testing', 'stable'];

/**
 * The edition and branch an ISO filename describes.
 *
 * buildiso names stable images without a branch component, so its absence
 * is what identifies stable rather than a missing value.
 */
export function describe(filename) {
  const body = filename.replace(/^manjaro-/, '');
  // longest edition first, so kde-dev is not read as kde
  const edition = EDITIONS.find((e) => body.startsWith(`${e}-`));
  if (!edition) return null;
  // buildiso names images manjaro-<edition>-<version>[-<branch>]-<date>, so
  // the branch follows the version rather than the edition; look at the
  // hyphen-separated fields instead of the start of the remainder
  const fields = body.slice(edition.length + 1).split('-');
  const branch = BRANCHES.find((b) => fields.includes(b)) ?? 'stable';
  const suffix = filename.slice(filename.indexOf('.iso'));
  return { edition, branch, suffix };
}

/** The newest object matching an edition, branch and suffix. */
export function resolveAlias(objects, edition, branch, suffix) {
  const matches = objects.filter((o) => {
    const name = o.key.slice(o.key.indexOf('/') + 1);
    const d = describe(name);
    return d && d.edition === edition && d.branch === branch && d.suffix === suffix;
  });
  // release tags sort chronologically, so the last key is the newest build
  return matches.sort((a, b) => a.key.localeCompare(b.key)).pop();
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
       max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.1rem; font-weight: 600; }
h2 { font-size: .95rem; font-weight: 600; margin: 1.6rem 0 .3rem; opacity: .75; }
.row { display: flex; justify-content: space-between; gap: 1rem;
       padding: .15rem 0; text-decoration: none; }
.row:hover { text-decoration: underline; }
i { opacity: .6; font-style: normal; }
p { opacity: .7; }
footer { margin-top: 2rem; opacity: .7; }
.bar { display: inline-block; height: .55em; margin-left: .6rem;
       background: currentColor; opacity: .25; border-radius: 1px;
       vertical-align: middle; max-width: 22rem; }
nav { opacity: .7; margin-bottom: .4rem; }
`;

function page(heading, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(heading)} — ${TITLE}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
${bodyHtml}
<footer><a href="/stats">download stats</a> &middot; packages are at <a href="https://packages.manjaro.download">packages.manjaro.download</a> &middot; built by <a href="https://github.com/manjaro-contrib/release">manjaro-contrib/release</a></footer>
</body>
</html>
`;
}

/** Group keys by their release prefix, newest release first. */
function byRelease(objects) {
  const releases = new Map();
  for (const obj of objects) {
    if (obj.key === 'state' || obj.key.endsWith('/state')) continue;
    const slash = obj.key.indexOf('/');
    if (slash < 0) continue;
    const release = obj.key.slice(0, slash);
    if (!releases.has(release)) releases.set(release, []);
    releases.get(release).push(obj);
  }
  // release tags are rc-<YYYYMMDDHHmm>, so lexical order is chronological
  return [...releases.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const listed = await bucket.list({ prefix, cursor, include: [] });
    objects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objects;
}

// the image first, then what verifies it, then what describes it - the
// order someone downloading actually needs them in
const SUFFIX_ORDER = [
  '.iso',
  '.iso.sig',
  '.iso.sha1',
  '.iso.sha256',
  '.iso.sha512',
  '.iso.pkgs',
];

// the split zip exists only to fit github's 2 GB asset cap; this bucket
// holds the image whole, so a part here is a leftover from when releases
// were mirrored back rather than uploaded directly. Aliasing one would
// point "latest" at whichever superseded build still has parts.
const SPLIT = /\.(zip|z\d+)$/;

/** Stable aliases for whatever the newest build of each edition is. */
function renderAliases(objects) {
  // every suffix published for an edition gets an alias, not just the
  // image: a checksum or signature is useless if it names a build that
  // has since been superseded
  const seen = new Map();
  for (const o of objects) {
    const d = describe(o.key.slice(o.key.indexOf('/') + 1));
    if (!d || SPLIT.test(d.suffix)) continue;
    const name = `${d.edition}-${d.branch}`;
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name).add(d.suffix);
  }
  if (!seen.size) return '';
  const rows = [...seen.keys()]
    .sort()
    .map((name) => {
      const suffixes = [...seen.get(name)].sort(
        // unknown suffixes keep working, they just sort last
        (a, b) =>
          (SUFFIX_ORDER.indexOf(a) + 1 || Infinity) -
            (SUFFIX_ORDER.indexOf(b) + 1 || Infinity) || a.localeCompare(b),
      );
      const links = suffixes
        .map((s) => `<a href="/${name}${s}">${s.replace('.iso', '') || 'image'}</a>`)
        .join(' ');
      return `<span class="row"><span>${name}.iso</span><span>${links}</span></span>`;
    })
    .join('\n');
  return `<h2>latest</h2>\n<p>these always point at the newest build</p>\n${rows}`;
}

/** A bar whose width is relative to the largest count on the page. */
function bar(count, max) {
  const width = max > 0 ? Math.max(1, Math.round((count / max) * 100)) : 0;
  return `<span class="bar" style="width:${width}%"></span>`;
}

function renderStats({ heading, rows, crumbs, note, extra = '' }) {
  if (!rows.length) {
    return page(
      heading,
      `${crumbs}<p>${escapeHtml(note ?? 'nothing recorded yet')}</p>${extra}`,
    );
  }
  const max = Math.max(...rows.map((r) => r.count));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const body = rows
    .map((r) => {
      const label = escapeHtml(r.label);
      const cell = r.href
        ? `<a href="${escapeHtml(r.href)}">${label}</a>`
        : label;
      return `<span class="row"><span>${cell}${bar(r.count, max)}</span><i>${r.count.toLocaleString('en-US')}</i></span>`;
    })
    .join('\n');
  return page(
    heading,
    `${crumbs}<p>${total.toLocaleString('en-US')} downloads${note ? ` &middot; ${escapeHtml(note)}` : ''}</p>\n${body}${extra}`,
  );
}

/** Links to the months archived past analytics engine's three. */
async function renderArchive(env, current) {
  const months = JSON.parse((await env.STATS.get('months')) ?? '[]');
  if (!months.length) return '';
  const links = months
    .slice()
    .sort()
    .reverse()
    .map((m) =>
      m === current
        ? `<b>${escapeHtml(m)}</b>`
        : `<a href="/stats?month=${encodeURIComponent(m)}">${escapeHtml(m)}</a>`,
    )
    .join(' &middot; ');
  return `<h2>archive</h2>\n<p>months past the three analytics engine keeps</p>\n<p>${links}</p>`;
}

function renderIndex(releases) {
  if (!releases.length) return page('releases', '<p>no releases published yet</p>');
  const all = releases.flatMap(([, objects]) => objects);
  const sections = releases.map(([release, objects]) => {
    const rows = objects
      .filter((o) => !o.key.endsWith('/'))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(
        (o) =>
          `<a class="row" href="/${escapeHtml(o.key)}">${escapeHtml(
            o.key.slice(release.length + 1),
          )}<i>${humanSize(o.size)}</i></a>`,
      )
      .join('\n');
    return `<h2>${escapeHtml(release)}</h2>\n${rows}`;
  });
  return page('releases', renderAliases(all) + '\n' + sections.join('\n'));
}

// ---------------------------------------------------------------- stats

/**
 * Record one download.
 *
 * Only a whole-image GET counts: a resumed ISO issues many range requests,
 * so counting 206 would report one download as dozens.
 */
export function record(env, key, status, method) {
  if (!env.ANALYTICS_ENGINE) return;
  if (method !== 'GET' || status !== 200) return;
  const slash = key.indexOf('/');
  if (slash < 0) return;
  const release = key.slice(0, slash);
  const name = key.slice(slash + 1);
  const d = describe(name);
  if (!d || d.suffix !== '.iso') return;
  // version and kernel are not in describe()'s contract, and a name that
  // does not carry them still counts - the fields are just empty
  const fields = name
    .replace(/^manjaro-/, '')
    .slice(d.edition.length + 1, name.replace(/^manjaro-/, '').indexOf('.iso'))
    .split('-');
  const version = fields[0] ?? '';
  const kernel = fields.find((f) => f.startsWith('linux')) ?? '';
  env.ANALYTICS_ENGINE.writeDataPoint({
    // one index only, 96 bytes: edition is the axis worth keeping
    // unsampled, and it is short
    indexes: [d.edition],
    blobs: [release, d.edition, d.branch, version, kernel],
    doubles: [1],
  });
}

class NotConfigured extends Error {}

const SQL_API = (account) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;

/** Run one query against the analytics engine sql api. */
async function query(env, sql) {
  // the page is public, so an unset token must read as "not configured"
  // rather than a 500 that looks like the stats are broken
  if (!env.ANALYTICS_TOKEN) throw new NotConfigured();
  const res = await fetch(SQL_API(env.ACCOUNT_ID), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ANALYTICS_TOKEN}`,
      'content-type': 'text/plain',
    },
    body: sql,
  });
  if (!res.ok) throw new Error(`analytics query failed: ${res.status}`);
  const body = await res.json();
  return body.data ?? [];
}

export const MONTH_KEY = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** The month after this one, as YYYY-MM, so a range can be half-open. */
export function nextMonth(month) {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(year, m, 1));
  return MONTH_KEY(d);
}

/**
 * Archive a closed month as one kv key.
 *
 * Aggregated to edition and branch: per-release detail expires with the
 * release, and would grow the value without bound.
 */
export async function rollup(env, month) {
  const rows = await query(
    env,
    `SELECT blob2 AS edition, blob3 AS branch, SUM(_sample_interval) AS downloads
     FROM "release-downloads"
     WHERE timestamp >= toDateTime('${month}-01 00:00:00')
       AND timestamp < toDateTime('${nextMonth(month)}-01 00:00:00')
     GROUP BY edition, branch`,
  );
  if (!rows.length) return 0;
  const totals = {};
  for (const r of rows) {
    totals[r.edition] ??= {};
    totals[r.edition][r.branch] = Number(r.downloads);
  }
  await env.STATS.put(`month:${month}`, JSON.stringify(totals));
  // an index, so the page never has to list keys to know what exists
  const known = JSON.parse((await env.STATS.get('months')) ?? '[]');
  if (!known.includes(month)) {
    known.push(month);
    known.sort();
    await env.STATS.put('months', JSON.stringify(known));
  }
  return rows.length;
}

/** Build the stats view: one grouped query over the first unpinned axis. */
async function statsView(env, params) {
  const release = params.get('release');
  const edition = params.get('edition');
  const branch = params.get('branch');
  const month = params.get('month');

  // an archived month has no release axis left, so it is answered from kv
  if (month) {
    const stored = await env.STATS.get(`month:${month}`);
    if (!stored) {
      return renderStats({
        heading: `stats ${month}`,
        rows: [],
        crumbs: crumbsFor({}),
        note: `nothing archived for ${month}`,
        extra: await renderArchive(env, month),
      });
    }
    const totals = JSON.parse(stored);
    const rows = Object.entries(totals)
      .flatMap(([e, branches]) => Object.entries(branches).map(([b, count]) => ({ label: `${e} ${b}`, count })))
      .sort((a, b) => b.count - a.count);
    return renderStats({
      heading: `stats ${month}`,
      rows,
      crumbs: crumbsFor({ month }),
      note: 'archived month, aggregated to edition and branch',
      extra: await renderArchive(env, month),
    });
  }

  const where = [];
  if (release) where.push(`blob1 = '${sqlSafe(release)}'`);
  if (edition) where.push(`blob2 = '${sqlSafe(edition)}'`);
  if (branch) where.push(`blob3 = '${sqlSafe(branch)}'`);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // group by the first axis not already pinned, so each click narrows
  const axis = !edition ? { col: 'blob2', name: 'edition', param: 'edition' }
    : !branch ? { col: 'blob3', name: 'branch', param: 'branch' }
    : !release ? { col: 'blob1', name: 'release', param: 'release' }
    : { col: 'blob5', name: 'kernel', param: null };

  const rows = await query(
    env,
    `SELECT ${axis.col} AS label, SUM(_sample_interval) AS downloads
     FROM "release-downloads" ${filter}
     GROUP BY label ORDER BY downloads DESC LIMIT 100`,
  );

  const carry = new URLSearchParams();
  for (const [k, v] of params) if (v) carry.set(k, v);
  return renderStats({
    heading: 'downloads',
    rows: rows.map((r) => {
      const next = new URLSearchParams(carry);
      if (axis.param) next.set(axis.param, r.label);
      return {
        label: r.label || `(no ${axis.name})`,
        count: Number(r.downloads),
        href: axis.param && r.label ? `/stats?${next}` : null,
      };
    }),
    crumbs: crumbsFor({ release, edition, branch }),
    note: `by ${axis.name}, last three months`,
    extra: release || edition || branch ? '' : await renderArchive(env, null),
  });
}

/** Literal quoting: these values reach a sql string. */
function sqlSafe(value) {
  return value.replace(/'/g, "''").slice(0, 96);
}

function crumbsFor(active) {
  const parts = Object.entries(active).filter(([, v]) => v);
  const links = ['<a href="/stats">all</a>'];
  const carry = new URLSearchParams();
  for (const [k, v] of parts) {
    carry.set(k, v);
    links.push(`<a href="/stats?${carry}">${escapeHtml(v)}</a>`);
  }
  return `<nav>${links.join(' / ')}</nav>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    if (key === 'favicon.svg' || key === 'favicon.ico') {
      // .ico callers accept an svg body, so one file serves both
      return new Response(FAVICON, {
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    // machine-readable equivalent of the listing, replacing release.json
    if (key === 'releases.json') {
      const releases = byRelease(await listAll(env.BUCKET, ''));
      const body = Object.fromEntries(
        releases.map(([release, objects]) => [
          release,
          objects.map((o) => ({
            name: o.key.slice(release.length + 1),
            size: o.size,
            url: `${url.origin}/${o.key}`,
          })),
        ]),
      );
      return new Response(JSON.stringify(body, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    if (key === 'stats') {
      let body;
      try {
        body = await statsView(env, url.searchParams);
      } catch (e) {
        if (!(e instanceof NotConfigured)) throw e;
        body = page('downloads', '<p>stats are not configured yet</p>');
      }
      return new Response(body, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (key === 'stats.json') {
      const months = JSON.parse((await env.STATS.get('months')) ?? '[]');
      const archive = {};
      for (const m of months) {
        const stored = await env.STATS.get(`month:${m}`);
        if (stored) archive[m] = JSON.parse(stored);
      }
      let recent = [];
      try {
        recent = await query(
          env,
          `SELECT blob1 AS release, blob2 AS edition, blob3 AS branch,
                  blob4 AS version, blob5 AS kernel,
                  SUM(_sample_interval) AS downloads
           FROM "release-downloads"
           GROUP BY release, edition, branch, version, kernel
           ORDER BY downloads DESC LIMIT 1000`,
        );
      } catch (e) {
        // the archive does not need the token, so publish it regardless
        if (!(e instanceof NotConfigured)) throw e;
      }
      return new Response(
        JSON.stringify({ months: archive, recent }, null, 2),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    // stable aliases: /sway-unstable.iso redirects to the newest build, so a
    // link can be published once instead of per release
    const alias = key.match(
      /^([a-z0-9-]+?)-(unstable|testing|stable)(\.iso(?:\.\w+)?)$/,
    );
    if (alias) {
      const [, edition, branch, suffix] = alias;
      const target = resolveAlias(await listAll(env.BUCKET, ''), edition, branch, suffix);
      if (!target) return new Response('not found', { status: 404 });
      const filename = target.key.slice(target.key.indexOf('/') + 1);
      return new Response(null, {
        status: 302,
        headers: {
          location: `/${target.key}`,
          // so curl -OJ and browsers save the versioned name rather than
          // the alias, which would lose the version
          'content-disposition': `attachment; filename="${filename}"`,
          // the target moves with every release, so never cache the hop
          'cache-control': 'no-store',
        },
      });
    }

    if (key === '' || key.endsWith('/')) {
      const objects = await listAll(env.BUCKET, key);
      if (!objects.length) return new Response('not found', { status: 404 });
      return new Response(renderIndex(byRelease(objects)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    const object = await env.BUCKET.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (!object) return new Response('not found', { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    // an ISO never changes once published, and download managers resume
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('accept-ranges', 'bytes');

    const status = object.body ? (request.headers.get('range') ? 206 : 200) : 304;
    record(env, key, status, request.method);
    return new Response(request.method === 'HEAD' ? null : object.body, {
      status,
      headers,
    });
  },

  async scheduled(event, env, ctx) {
    // the month that just closed, derived from the trigger's own time so a
    // late or re-run invocation archives the same month rather than drifting
    const now = new Date(event.scheduledTime);
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    ctx.waitUntil(rollup(env, MONTH_KEY(previous)));
  },
};
