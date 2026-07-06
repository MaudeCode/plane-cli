import { createClient, type RedisClientType } from "redis";

export type PlaneMcpSessionContext = {
  project?: string;
  workspace?: string;
};

export type PlaneMcpContextStore = {
  clear: (sessionId: string) => Promise<void>;
  close?: () => Promise<void>;
  createSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  get: (sessionId: string) => Promise<PlaneMcpSessionContext>;
  hasSession: (sessionId: string) => Promise<boolean>;
  set: (sessionId: string, context: PlaneMcpSessionContext) => Promise<void>;
  start?: () => Promise<void>;
  touchSession: (sessionId: string) => Promise<void>;
};

export type PlaneMcpRedisContextStoreOptions = {
  prefix?: string;
  ttlSeconds?: number;
  url: string;
};

export function createContextStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PlaneMcpContextStore {
  const redisUrl = nonEmpty(env.PLANE_MCP_REDIS_URL) ?? nonEmpty(env.REDIS_URL);
  if (!redisUrl) return createMemoryContextStore();

  return createRedisContextStore({
    prefix: nonEmpty(env.PLANE_MCP_REDIS_PREFIX),
    ttlSeconds: parsePositiveInteger(env.PLANE_MCP_SESSION_TTL_SECONDS),
    url: redisUrl,
  });
}

export function createMemoryContextStore(
  initialContexts: Iterable<[string, PlaneMcpSessionContext]> = [],
): PlaneMcpContextStore {
  const contexts = new Map<string, PlaneMcpSessionContext>();
  const sessions = new Set<string>();
  for (const [sessionId, context] of initialContexts) {
    contexts.set(sessionId, normalizeContext(context));
    sessions.add(sessionId);
  }

  return {
    async clear(sessionId) {
      contexts.delete(sessionId);
    },
    async createSession(sessionId) {
      sessions.add(sessionId);
    },
    async deleteSession(sessionId) {
      sessions.delete(sessionId);
      contexts.delete(sessionId);
    },
    async get(sessionId) {
      return contexts.get(sessionId) ?? {};
    },
    async hasSession(sessionId) {
      return sessions.has(sessionId);
    },
    async set(sessionId, context) {
      const normalized = normalizeContext(context);
      if (!normalized.workspace && !normalized.project) {
        contexts.delete(sessionId);
        return;
      }
      contexts.set(sessionId, normalized);
    },
    async touchSession(sessionId) {
      sessions.add(sessionId);
    },
  };
}

export function createRedisContextStore(
  options: PlaneMcpRedisContextStoreOptions,
): PlaneMcpContextStore {
  return new RedisPlaneMcpContextStore(options);
}

function normalizeContext(context: PlaneMcpSessionContext): PlaneMcpSessionContext {
  return {
    ...(optionalString(context.workspace) ? { workspace: optionalString(context.workspace) } : {}),
    ...(optionalString(context.project) ? { project: optionalString(context.project) } : {}),
  };
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseContext(value: string | null): PlaneMcpSessionContext {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const context = parsed as Record<string, unknown>;
    return normalizeContext({
      project: typeof context.project === "string" ? context.project : undefined,
      workspace: typeof context.workspace === "string" ? context.workspace : undefined,
    });
  } catch {
    return {};
  }
}

class RedisPlaneMcpContextStore implements PlaneMcpContextStore {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  private started = false;

  constructor(options: PlaneMcpRedisContextStoreOptions) {
    this.client = createClient({ url: options.url });
    this.client.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.emitWarning(`Plane MCP Redis context store error: ${message}`);
    });
    this.prefix = options.prefix ?? "plane-cli:mcp";
    this.ttlSeconds = options.ttlSeconds ?? 86_400;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.connect();
    this.started = true;
  }

  async close(): Promise<void> {
    if (!this.started) return;
    await this.client.quit();
    this.started = false;
  }

  async get(sessionId: string): Promise<PlaneMcpSessionContext> {
    await this.start();
    return parseContext(await this.client.get(this.key(sessionId)));
  }

  async createSession(sessionId: string): Promise<void> {
    await this.start();
    await this.writeWithTtl(this.sessionKey(sessionId), "1");
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.start();
    await this.client.del([this.sessionKey(sessionId), this.key(sessionId)]);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    await this.start();
    return (await this.client.exists(this.sessionKey(sessionId))) === 1;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.start();
    if (this.ttlSeconds <= 0) return;
    await this.client.expire(this.sessionKey(sessionId), this.ttlSeconds);
    await this.client.expire(this.key(sessionId), this.ttlSeconds);
  }

  async set(sessionId: string, context: PlaneMcpSessionContext): Promise<void> {
    await this.start();
    const normalized = normalizeContext(context);
    if (!normalized.workspace && !normalized.project) {
      await this.clear(sessionId);
      return;
    }

    await this.createSession(sessionId);
    const value = JSON.stringify(normalized);
    await this.writeWithTtl(this.key(sessionId), value);
  }

  async clear(sessionId: string): Promise<void> {
    await this.start();
    await this.client.del(this.key(sessionId));
  }

  private async writeWithTtl(key: string, value: string): Promise<void> {
    if (this.ttlSeconds > 0) {
      await this.client.setEx(key, this.ttlSeconds, value);
      return;
    }

    await this.client.set(key, value);
  }

  private key(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}:context`;
  }

  private sessionKey(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}`;
  }
}
