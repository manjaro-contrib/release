# Manjaro Release Review

[![iso_build](https://github.com/manjaro/release-review/workflows/iso_build/badge.svg)](https://github.com/manjaro/release-review/actions)

Building preview ISOs for Manjaro Linux.

## Description

We build unstable ISOs (against the manjaro unstable repository) with the ![stable](https://img.shields.io/badge/dynamic/json?label=stable&query=%24%5B%3A1%5D.packageName&url=https%3A%2F%2Fkernel-info.manjaro-sway.download%2F%3Fcategory%3Dstable) kernel, for the sway edition.

Each build is attached to a GitHub release for review, and mirrored to the
`releases` R2 bucket, which a worker in `worker/` serves: it lists the
bucket per release tag and streams the ISOs with range requests, so
download managers can resume. `/releases.json` is the machine-readable
equivalent of that listing.

Each edition and branch also has a stable link that redirects to the newest
build, so it can be published once rather than per release:

```
https://<host>/sway-unstable.iso
https://<host>/sway-unstable.iso.sha256
https://<host>/kde-stable.iso
```

Any suffix the build produces works the same way - `.sig`, `.sha256`,
`.pkgs`. Stable images carry no branch in their filename, which is how
`stable` is recognised.

Other editions can still be built one-off through the `On Demand x86 Builds`
workflow.

## Where can I download an iso?

Images are built and uploaded in a relatively regular interval to [github releases](https://github.com/manjaro/release-review/releases)

### How to join the multipart zip?

To extract the regular images from multipart zip archive, download both the `z01` and the `zip` files, and run the command:

```sh
zip -FF manjaro-*.zip --out manjaro-full.zip && unzip manjaro-full.zip
```

## Sources

- [iso profiles](https://gitlab.manjaro.org/profiles-and-settings/iso-profiles)

## credentials

```sh
user: manjaro
password: manjaro
```