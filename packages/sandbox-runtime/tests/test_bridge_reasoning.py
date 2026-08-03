"""Unit tests for reasoning ("thinking") part handling in the prompt stream.

OpenCode emits `reasoning` parts (full thinking text for Anthropic thinking
models, reasoning summaries for OpenAI/Codex models). These must be transformed
into `reasoning` bridge events so the control plane and web client can surface
them. Previously they were silently dropped.
"""

from unittest.mock import MagicMock

from sandbox_runtime.prompt_stream import OpenCodePromptStream, _PromptState


def make_stream() -> OpenCodePromptStream:
    return OpenCodePromptStream(
        client=MagicMock(),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        sse_inactivity_timeout_seconds=120.0,
        prompt_max_duration_seconds=5400.0,
        prompt_cleanup_timeout_seconds=30.0,
    )


def make_state() -> _PromptState:
    return _PromptState(
        opencode_session_id="oc-session-123",
        message_id="msg-1",
        opencode_message_id="oc-user-1",
        start_time=0.0,
    )


def test_transform_reasoning_part_emits_reasoning_event() -> None:
    part = {"id": "prt-1", "type": "reasoning", "text": "Let me check the schema first."}

    events = make_stream()._handle_part(make_state(), part, None)

    # blockId carries the part id so multiple reasoning blocks stay distinct.
    assert events == [
        {
            "type": "reasoning",
            "content": "Let me check the schema first.",
            "messageId": "msg-1",
            "blockId": "prt-1",
        }
    ]


def test_transform_empty_reasoning_part_is_dropped() -> None:
    part = {"id": "prt-1", "type": "reasoning", "text": ""}

    assert make_stream()._handle_part(make_state(), part, None) == []


def test_reasoning_and_text_parts_are_distinct() -> None:
    stream = make_stream()
    state = make_state()
    text_events = stream._handle_part(state, {"id": "prt-1", "type": "text", "text": "Done."}, None)
    reasoning_events = stream._handle_part(
        state,
        {"id": "prt-2", "type": "reasoning", "text": "Thinking about it."},
        None,
    )

    assert text_events[0]["type"] == "token"
    assert reasoning_events[0]["type"] == "reasoning"
