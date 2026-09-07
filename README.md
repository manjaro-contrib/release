# Manjaro Release Review

[![iso_build](https://github.com/manjaro-contrib/release/actions/workflows/iso_build.yaml/badge.svg)](https://github.com/manjaro-contrib/release/actions)

Building preview ISOs for Manjaro Linux.

## Description

We build `kde`, `xfce`, `gnome`, `cinnamon` and `sway` against all three
Manjaro branches, so 15 images per run.

`i3` is one of the editions manjaro.org offers but is not built here: its
profile requests `lib32-flex`, which the build mirror's multilib does not
carry, so every i3 build fails while installing the desktop. Images built
before that broke are still served.

Stable images ship the ![longterm](https://img.shields.io/badge/dynamic/json?label=longterm&query=%24%5B%3A1%5D.packageName&url=https%3A%2F%2Fkernel-info.manjaro-sway.download%2F%3Fcategory%3Dlongterm) kernel; testing and unstable ship the ![stable](https://img.shields.io/badge/dynamic/json?label=stable&query=%24%5B%3A1%5D.packageName&url=https%3A%2F%2Fkernel-info.manjaro-sway.download%2F%3Fcategory%3Dstable) one.

Each combination builds independently, so one failing withholds none of
the others, and at most six run at a time so a single run does not occupy
every available runner. Every build uploads its own image as soon as it
finishes, so a completed edition is downloadable while the others are
still compiling - the image goes to the bucket before it is split for the
release, so it crosses the network once, as itself.

Each build uploads its image straight to the `releases` R2 bucket, and is
also attached to a GitHub release for review. The two carry different
things: a release asset is capped at 2 GB and every image is around 5 GB,
so the release only ever holds a split zip, while the bucket holds the
`.iso` itself, which a worker in `worker/` serves: it lists the
bucket per release tag and streams the ISOs with range requests, so
download managers can resume. `/releases.json` is the machine-readable
equivalent of that listing.

## Download stats

`/stats` counts ISO downloads, publicly, and drills down from edition to
branch to release to kernel. `/stats.json` is the same data.

Only a whole-image `GET` that returns `200` counts. A resumed download
issues many range requests and a revalidation transfers nothing, so
counting either would report one download as several. Signatures and
checksums are not counted.

Two stores, because neither alone is enough:

| | holds | for |
| --- | --- | --- |
| analytics engine | release, edition, branch, version, kernel | three months |
| kv | month, edition, branch | indefinitely |

Analytics engine writes are non-blocking, so counting costs a download
nothing, but it retains three months. A cron on the 2nd of each month
aggregates the month that closed into a single kv key, which is why the
drill-down is detailed recently and a trend further back.

Nothing writes kv from a request. Kv allows one write per second per key
and propagates for up to 60s, so a counter incremented per download would
lose counts to last-write-wins.

Counting needs no credentials: `writeDataPoint` goes through the
binding. Reading does, because analytics engine has no query binding -
the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api)
takes a bearer token with `Account | Account Analytics | Read`, supplied
as `ANALYTICS_TOKEN`. So downloads are recorded whether or not it is
set, and the token can be added later without losing anything.

## Where can I download an iso?

<https://manjaro.download> lists every release, newest first. Each build is
also attached to a [GitHub release](../../releases) for review.

### Stable download links

Every edition and branch has a permanent URL that redirects to the newest
build, so it can be linked once instead of being updated per release:

    https://manjaro.download/<edition>-<branch>.iso

The signature, checksums and package list have the same permanent URLs, so
a script can fetch an image and verify it without first resolving which
release is current - a checksum that named a superseded build would be
worse than none.

For the edition this repository builds nightly:

| URL | |
| --- | --- |
| <https://manjaro.download/sway-unstable.iso> | the image |
| <https://manjaro.download/sway-unstable.iso.sig> | its signature |
| <https://manjaro.download/sway-unstable.iso.sha256> | its checksum |
| <https://manjaro.download/sway-unstable.iso.pkgs> | the package list |

The same holds for `kde`, `xfce`, `gnome` and `cinnamon`.

`<branch>` is one of `unstable`, `testing` or `stable`, and `<edition>` one
of `sway`, `kde`, `kde-dev`, `gnome`, `gnome-next`, `xfce`, `cinnamon` or
`i3` — though only combinations that have actually been built resolve;
anything else answers `404`. `i3` is no longer built, so only the images
from before it broke resolve.

Any suffix the build produces works, and every one of these is a redirect,
so `curl` needs `-L`:

```sh
# -O names the file after the url, so the version is lost; -J takes the
# name from the redirect target instead
curl -LOJ https://manjaro.download/sway-unstable.iso
curl -LOJ https://manjaro.download/sway-unstable.iso.sha256
sha256sum -c manjaro-sway-*.iso.sha256
```

The redirects are deliberately uncached, so they follow each nightly build
rather than pinning to the one that was current when a link was first
resolved. `<https://manjaro.download/releases.json>` is the same
information as JSON, keyed by release tag.

### Retention

The newest ten releases are kept; older ones are deleted from both GitHub
and the bucket, so the two cannot disagree about what exists.

Pruning only runs once every edition has uploaded completely. Until then
the older images are the only ones anyone can download, so a failed or
partial upload leaves them untouched: each object is checked for the right
size after upload, and a truncated one is removed rather than left to
satisfy that check later. A single failed edition holds back pruning for
the whole run, because that edition's newest working image is the one in
an older release. The stable links keep resolving to a complete image
throughout.

### Polling for changes

`/state` and `/<release-tag>/state` carry a hash of the contents in the
same BoxIt format the [package repository](https://packages.manjaro.download/state)
and Manjaro's own mirrors serve, so tooling can poll a hash instead of
walking the bucket. The hashes are derived from the objects themselves, so
re-uploading identical bytes leaves them unchanged.

## Sources

- [iso profiles](https://gitlab.manjaro.org/profiles-and-settings/iso-profiles)

## credentials

```sh
user: manjaro
password: manjaro
```