# Manjaro Release Review

[![iso_build](https://github.com/manjaro/release-review/workflows/iso_build/badge.svg)](https://github.com/manjaro/release-review/actions)

Building preview ISOs for Manjaro Linux.

## Description

We build unstable ISOs (against the manjaro unstable repository) with the ![stable](https://img.shields.io/badge/dynamic/json?label=stable&query=%24%5B%3A1%5D.packageName&url=https%3A%2F%2Fkernel-info.manjaro-sway.download%2F%3Fcategory%3Dstable) kernel, for the sway edition.

Each build is attached to a GitHub release for review, and mirrored to the
`releases` R2 bucket, which is the download surface.

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