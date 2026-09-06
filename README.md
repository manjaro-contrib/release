# Manjaro Release Review

[![iso_build](https://github.com/manjaro-contrib/release/actions/workflows/iso_build.yaml/badge.svg)](https://github.com/manjaro-contrib/release/actions)

Building preview ISOs for Manjaro Linux.

## Description

We build every edition manjaro.org offers for download - `kde`, `xfce`,
`gnome`, `cinnamon`, `i3` and `sway` - against all three Manjaro branches,
so 18 images per run.

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

## Where can I download an iso?

<https://manjaro.download> lists every release, newest first. Each build is
also attached to a [GitHub release](../../releases) for review.

### Stable download links

Every edition and branch has a permanent URL that redirects to the newest
build, so it can be linked once instead of being updated per release:

    https://manjaro.download/<edition>-<branch>.iso

For the edition this repository builds nightly:

| URL | |
| --- | --- |
| <https://manjaro.download/sway-unstable.iso> | the image |
| <https://manjaro.download/sway-unstable.iso.sig> | its signature |
| <https://manjaro.download/sway-unstable.iso.sha256> | its checksum |
| <https://manjaro.download/sway-unstable.iso.pkgs> | the package list |

The same holds for `kde`, `xfce`, `gnome`, `cinnamon` and `i3`.

`<branch>` is one of `unstable`, `testing` or `stable`, and `<edition>` one
of `sway`, `kde`, `kde-dev`, `gnome`, `gnome-next`, `xfce`, `cinnamon` or
`i3` — though only combinations that have actually been built resolve;
anything else answers `404`.

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