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
</body>
</html>
`;
}

/** Group keys by their release prefix, newest release first. */
function byRelease(objects) {
  const releases = new Map();
  for (const obj of objects) {
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

function renderIndex(releases) {
  if (!releases.length) return page('releases', '<p>no releases published yet</p>');
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
  return page('releases', sections.join('\n'));
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
