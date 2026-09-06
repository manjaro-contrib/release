"""Publish BoxIt-style state files describing the release bucket.

The same shape the package repository serves, so anything that polls one
can poll the other: a hash per release plus a global one, rewritten
whenever the contents change.

Releases are grouped by tag rather than by branch, so the per-tag file is
effectively immutable once a release finishes uploading - it is the global
file that moves as releases come and go.
"""

import datetime
import hashlib
import os

import boto3

GLOBAL_TEMPLATE = """\
###
### BoxIt global state file
###

# Unique hash code representing current repository state.
# This hash code changes in a frequent interval.
state={state}

# Date and time of the last state update.
date={date}"""

RELEASE_TEMPLATE = """\
###
### BoxIt release state file
###

# Unique hash code representing current release state.
# This hash code changes as soon as anything changes in this release.
state={state}

# Date and time of the last release change.
date={date}"""

STATE_FILE = "state"


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def _timestamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _digest(entries: list[str]) -> str:
    digest = hashlib.sha1()
    for entry in sorted(entries):
        digest.update(entry.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def release_objects(s3, bucket: str) -> dict[str, list[str]]:
    """Every object grouped by release tag, as `name size etag` entries.

    Content-addressed rather than time-based, so re-uploading identical
    bytes leaves the hash alone and pollers do not resync for nothing.
    """
    releases: dict[str, list[str]] = {}
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key == STATE_FILE or key.endswith(f"/{STATE_FILE}"):
                continue
            release, _, name = key.partition("/")
            if not name:
                continue
            etag = obj["ETag"].strip('"')
            releases.setdefault(release, []).append(
                f"{name} {obj['Size']} {etag}"
            )
    return releases


def write_state(s3, bucket: str, log=lambda _msg: None) -> None:
    """Rewrite the per-release state files and the global one."""
    now = _timestamp()
    releases = release_objects(s3, bucket)

    digests = {}
    for release, entries in sorted(releases.items()):
        digest = _digest(entries)
        digests[release] = digest
        s3.put_object(
            Bucket=bucket,
            Key=f"{release}/{STATE_FILE}",
            Body=RELEASE_TEMPLATE.format(state=digest, date=now).encode(),
            ContentType="text/plain",
        )
        log(f"state {release}={digest}")

    combined = _digest([f"{r} {d}" for r, d in digests.items()])
    s3.put_object(
        Bucket=bucket,
        Key=STATE_FILE,
        Body=GLOBAL_TEMPLATE.format(state=combined, date=now).encode(),
        ContentType="text/plain",
    )
    log(f"state global={combined}")
