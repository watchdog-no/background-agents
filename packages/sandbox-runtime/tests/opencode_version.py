"""OpenCode release the image toolchain pins; wire tests assert the binary matches it."""

import json
from pathlib import Path

OPENCODE_VERSION = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/sandbox-images/toolchain.json").read_text()
)["opencode"]
