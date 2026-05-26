"""Unit tests for reasoning ("thinking") part handling in the bridge.

OpenCode emits `reasoning` parts (full thinking text for Anthropic thinking
models, reasoning summaries for OpenAI/Codex models). These must be transformed
into `reasoning` bridge events so the control plane and web client can surface
them. Previously they were silently dropped.
"""

import pytest

from sandbox_runtime.bridge import AgentBridge


@pytest.fixture
def bridge() -> AgentBridge:
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    b.opencode_session_id = "oc-session-123"
    return b


def test_transform_reasoning_part_emits_reasoning_event(bridge: AgentBridge) -> None:
    part = {"id": "prt-1", "type": "reasoning", "text": "Let me check the schema first."}

    event = bridge._transform_part_to_event(part, "msg-1")

    assert event == {
        "type": "reasoning",
        "content": "Let me check the schema first.",
        "messageId": "msg-1",
    }


def test_transform_empty_reasoning_part_is_dropped(bridge: AgentBridge) -> None:
    part = {"id": "prt-1", "type": "reasoning", "text": ""}

    assert bridge._transform_part_to_event(part, "msg-1") is None


def test_reasoning_and_text_parts_are_distinct(bridge: AgentBridge) -> None:
    text_event = bridge._transform_part_to_event(
        {"id": "prt-1", "type": "text", "text": "Done."}, "msg-1"
    )
    reasoning_event = bridge._transform_part_to_event(
        {"id": "prt-2", "type": "reasoning", "text": "Thinking about it."}, "msg-1"
    )

    assert text_event is not None and text_event["type"] == "token"
    assert reasoning_event is not None and reasoning_event["type"] == "reasoning"
