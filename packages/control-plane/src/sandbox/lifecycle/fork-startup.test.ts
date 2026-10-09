import type { StopResult } from "../provider";
import { describe, it, expect, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import {
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockAlarmScheduler,
  createMockProvider,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockIdGenerator,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";
function parseStructuredLogs(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
}
describe("fork sandbox startup contracts", () => {
  it.each(["spawn", "restore"] as const)(
    "blocks %s and retains the handle when prior provider cleanup fails",
    async (kind) => {
      const sandbox = createMockSandbox({
        status: kind === "spawn" ? "pending" : "stopped",
        snapshot_image_id: kind === "restore" ? "img-abc123" : null,
        snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
        created_at: Date.now() - 60000,
      });
      const storage = createMockStorage(createMockSession(), sandbox);
      let providerHandleAtStart: string | null | undefined;
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        createSandbox: vi.fn(async (config) => {
          providerHandleAtStart = sandbox.modal_object_id;
          return {
            sandboxId: config.sandboxId,
            status: "connecting",
            createdAt: Date.now(),
            lifetime: noLifetime(),
          };
        }),
        restoreFromSnapshot: vi.fn(async (config) => {
          providerHandleAtStart = sandbox.modal_object_id;
          return {
            success: true as const,
            sandboxId: config.sandboxId,
            lifetime: noLifetime(),
          };
        }),
        stopSandbox: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
      });
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      await manager.spawnSandbox();

      expect(storage.updateSandboxForSpawn).toHaveBeenCalledOnce();
      // The prior sandbox could not be stopped, so its handle is retained
      // for a later retry and no replacement is created in its place.
      expect(providerHandleAtStart).toBeUndefined();
      expect(sandbox.modal_object_id).toBe("modal-obj-123");
      expect(
        kind === "spawn" ? provider.createSandbox : provider.restoreFromSnapshot
      ).not.toHaveBeenCalled();
      expect(storage.transitionSandboxStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: expect.any(String) }),
        "spawning",
        "failed"
      );
      expect(parseStructuredLogs(warnSpy)).toContainEqual(
        expect.objectContaining({
          msg: "Provider stop failed before sandbox replacement",
          error: "provider unavailable",
        })
      );
      warnSpy.mockRestore();
    }
  );
  it("blocks replacement when prior provider cleanup times out", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = createMockSandbox({ status: "pending", created_at: Date.now() - 60000 });
      const storage = createMockStorage(createMockSession(), sandbox);
      let providerHandleAtCreate: string | null | undefined;
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        createSandbox: vi.fn(async (config) => {
          providerHandleAtCreate = sandbox.modal_object_id;
          return {
            sandboxId: config.sandboxId,
            status: "connecting",
            createdAt: Date.now(),
            lifetime: noLifetime(),
          };
        }),
        stopSandbox: vi.fn(() => new Promise<StopResult>(() => {})),
      });
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        createTestConfig()
      );
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const spawning = manager.spawnSandbox();
      await vi.waitFor(() => expect(provider.stopSandbox).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);
      await spawning;

      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(providerHandleAtCreate).toBeUndefined();
      expect(storage.transitionSandboxStatus).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxId: expect.any(String) }),
        "spawning",
        "failed"
      );
      expect(sandbox.modal_object_id).toBe("modal-obj-123");
      expect(parseStructuredLogs(warnSpy)).toContainEqual(
        expect.objectContaining({
          msg: "Provider stop failed before sandbox replacement",
          error: "Provider stop timed out before sandbox replacement",
        })
      );
      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
  it("schedules connecting timeout alarm after restore", async () => {
    const sandbox = createMockSandbox({
      status: "stopped",
      snapshot_image_id: "img-abc123",
      snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
    });
    const storage = createMockStorage(createMockSession(), sandbox);
    const alarmScheduler = createMockAlarmScheduler();
    const config = createTestConfig();

    const manager = createTestLifecycleManager(
      createMockProvider(),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      alarmScheduler,
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      config
    );

    const before = Date.now();
    await manager.spawnSandbox();
    const after = Date.now();

    expect(alarmScheduler.alarms.length).toBe(1);
    const scheduledTime = alarmScheduler.alarms[0];
    expect(scheduledTime).toBeGreaterThanOrEqual(before + config.connectingTimeout.timeoutMs);
    expect(scheduledTime).toBeLessThanOrEqual(after + config.connectingTimeout.timeoutMs);
  });
});
