#!/usr/bin/env python3
"""Recompute the state files after a run has stopped changing the bucket.

Each build writes state when it finishes so pollers see progress, but
those writes race: eighteen jobs finishing at once means the last writer
wins, and it may have hashed the bucket before the others uploaded. The
hashes are content-derived, so a final pass converges regardless of who
wrote what.
"""

import os
import sys

from release_state import s3_client, write_state


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> int:
    write_state(s3_client(), os.environ["R2_BUCKET"], log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
