/**
 * Serves the release ISOs from R2, with a listing per release.
 *
 * The Jekyll site it replaces rendered a release.json that the publish job
 * had to keep in sync, so the page could disagree with the bucket. Listing
 * R2 directly removes that: the page cannot show an ISO that is not there,
 * or miss one that is.
 */

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
`;

function page(heading, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} — ${TITLE}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
${bodyHtml}
<footer>packages are at <a href="https://packages.manjaro.download">packages.manjaro.download</a> &middot; built by <a href="https://github.com/manjaro-contrib/release">manjaro-contrib/release</a></footer>
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
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
    return new Response(request.method === 'HEAD' ? null : object.body, {
      status,
      headers,
    });
  },
};
