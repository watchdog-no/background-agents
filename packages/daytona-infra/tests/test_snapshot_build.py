"""Regression coverage for the production Daytona image and safe build retries."""

import importlib.util
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from daytona import DaytonaNotFoundError
from sandbox_images.bundle import pack_bundle
from src import bootstrap
from src.toolchain import build_base_image, create_base_snapshot

ROOT = Path(__file__).resolve().parents[3]
MEMORY_GIB = 2


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    """The staged installation context build_base_image renders a Dockerfile from."""
    packed = pack_bundle(ROOT, "daytona", tmp_path_factory.mktemp("sandbox-images"))
    yield packed
    shutil.rmtree(packed.directory, ignore_errors=True)


def test_image_uses_current_runtime_and_has_terminal(bundle):
    dockerfile = build_base_image(bundle).dockerfile()
    manifest = json.loads(
        (ROOT / "packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json").read_text()
    )
    assert manifest["runtimeVersion"] in dockerfile
    assert "packages/sandbox-images/install/install.sh" in dockerfile
    tools = (ROOT / "packages/sandbox-images/install/tools.sh").read_text()
    assert "/usr/local/bin/ttyd" in tools
    assert "download_checked" in tools


def test_snapshot_preserves_workspace_resource_limits(bundle):
    client = MagicMock()
    create_base_snapshot(client, bundle, "candidate", MEMORY_GIB)
    resources = client.snapshot.create.call_args.args[0].resources
    # The disk ceiling is the workspace quota, not the image size.
    assert (resources.cpu, resources.memory, resources.disk) == (2, MEMORY_GIB, 10)


def test_non_code_assets_change_image_hash(tmp_path):
    script = ROOT / "terraform/modules/daytona-infra/scripts/source-hash.py"
    spec = importlib.util.spec_from_file_location("source_hash", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    runtime = tmp_path / "packages/sandbox-runtime/src"
    runtime.mkdir(parents=True)
    asset = runtime / "runtime_manifest.json"
    asset.write_text('{"generation": 75}')
    before = module.source_hash(tmp_path)
    asset.write_text('{"generation": 76}')
    assert module.source_hash(tmp_path) != before
    before = module.source_hash(tmp_path)
    (runtime / "SKILL.md").write_text("New skill instructions")
    assert module.source_hash(tmp_path) != before
    before = module.source_hash(tmp_path)
    cache = runtime / "__pycache__"
    cache.mkdir()
    (cache / "module.pyc").write_bytes(b"local cache")
    assert module.source_hash(tmp_path) == before


@pytest.fixture
def build(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(bootstrap, "Daytona", lambda _: client)
    monkeypatch.setattr(
        bootstrap,
        "load_config",
        lambda: SimpleNamespace(
            api_key="test-key",
            api_url=None,
            target=None,
            base_snapshot="test",
            base_snapshot_memory_gib=MEMORY_GIB,
            repo_root=ROOT,
        ),
    )
    create = MagicMock()
    monkeypatch.setattr(bootstrap, "create_base_snapshot", create)
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "test")
    client.create.return_value.process.exec.return_value.exit_code = 0
    from sandbox_images import native

    monkeypatch.setattr(native, "write_build_result", MagicMock())
    return client, create


def test_retries_reuse_active_snapshot_without_deleting(build):
    client, create = build
    client.snapshot.get.return_value.state = "active"
    bootstrap.main()
    create.assert_not_called()
    client.snapshot.delete.assert_not_called()


def test_missing_snapshot_is_built(build):
    client, create = build
    client.snapshot.get.side_effect = DaytonaNotFoundError("missing")
    bootstrap.main()
    create.assert_called_once()
    call_client, call_bundle, call_name, call_memory = create.call_args.args
    assert (call_client, call_name, call_memory) == (client, "test", MEMORY_GIB)
    assert call_bundle.plan["provider"] == "daytona"


def test_failed_snapshot_blocks_worker_cutover(build):
    client, create = build
    client.create.return_value.process.exec.return_value.exit_code = 1
    with pytest.raises(RuntimeError, match="verification failed"):
        bootstrap.main()
    create.assert_not_called()
    client.snapshot.delete.assert_not_called()
