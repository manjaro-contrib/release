#!/usr/bin/env python3
"""Keep the newest releases and delete the rest.

Every nightly build produces a release of several gigabytes, so without a
retention policy they accumulate indefinitely - this repository reached 746
releases and 29 TB before the first cleanup.

A release is deleted from GitHub *and* from the bucket, together, so the
two cannot disagree about what exists. The newest release is what the
stable download links resolve to, so the retained set always covers them.
"""

import argparse
import json
import os
import subprocess
import sys

from publish_iso import s3_client
from release_state import write_state


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def gh(args: list[str]) -> str:
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=True
    ).stdout


def releases(repo: str) -> list[dict]:
    """Every release, newest first by publish date."""
    out = gh(
        [
            "api",
            f"repos/{repo}/releases",
            "--paginate",
            "--jq",
            ".[] | {id, tag: .tag_name, published: .published_at}",
        ]
    )
    items = [json.loads(line) for line in out.splitlines() if line.strip()]
    # a draft has no publish date; treat it as newest so it is never pruned
    return sorted(items, key=lambda r: r["published"] or "9999", reverse=True)


def bucket_prefixes(s3, bucket: str) -> set[str]:
    """Release tags that have objects in the bucket."""
    found = set()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Delimiter="/"):
        for p in page.get("CommonPrefixes", []):
            found.add(p["Prefix"].rstrip("/"))
    return found


def delete_prefix(s3, bucket: str, prefix: str) -> int:
    keys = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=f"{prefix}/"):
        keys += [{"Key": o["Key"]} for o in page.get("Contents", [])]
    for batch in (keys[i : i + 1000] for i in range(0, len(keys), 1000)):
        s3.delete_objects(Bucket=bucket, Delete={"Objects": batch})
    return len(keys)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name of this repository")
    parser.add_argument(
        "--keep", type=int, default=10, help="number of releases to retain"
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.keep < 1:
        log("--keep must retain at least one release")
        return 1

    found = releases(args.repo)
    keep = found[: args.keep]
    prune = found[args.keep :]
    log(f"{len(found)} release(s): keeping {len(keep)}, pruning {len(prune)}")
    if keep:
        log(f"newest retained: {keep[0]['tag']}")

    bucket = os.environ["R2_BUCKET"]
    s3 = s3_client()
    # prefixes with no release at all are orphans from a deleted release
    orphans = bucket_prefixes(s3, bucket) - {r["tag"] for r in found}
    for tag in sorted(orphans):
        log(f"orphaned prefix in bucket: {tag}")

    for release in prune:
        log(f"prune {release['tag']}")
        if args.dry_run:
            continue
        gh(["api", "-X", "DELETE", f"repos/{args.repo}/releases/{release['id']}"])
        # the tag outlives the release unless it goes too
        subprocess.run(
            ["gh", "api", "-X", "DELETE",
             f"repos/{args.repo}/git/refs/tags/{release['tag']}"],
            capture_output=True,
            text=True,
            check=False,
        )
        removed = delete_prefix(s3, bucket, release["tag"])
        log(f"  deleted release, tag and {removed} object(s)")

    for tag in sorted(orphans):
        if args.dry_run:
            continue
        removed = delete_prefix(s3, bucket, tag)
        log(f"{tag}: deleted {removed} orphaned object(s)")

    if not args.dry_run and (prune or orphans):
        write_state(s3, bucket, log)

    return 0


if __name__ == "__main__":
    sys.exit(main())
