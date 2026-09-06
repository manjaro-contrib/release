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

# ISOs are large; a bigger part size keeps the multipart count sane
TRANSFER = TransferConfig(multipart_chunksize=64 * 1024 * 1024)


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, help="release tag to mirror")
    parser.add_argument(
        "--prefix", default="", help="key prefix inside the bucket"
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    bucket = os.environ["R2_BUCKET"]
    s3 = s3_client()

    assets = [
        a
        for a in release_assets(args.release)
        # the tarballs github attaches to every release are not build output
        if not a["name"].endswith((".tar.gz", ".zip"))
    ]
    if not assets:
        log(f"{args.release} has no ISO assets")
        return 1

    for asset in assets:
        key = f"{args.prefix}{args.release}/{asset['name']}"
        if already_there(s3, bucket, key, asset["size"]):
            log(f"{asset['name']}: already published")
            continue
        log(f"{asset['name']}: {asset['size'] / 1e9:.2f} GB -> {key}")
        if args.dry_run:
            continue
        # stream straight through: the runner disk cannot hold the set
        with urllib.request.urlopen(asset["url"]) as body:
            s3.upload_fileobj(body, bucket, key, Config=TRANSFER)
        log(f"{asset['name']}: published")

    log(f"{args.release}: {len(assets)} asset(s) in {bucket}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
