#!/usr/bin/env python3
"""Verify the archival baseline, without network, dependencies, or model calls."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git", action="store_true", help="also compare fetched Git blobs")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / "upstream/baseline.json").read_text(encoding="utf-8"))
    archive = root / "upstream/deepseek-harness"
    entries = manifest["files"]
    expected = {entry["path"] for entry in entries}
    observed = {path.relative_to(archive).as_posix() for path in archive.rglob("*") if path.is_file()}
    problems = [f"missing: {path}" for path in sorted(expected - observed)]
    problems += [f"unexpected: {path}" for path in sorted(observed - expected)]
    for entry in entries:
        path = archive / entry["path"]
        if entry["path"] not in observed:
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(archive.resolve()):
            problems.append(f"unsafe path: {entry['path']}")
            continue
        content = path.read_bytes()
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            problems.append(f"content mismatch: {entry['path']}")
        git_blob = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
        if git_blob != entry["git_blob"]:
            problems.append(f"git blob mismatch: {entry['path']}")
        if args.git:
            git_content = subprocess.check_output(["git", "cat-file", "blob", entry["git_blob"]], cwd=root)
            if content != git_content:
                problems.append(f"upstream object mismatch: {entry['path']}")
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print(f"PASS: {len(entries)} unmodified upstream files; SHA-256 and Git blob IDs match")
    if args.git:
        print(f"PASS: fetched Git objects match pinned commit {manifest['commit']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
