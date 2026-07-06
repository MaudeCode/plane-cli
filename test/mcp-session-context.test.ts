import { beforeEach, describe, expect, test, vi } from "vitest";

const redisMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const client = {
    connect: vi.fn(async () => undefined),
    del: vi.fn(async (keys: string | string[]) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        store.delete(key);
        ttls.delete(key);
      }
      return keyList.length;
    }),
    exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    expire: vi.fn(async (key: string, ttl: number) => {
      ttls.set(key, ttl);
      return store.has(key) ? 1 : 0;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
      return client;
    }),
    quit: vi.fn(async () => undefined),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    setEx: vi.fn(async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      ttls.set(key, ttl);
      return "OK";
    }),
  };

  return {
    client,
    createClient: vi.fn(() => client),
    reset: () => {
      store.clear();
      ttls.clear();
      listeners.clear();
      vi.clearAllMocks();
    },
    listeners,
    store,
    ttls,
  };
});

vi.mock("redis", () => ({ createClient: redisMock.createClient }));

import { createContextStoreFromEnv } from "../src/mcp/session-context.js";

describe("Plane MCP Redis context store", () => {
  beforeEach(() => {
    redisMock.reset();
  });

  test("selects Redis from env and preserves session context lifecycle", async () => {
    const store = createContextStoreFromEnv({
      PLANE_MCP_REDIS_PREFIX: "test-prefix",
      PLANE_MCP_REDIS_URL: "redis://example.test:6379",
      PLANE_MCP_SESSION_TTL_SECONDS: "60",
    });

    expect(redisMock.createClient).toHaveBeenCalledWith({
      url: "redis://example.test:6379",
    });
    expect(redisMock.client.on).toHaveBeenCalledWith("error", expect.any(Function));

    await store.createSession("session-a");
    expect(await store.hasSession("session-a")).toBe(true);
    expect(redisMock.store.get("test-prefix:session:session-a")).toBe("1");
    expect(redisMock.ttls.get("test-prefix:session:session-a")).toBe(60);

    await store.set("session-a", {
      project: " Web ",
      workspace: " MaudeCode ",
    });
    await expect(store.get("session-a")).resolves.toEqual({
      project: "Web",
      workspace: "MaudeCode",
    });
    expect(redisMock.ttls.get("test-prefix:session:session-a:context")).toBe(60);

    await store.touchSession("session-a");
    expect(redisMock.client.expire).toHaveBeenCalledWith("test-prefix:session:session-a", 60);
    expect(redisMock.client.expire).toHaveBeenCalledWith(
      "test-prefix:session:session-a:context",
      60,
    );

    await store.clear("session-a");
    await expect(store.get("session-a")).resolves.toEqual({});
    expect(await store.hasSession("session-a")).toBe(true);

    await store.deleteSession("session-a");
    expect(await store.hasSession("session-a")).toBe(false);
    await store.close?.();
    expect(redisMock.client.quit).toHaveBeenCalledTimes(1);
  });

  test("registers a Redis error listener so socket errors are handled", () => {
    createContextStoreFromEnv({
      PLANE_MCP_REDIS_URL: "redis://example.test:6379",
    });

    expect(redisMock.client.on).toHaveBeenCalledWith("error", expect.any(Function));
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    redisMock.listeners.get("error")?.(new Error("socket closed"));
    expect(emitWarning).toHaveBeenCalledWith(
      "Plane MCP Redis context store error: socket closed",
    );
    emitWarning.mockRestore();
  });
});
