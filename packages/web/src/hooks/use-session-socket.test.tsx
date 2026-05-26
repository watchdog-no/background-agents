// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage, SessionArtifact, SessionState } from "@open-inspect/shared";
import type * as SwrModule from "swr";
import { useSessionSocket } from "./use-session-socket";

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
}));

vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof SwrModule>("swr");
  return {
    ...actual,
    mutate: mutateMock,
  };
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({
      data: JSON.stringify(message),
    } as MessageEvent);
  }
}

function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    branchName: "feature/original",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function createSubscribedMessage(
  artifacts: SessionArtifact[] = []
): Extract<ServerMessage, { type: "subscribed" }> {
  return {
    type: "subscribed",
    sessionId: "session-1",
    state: createSessionState(),
    artifacts,
    participantId: "participant-1",
    participant: {
      participantId: "participant-1",
      name: "Test User",
    },
    replay: {
      events: [],
      hasMore: false,
      cursor: null,
    },
    spawnError: null,
  };
}

describe("useSessionSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mutateMock.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          token: "ws-token",
        })
      )
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("client-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates artifacts from the subscribed payload", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: {
              number: 42,
              state: "open",
              head: "feature/test",
              base: "main",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/42",
          metadata: expect.objectContaining({
            prNumber: 42,
            prState: "open",
            head: "feature/test",
            base: "main",
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates screenshot metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-1",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-1.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-1.png",
              mimeType: "image/png",
              sizeBytes: 512,
              caption: "Dashboard after fix",
              sourceUrl: "http://127.0.0.1:3000",
              fullPage: true,
              annotated: false,
              viewport: { width: 1440, height: 900 },
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-1",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-1.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-1.png",
            mimeType: "image/png",
            sizeBytes: 512,
            caption: "Dashboard after fix",
            sourceUrl: "http://127.0.0.1:3000",
            fullPage: true,
            annotated: false,
            viewport: { width: 1440, height: 900 },
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("hydrates video metadata from subscribed artifacts", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-video-1",
            type: "video",
            url: "sessions/session-1/media/artifact-video-1.mp4",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-video-1.mp4",
              mimeType: "video/mp4",
              sizeBytes: 4096,
              caption: "Menu interaction",
              sourceUrl: "http://127.0.0.1:3000/start",
              endUrl: "http://127.0.0.1:3000/end",
              durationMs: 1450,
              recordingStartedAt: 1000,
              recordingEndedAt: 2450,
              dimensions: { width: 1280, height: 720 },
              truncated: false,
              hasAudio: false,
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-video-1",
          type: "video",
          url: "sessions/session-1/media/artifact-video-1.mp4",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-video-1.mp4",
            mimeType: "video/mp4",
            sizeBytes: 4096,
            caption: "Menu interaction",
            sourceUrl: "http://127.0.0.1:3000/start",
            endUrl: "http://127.0.0.1:3000/end",
            durationMs: 1450,
            recordingStartedAt: 1000,
            recordingEndedAt: 2450,
            dimensions: { width: 1280, height: 720 },
            truncated: false,
            hasAudio: false,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("drops wrong-type metadata fields during narrowing", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });

    act(() => {
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-shot-wrong-types",
            type: "screenshot",
            url: "sessions/session-1/media/artifact-shot-wrong-types.png",
            metadata: {
              objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
              mimeType: "image/png",
              sizeBytes: "five",
              viewport: "not-an-object",
            },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-shot-wrong-types",
          type: "screenshot",
          url: "sessions/session-1/media/artifact-shot-wrong-types.png",
          metadata: expect.objectContaining({
            objectKey: "sessions/session-1/media/artifact-shot-wrong-types.png",
            mimeType: "image/png",
            sizeBytes: undefined,
            viewport: undefined,
          }),
          createdAt: 1234,
        },
      ]);
    });
  });

  it("replaces stale artifacts with the subscribed snapshot", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/42",
            metadata: { number: 42, state: "open" },
            createdAt: 1234,
          },
        ])
      );
    });

    await waitFor(() => {
      expect(result.current.artifacts).toHaveLength(1);
    });

    act(() => {
      socket.receive(createSubscribedMessage());
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([]);
    });
  });

  it("updates sessionState.branchName from session_branch without mutating the sidebar cache", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({ type: "session_branch", branchName: "feature/live-update" });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.branchName).toBe("feature/live-update");
    });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("tracks current context size from step_finish input tokens (replaces, not sums)", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({
        type: "sandbox_event",
        event: {
          type: "step_finish",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 10,
          tokens: { input: 14000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.sessionState?.contextTokens).toBe(14000);
    });

    act(() => {
      socket.receive({
        type: "sandbox_event",
        event: {
          type: "step_finish",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 11,
          tokens: { input: 18000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
    });

    // Latest input replaces the previous value (not 14000 + 18000).
    await waitFor(() => {
      expect(result.current.sessionState?.contextTokens).toBe(18000);
    });
  });

  it("collapses replayed accumulated token snapshots to the final assistant text", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive({
        ...createSubscribedMessage(),
        replay: {
          events: [
            {
              type: "token",
              content: "Hel",
              messageId: "msg-1",
              sandboxId: "sandbox-1",
              timestamp: 10,
            },
            {
              type: "token",
              content: "Hello",
              messageId: "msg-1",
              sandboxId: "sandbox-1",
              timestamp: 11,
            },
            {
              type: "execution_complete",
              messageId: "msg-1",
              success: true,
              sandboxId: "sandbox-1",
              timestamp: 12,
            },
          ],
          hasMore: false,
          cursor: null,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([
        {
          type: "token",
          content: "Hello",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 11,
        },
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sandbox-1",
          timestamp: 12,
        },
      ]);
    });
  });

  it("keeps live accumulated token snapshots hidden until execution completes", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage());
    });

    act(() => {
      socket.receive({
        type: "sandbox_event",
        event: {
          type: "token",
          content: "Hel",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 10,
        },
      });
      socket.receive({
        type: "sandbox_event",
        event: {
          type: "token",
          content: "Hello",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 11,
        },
      });
    });

    expect(result.current.events).toEqual([]);

    act(() => {
      socket.receive({
        type: "sandbox_event",
        event: {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sandbox-1",
          timestamp: 12,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.events).toEqual([
        {
          type: "token",
          content: "Hello",
          messageId: "msg-1",
          sandboxId: "sandbox-1",
          timestamp: 11,
        },
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sandbox-1",
          timestamp: 12,
        },
      ]);
    });
  });

  it("prepends new artifacts and replaces duplicates by id", async () => {
    const { result } = renderHook(() => useSessionSocket("session-1"));

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage([
          {
            id: "artifact-pr-1",
            type: "pr",
            url: "https://github.com/acme/web-app/pull/1",
            metadata: { number: 1, state: "open" },
            createdAt: 100,
          },
        ])
      );
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: { number: 2, state: "draft" },
          createdAt: 200,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts.map((artifact) => artifact.id)).toEqual([
        "artifact-pr-2",
        "artifact-pr-1",
      ]);
    });

    act(() => {
      socket.receive({
        type: "artifact_created",
        artifact: {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: { number: 1, state: "closed" },
          createdAt: 300,
        },
      });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([
        {
          id: "artifact-pr-2",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/2",
          metadata: expect.objectContaining({
            prNumber: 2,
            prState: "draft",
          }),
          createdAt: 200,
        },
        {
          id: "artifact-pr-1",
          type: "pr",
          url: "https://github.com/acme/web-app/pull/1-updated",
          metadata: expect.objectContaining({
            prNumber: 1,
            prState: "closed",
          }),
          createdAt: 300,
        },
      ]);
    });
  });
});
