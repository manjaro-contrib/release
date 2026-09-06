#!/usr/bin/env python3
"""Copy a release's ISO assets into the release bucket.

The build publishes its output as GitHub release assets, which are fine for
review but a poor download surface: no custom domain, and rate limits that
bite for multi-gigabyte files. This mirrors them to R2 under the release
tag, so the bucket is the thing users download from.

Assets are streamed asset-by-asset rather than collected first: an ISO set
does not fit comfortably in a runner's disk otherwise.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.exceptions import ClientError
from release_state import write_state

# ISOs are large; a bigger part size keeps the multipart count sane
TRANSFER = TransferConfig(multipart_chunksize=64 * 1024 * 1024)


EDITIONS = [
    "kde-dev",
    "gnome-next",
    "kde",
    "gnome",
    "xfce",
    "cinnamon",
    "i3",
    "sway",
]
BRANCHES = ["unstable", "testing", "stable"]


def describe(filename: str) -> tuple[str, str] | None:
    """The edition and branch an ISO filename names, if it is one.

    buildiso names images manjaro-<edition>-<version>[-<branch>]-<date>,
    so the branch follows the version rather than the edition, and stable
    images carry no branch token at all - its absence is what identifies
    stable. Editions are matched longest-first, or kde-dev would be read
    as edition kde.
    """
    body = filename.removeprefix("manjaro-")
    edition = next((e for e in EDITIONS if body.startswith(f"{e}-")), None)
    if edition is None:
        return None
    # the branch sits between the version and the date, so look at the
    # hyphen-separated fields rather than the start of the remainder
    fields = body[len(edition) + 1 :].split("-")
    branch = next((b for b in BRANCHES if b in fields), "stable")
    return edition, branch


def matches(filename: str, edition: str | None, branch: str | None) -> bool:
    if edition is None and branch is None:
        return True
    described = describe(filename)
    if described is None:
        return False
    return (edition is None or described[0] == edition) and (
        branch is None or described[1] == branch
    )


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def release_assets(release: str) -> list[dict]:
    out = subprocess.run(
        ["gh", "release", "view", release, "--json", "assets"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(out)["assets"]


def already_there(s3, bucket: str, key: str, size: int) -> bool:
    """A same-sized object means this asset was already mirrored."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)["ContentLength"] == size
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey"):
            return False
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, help="release tag to mirror")
    parser.add_argument(
        "--prefix", default="", help="key prefix inside the bucket"
    )
    parser.add_argument(
        "--edition",
        help="mirror only this edition's assets, so each build can upload"
        " its own images without waiting for the rest",
    )
    parser.add_argument(
        "--branch",
        help="mirror only this branch's assets; stable images carry no"
        " branch in their filename, which is how stable is recognised",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    bucket = os.environ["R2_BUCKET"]
    s3 = s3_client()

    assets = [
        a
        for a in release_assets(args.release)
        # buildiso splits each image into .zip/.z01/... to stay under
        # github's asset size cap, so those *are* the build output; only
        # the source archives github attaches itself are not
        if describe(a["name"]) is not None
        and matches(a["name"], args.edition, args.branch)
    ]
    if not assets:
        which = " ".join(filter(None, (args.branch, args.edition)))
        log(f"{args.release} has no ISO assets" + (f" for {which}" if which else ""))
        return 1

    failed = []
    for asset in assets:
        key = f"{args.prefix}{args.release}/{asset['name']}"
        if already_there(s3, bucket, key, asset["size"]):
            log(f"{asset['name']}: already published")
            continue
        log(f"{asset['name']}: {asset['size'] / 1e9:.2f} GB -> {key}")
        if args.dry_run:
            continue
        try:
            # stream straight through: the runner disk cannot hold the set
            with urllib.request.urlopen(asset["url"]) as body:
                s3.upload_fileobj(body, bucket, key, Config=TRANSFER)
        except (OSError, ClientError) as e:
            # a half-written object would satisfy a later size check, so
            # remove it rather than leave a truncated iso in place
            log(f"{asset['name']}: upload failed: {e}")
            s3.delete_object(Bucket=bucket, Key=key)
            failed.append(asset["name"])
            continue
        if not already_there(s3, bucket, key, asset["size"]):
            log(f"{asset['name']}: uploaded size does not match, removing")
            s3.delete_object(Bucket=bucket, Key=key)
            failed.append(asset["name"])
            continue
        log(f"{asset['name']}: published")

    if args.dry_run:
        log(f"{args.release}: {len(assets)} asset(s) would be published")
        return 0

    write_state(s3, bucket, log)

    if failed:
        # exit non-zero so the pruning step does not run: the old images
        # are the only working ones until this release uploads cleanly
        log(f"{args.release}: {len(failed)} of {len(assets)} asset(s) failed")
        return 1

    log(f"{args.release}: {len(assets)} asset(s) in {bucket}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
