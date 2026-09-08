#!/usr/bin/env python3
"""Delete every object in the release bucket.

A one-shot for clearing pre-production experiments. prune_releases.py is the
tool for ordinary retention - it keeps GitHub releases and their bucket
prefixes in step, and refuses to retain fewer than one release. This does the
thing that one will not: leaves the bucket empty, download page and all.

Requires --yes, and prints what it is about to remove first, because there is
no undelete: the bucket has no versioning.
"""

import argparse
import os
import sys
from collections import Counter

from release_state import s3_client


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def all_keys(s3, bucket: str) -> list[str]:
    keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        keys += [o["Key"] for o in page.get("Contents", [])]
    return keys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="actually delete; without it this only lists",
    )
    args = parser.parse_args()

    bucket = os.environ["R2_BUCKET"]
    s3 = s3_client()

    keys = all_keys(s3, bucket)
    if not keys:
        log(f"{bucket}: already empty")
        return 0

    # one line per prefix rather than per object: a full release is ~100 keys
    prefixes = Counter(k.split("/")[0] if "/" in k else "(root)" for k in keys)
    log(f"{bucket}: {len(keys)} object(s) across {len(prefixes)} prefix(es)")
    for p, n in sorted(prefixes.items()):
        log(f"  {p}: {n}")

    if not args.yes:
        log("dry run: pass --yes to delete")
        return 0

    deleted = 0
    for batch in (keys[i : i + 1000] for i in range(0, len(keys), 1000)):
        resp = s3.delete_objects(
            Bucket=bucket, Delete={"Objects": [{"Key": k} for k in batch]}
        )
        deleted += len(resp.get("Deleted", []))
        for err in resp.get("Errors", []):
            log(f"  {err.get('Key')}: {err.get('Message')}")

    left = all_keys(s3, bucket)
    log(f"{bucket}: deleted {deleted}, {len(left)} remaining")
    # a bucket that is not empty afterwards means something raced the delete
    return 0 if not left else 1


if __name__ == "__main__":
    sys.exit(main())
