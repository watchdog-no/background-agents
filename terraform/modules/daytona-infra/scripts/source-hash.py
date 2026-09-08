"""Hash all Daytona image inputs, including bundled non-code runtime assets."""

import hashlib
import json
import sys
from pathlib import Path


def source_hash(root: Path) -> str:
    files = []
    for directory in (
        "packages/daytona-infra/src",
        "packages/sandbox-runtime/src",
        "terraform/modules/daytona-infra/scripts",
    ):
        files.extend(
            path
            for path in (root / directory).rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.suffix not in (".pyc", ".pyo")
        )
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


if __name__ == "__main__":
    print(json.dumps({"hash": source_hash(Path(sys.argv[1]).resolve())}))
