"""Offline regression tests for provenance validation, not plugin/product tests."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "upstream/baseline.json").read_text(encoding="utf-8"))


class ProvenanceTests(unittest.TestCase):
    def verify(self, content: bytes) -> subprocess.CompletedProcess[str]:
        temporary_parent = ROOT / ".tmp/validator-tests"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="case-", dir=temporary_parent) as name:
            temporary = Path(name).resolve()
            # This assertion also bounds the eventual TemporaryDirectory cleanup.
            assert temporary.is_relative_to(temporary_parent.resolve())
            (temporary / "tools").mkdir()
            archive = temporary / "upstream/deepseek-harness"
            archive.mkdir(parents=True)
            source_ref = os.environ.get("BASELINE_VERIFIER_REF")
            if source_ref:
                script = subprocess.check_output([
                    "git", "show", f"{source_ref}:tools/verify-upstream.py",
                ], cwd=ROOT)
            else:
                script = (ROOT / "tools/verify-upstream.py").read_bytes()
            (temporary / "tools/verify-upstream.py").write_bytes(script)
            (archive / "LICENSE").write_bytes(content)
            manifest = {
                "commit": MANIFEST["commit"], "selected_paths": ["LICENSE"], "file_count": 1,
                "files": [{
                    "path": "LICENSE", "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                    "git_blob": hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest(),
                }],
            }
            (temporary / "upstream/baseline.json").write_text(json.dumps(manifest), encoding="utf-8")
            env = dict(os.environ, GIT_DIR=str(ROOT / ".git"), GIT_NO_LAZY_FETCH="1")
            return subprocess.run([
                sys.executable, str(temporary / "tools/verify-upstream.py"), "--git",
            ], cwd=temporary, env=env, capture_output=True, text=True, check=False)

    def test_accepts_actual_pinned_path(self) -> None:
        result = self.verify((ROOT / "upstream/deepseek-harness/LICENSE").read_bytes())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_rejects_unrelated_blob_even_with_consistent_manifest(self) -> None:
        unrelated = ROOT / "upstream/deepseek-harness/packages/experimental/voice-input-bundle/README.md"
        result = self.verify(unrelated.read_bytes())
        self.assertNotEqual(result.returncode, 0, "Wrong blob accepted as the pinned LICENSE path")
        self.assertIn("pinned commit mismatch: LICENSE", result.stderr)


if __name__ == "__main__":
    unittest.main()
