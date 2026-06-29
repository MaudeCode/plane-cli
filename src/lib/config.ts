import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  ConfigInvalidError,
  ConfigNotFoundError,
  MissingPlaneApiKeyError,
  WorkspaceNotFoundError,
  WorkspaceNotResolvedError,
} from "./errors.js";

const DEFAULT_BASE_URL = "https://api.plane.so";

const rawWorkspaceSchema = z.object({
  apiKey: z.string().optional(),
  auth: z
    .object({
      accessToken: z.string().optional(),
      appInstallationId: z.string().optional(),
      apiKey: z.string().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      expiresAt: z.string().optional(),
      flow: z.enum(["authorization_code", "client_credentials"]).optional(),
      refreshToken: z.string().optional(),
      scopes: z.array(z.string()).optional(),
      tokenType: z.string().optional(),
      type: z.enum(["apiKey", "oauth"]),
    })
    .optional(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  displayName: z.string().optional(),
  workspaceSlug: z.string().min(1),
});

const configSchema = z.object({
  defaultWorkspace: z.string().optional(),
  workspaces: z.record(rawWorkspaceSchema).default({}),
});

export type ConfigLoadOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home?: string;
};

export type WorkspaceConfig = {
  apiKey?: string;
  auth?:
    | { type: "apiKey"; apiKey: string }
    | {
        accessToken: string;
        appInstallationId?: string;
        clientId?: string;
        clientSecret?: string;
        expiresAt?: string;
        flow?: "authorization_code" | "client_credentials";
        refreshToken?: string;
        scopes?: string[];
        tokenType?: string;
        type: "oauth";
      };
  baseUrl: string;
  displayName?: string;
  name: string;
  workspaceSlug: string;
};

export type PublicWorkspaceConfig = Omit<WorkspaceConfig, "apiKey" | "auth"> & {
  authType?: "apiKey" | "oauth";
  hasApiKey: boolean;
  hasCredentials: boolean;
};

export type AppConfig = {
  configPath?: string;
  defaultWorkspace?: string;
  workspaces: WorkspaceConfig[];
};

export type PublicAppConfig = {
  configPath?: string;
  defaultWorkspace?: string;
  workspaces: PublicWorkspaceConfig[];
};

export type RepoWorkspaceHint = {
  path: string;
  project?: string;
  workspace: string;
};

export type WorkspaceResolution = {
  source: "explicit" | "repo" | "env" | "default" | "single";
  workspace: WorkspaceConfig;
};

export type UpsertWorkspaceConfigOptions = ConfigLoadOptions & {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  setDefault?: boolean;
  workspace: string;
  workspaceSlug: string;
};

export type UpsertWorkspaceConfigResult = {
  configPath: string;
  defaultWorkspace?: string;
  workspace: PublicWorkspaceConfig;
};

export type UpsertOAuthWorkspaceConfigOptions = ConfigLoadOptions & {
  auth: Extract<NonNullable<WorkspaceConfig["auth"]>, { type: "oauth" }>;
  baseUrl?: string;
  displayName?: string;
  setDefault?: boolean;
  workspace: string;
  workspaceSlug: string;
};

export function envApiKeyName(workspace: string): string {
  return `PLANE_API_KEY_${workspace.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

export function configSearchPaths(options: ConfigLoadOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  return [
    join(cwd, ".plane-cli.yaml"),
    join(cwd, ".plane-cli.json"),
    join(home, ".config", "plane-cli", "config.yaml"),
    join(home, ".config", "plane-cli", "config.json"),
  ];
}

export async function resolveConfigPath(
  options: ConfigLoadOptions = {},
): Promise<string | undefined> {
  return configSearchPaths(options).find((path) => existsSync(path));
}

export async function loadRepoWorkspaceHint(
  options: Pick<ConfigLoadOptions, "cwd"> = {},
): Promise<RepoWorkspaceHint | null> {
  let current = resolve(options.cwd ?? process.cwd());
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, ".plane-cli-workspace");
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, "utf8");
      const parsed = YAML.parse(raw) as unknown;
      const workspace =
        typeof parsed === "string"
          ? parsed.trim()
          : typeof parsed === "object" && parsed !== null && "workspace" in parsed
            ? String(parsed.workspace).trim()
            : "";
      const project =
        typeof parsed === "object" &&
        parsed !== null &&
        "project" in parsed &&
        parsed.project !== undefined
          ? String(parsed.project).trim()
          : undefined;
      if (!workspace) {
        throw new ConfigInvalidError(".plane-cli-workspace must contain a workspace name.", {
          path: candidate,
        });
      }
      return { path: candidate, project: project || undefined, workspace };
    }

    if (current === root) return null;
    current = dirname(current);
  }
}

export async function loadConfig(options: ConfigLoadOptions = {}): Promise<AppConfig> {
  const env = options.env ?? process.env;
  const searchPaths = configSearchPaths(options);
  const configPath = await resolveConfigPath(options);
  if (!configPath) throw new ConfigNotFoundError(searchPaths);
  const repoLocalConfig = isRepoLocalConfigPath(configPath, options);

  const parsed = configSchema.safeParse((await readRawConfig(configPath)) ?? {});
  if (!parsed.success) {
    throw new ConfigInvalidError("Invalid plane-cli config file.", {
      issues: parsed.error.issues,
      path: configPath,
    });
  }

  const workspaceEntries = Object.entries(parsed.data.workspaces);
  if (workspaceEntries.length === 0) {
    throw new ConfigInvalidError("At least one Plane workspace must be configured.", {
      path: configPath,
    });
  }

  const workspaces = workspaceEntries.map(([name, workspace]) => {
    if (!name.trim()) {
      throw new ConfigInvalidError("Workspace names must be non-empty.", { path: configPath });
    }
    const envBaseUrl = env[envBaseUrlName(name)];
    const fileBaseUrl = normalizeBaseUrl(workspace.baseUrl ?? DEFAULT_BASE_URL);
    const baseUrl = normalizeBaseUrl(envBaseUrl ?? fileBaseUrl);
    const candidateEnvApiKey = env[envApiKeyName(name)];
    const envApiKey = shouldApplyEnvApiKey({
      envApiKey: candidateEnvApiKey,
      envBaseUrl,
      fileBaseUrl,
      repoLocalConfig,
    })
      ? candidateEnvApiKey
      : undefined;
    const auth =
      workspace.auth ??
      (workspace.apiKey ? { type: "apiKey" as const, apiKey: workspace.apiKey } : undefined);
    const resolvedAuth = envApiKey ? { type: "apiKey" as const, apiKey: envApiKey } : auth;
    if (!resolvedAuth) throw new MissingPlaneApiKeyError(name);
    return {
      apiKey: resolvedAuth.type === "apiKey" ? resolvedAuth.apiKey : undefined,
      auth:
        resolvedAuth.type === "oauth"
          ? {
              accessToken: resolvedAuth.accessToken ?? "",
              appInstallationId: resolvedAuth.appInstallationId,
              clientId: resolvedAuth.clientId,
              clientSecret: resolvedAuth.clientSecret,
              expiresAt: resolvedAuth.expiresAt,
              flow: resolvedAuth.flow,
              refreshToken: resolvedAuth.refreshToken,
              scopes: resolvedAuth.scopes,
              tokenType: resolvedAuth.tokenType,
              type: "oauth" as const,
            }
          : { type: "apiKey" as const, apiKey: resolvedAuth.apiKey ?? "" },
      baseUrl,
      displayName: workspace.displayName,
      name,
      workspaceSlug: workspace.workspaceSlug,
    };
  });

  if (
    parsed.data.defaultWorkspace &&
    !workspaces.some((workspace) => workspace.name === parsed.data.defaultWorkspace)
  ) {
    throw new ConfigInvalidError(
      `defaultWorkspace '${parsed.data.defaultWorkspace}' is not configured.`,
      { defaultWorkspace: parsed.data.defaultWorkspace },
    );
  }

  return { configPath, defaultWorkspace: parsed.data.defaultWorkspace, workspaces };
}

export async function loadPublicConfig(options: ConfigLoadOptions = {}): Promise<PublicAppConfig> {
  const config = await loadConfig(options);
  return {
    configPath: config.configPath,
    defaultWorkspace: config.defaultWorkspace,
    workspaces: config.workspaces.map(publicWorkspaceConfig),
  };
}

export function resolveWorkspace(options: {
  config: AppConfig;
  envWorkspace?: string;
  explicitWorkspace?: string;
  repoWorkspace?: string;
}): WorkspaceResolution {
  const candidates = [
    ["explicit", options.explicitWorkspace],
    ["repo", options.repoWorkspace],
    ["env", options.envWorkspace],
    ["default", options.config.defaultWorkspace],
  ] as const;

  for (const [source, name] of candidates) {
    if (!name) continue;
    const workspace = options.config.workspaces.find((entry) => entry.name === name);
    if (!workspace) throw new WorkspaceNotFoundError(name);
    return { source, workspace };
  }

  if (options.config.workspaces.length === 1) {
    const workspace = options.config.workspaces[0];
    if (!workspace) throw new WorkspaceNotResolvedError();
    return { source: "single", workspace };
  }

  throw new WorkspaceNotResolvedError();
}

export async function upsertWorkspaceConfig(
  options: UpsertWorkspaceConfigOptions,
): Promise<UpsertWorkspaceConfigResult> {
  const configPath =
    (await resolveConfigPath(options)) ??
    join(options.home ?? homedir(), ".config", "plane-cli", "config.yaml");
  const raw = existsSync(configPath) ? ((await readRawConfig(configPath)) ?? {}) : {};
  const parsed = parseExistingConfig(raw, configPath);
  const workspaces = {
    ...parsed.workspaces,
    [options.workspace]: {
      apiKey: options.apiKey,
      baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
      displayName: options.displayName,
      workspaceSlug: options.workspaceSlug,
    },
  };
  const nextConfig = {
    defaultWorkspace: options.setDefault
      ? options.workspace
      : (parsed.defaultWorkspace ?? options.workspace),
    workspaces,
  };
  await writeConfigFile(configPath, nextConfig);
  const loaded = await loadConfig({ cwd: options.cwd, env: {}, home: options.home });
  const workspace = loaded.workspaces.find((entry) => entry.name === options.workspace);
  if (!workspace) throw new WorkspaceNotFoundError(options.workspace);
  return {
    configPath,
    defaultWorkspace: loaded.defaultWorkspace,
    workspace: publicWorkspaceConfig(workspace),
  };
}

export async function upsertOAuthWorkspaceConfig(
  options: UpsertOAuthWorkspaceConfigOptions,
): Promise<UpsertWorkspaceConfigResult> {
  const configPath =
    (await resolveConfigPath(options)) ??
    join(options.home ?? homedir(), ".config", "plane-cli", "config.yaml");
  const raw = existsSync(configPath) ? ((await readRawConfig(configPath)) ?? {}) : {};
  const parsed = parseExistingConfig(raw, configPath);
  const workspaces = {
    ...parsed.workspaces,
    [options.workspace]: {
      auth: dropUndefinedDeep(options.auth),
      baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
      displayName: options.displayName,
      workspaceSlug: options.workspaceSlug,
    },
  };
  const nextConfig = {
    defaultWorkspace: options.setDefault
      ? options.workspace
      : (parsed.defaultWorkspace ?? options.workspace),
    workspaces,
  };
  await writeConfigFile(configPath, nextConfig);
  const loaded = await loadConfig({ cwd: options.cwd, env: {}, home: options.home });
  const workspace = loaded.workspaces.find((entry) => entry.name === options.workspace);
  if (!workspace) throw new WorkspaceNotFoundError(options.workspace);
  return {
    configPath,
    defaultWorkspace: loaded.defaultWorkspace,
    workspace: publicWorkspaceConfig(workspace),
  };
}

function publicWorkspaceConfig(workspace: WorkspaceConfig): PublicWorkspaceConfig {
  const hasApiKey = Boolean(
    workspace.apiKey ?? (workspace.auth?.type === "apiKey" ? workspace.auth.apiKey : undefined),
  );
  return {
    authType: workspace.auth?.type ?? (workspace.apiKey ? "apiKey" : undefined),
    baseUrl: workspace.baseUrl,
    displayName: workspace.displayName,
    hasApiKey,
    hasCredentials: hasApiKey || workspace.auth?.type === "oauth",
    name: workspace.name,
    workspaceSlug: workspace.workspaceSlug,
  };
}

async function readRawConfig(configPath: string): Promise<unknown> {
  const raw = await readFile(configPath, "utf8");
  try {
    return configPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  } catch (error) {
    throw new ConfigInvalidError("Invalid plane-cli config syntax.", {
      parseMessage: error instanceof Error ? error.message : String(error),
      path: configPath,
    });
  }
}

function parseExistingConfig(raw: unknown, configPath: string) {
  const rawObject = typeof raw === "object" && raw !== null ? raw : {};
  const rawConfig = "workspaces" in rawObject ? rawObject : { ...rawObject, workspaces: {} };
  const parsed = configSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new ConfigInvalidError("Invalid plane-cli config file.", {
      issues: parsed.error.issues,
      path: configPath,
    });
  }
  return parsed.data;
}

async function writeConfigFile(configPath: string, config: unknown): Promise<void> {
  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true });
  const body = configPath.endsWith(".json")
    ? `${JSON.stringify(config, null, 2)}\n`
    : YAML.stringify(config);
  const tempPath = join(
    configDir,
    `.${basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await writeFile(tempPath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function envBaseUrlName(workspace: string): string {
  return `PLANE_BASE_URL_${workspace.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

function isRepoLocalConfigPath(configPath: string, options: ConfigLoadOptions): boolean {
  return configSearchPaths(options)
    .slice(0, 2)
    .some((repoPath) => resolve(repoPath) === resolve(configPath));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function shouldApplyEnvApiKey(options: {
  envApiKey: string | undefined;
  envBaseUrl: string | undefined;
  fileBaseUrl: string;
  repoLocalConfig: boolean;
}): boolean {
  if (!options.envApiKey) return false;
  if (!options.repoLocalConfig) return true;
  if (options.envBaseUrl !== undefined) return true;
  return options.fileBaseUrl === DEFAULT_BASE_URL;
}

function dropUndefinedDeep<T>(input: T): T {
  if (Array.isArray(input)) return input.map((item) => dropUndefinedDeep(item)) as T;
  if (typeof input !== "object" || input === null) return input;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, dropUndefinedDeep(value)]),
  ) as T;
}
