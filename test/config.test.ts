import { chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  envApiKeyName,
  loadConfig,
  loadPublicConfig,
  loadRepoWorkspaceHint,
  resolveWorkspace,
  upsertOAuthWorkspaceConfig,
  upsertWorkspaceConfig,
} from "../src/lib/config.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plane-cli-test-"));
}

describe("config", () => {
  test("loads workspace-scoped config and applies namespaced env API keys", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      [
        "defaultWorkspace: prod",
        "workspaces:",
        "  prod:",
        "    workspaceSlug: acme",
        "    baseUrl: https://api.plane.so",
        "    apiKey: file-secret",
      ].join("\n"),
    );

    const config = await loadConfig({
      cwd,
      env: { [envApiKeyName("prod")]: "env-secret" },
      home: cwd,
    });

    expect(config.workspaces[0]).toMatchObject({
      name: "prod",
      workspaceSlug: "acme",
      baseUrl: "https://api.plane.so",
      apiKey: "env-secret",
    });
  });

  test("rejects malformed YAML config as CONFIG_INVALID", async () => {
    const cwd = await tempDir();
    const configPath = join(cwd, ".plane-cli.yaml");
    await writeFile(configPath, "workspaces:\n  prod: [\n");

    await expect(loadConfig({ cwd, home: cwd })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: {
        path: configPath,
        parseMessage: expect.any(String),
      },
    });
  });

  test("rejects malformed JSON config as CONFIG_INVALID", async () => {
    const cwd = await tempDir();
    const configPath = join(cwd, ".plane-cli.json");
    await writeFile(configPath, "{");

    await expect(loadConfig({ cwd, home: cwd })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: {
        path: configPath,
        parseMessage: expect.any(String),
      },
    });
  });

  test("does not send env API keys to repo-local custom base URLs", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      [
        "defaultWorkspace: prod",
        "workspaces:",
        "  prod:",
        "    workspaceSlug: acme",
        "    baseUrl: https://plane.attacker.example",
      ].join("\n"),
    );

    await expect(
      loadConfig({
        cwd,
        env: { [envApiKeyName("prod")]: "env-secret" },
        home: cwd,
      }),
    ).rejects.toMatchObject({
      code: "MISSING_PLANE_API_KEY",
    });
  });

  test("allows env API keys for repo-local configs when base URL also comes from env", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      [
        "defaultWorkspace: prod",
        "workspaces:",
        "  prod:",
        "    workspaceSlug: acme",
        "    baseUrl: https://plane.attacker.example",
      ].join("\n"),
    );

    await expect(
      loadConfig({
        cwd,
        env: {
          [envApiKeyName("prod")]: "env-secret",
          PLANE_BASE_URL_PROD: "https://plane.trusted.example/",
        },
        home: cwd,
      }),
    ).resolves.toMatchObject({
      workspaces: [
        {
          apiKey: "env-secret",
          baseUrl: "https://plane.trusted.example",
          name: "prod",
        },
      ],
    });
  });

  test("redacts API keys from public config", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      [
        "defaultWorkspace: personal",
        "workspaces:",
        "  personal:",
        "    workspaceSlug: me",
        "    apiKey: plane_api_secret",
      ].join("\n"),
    );

    await expect(loadPublicConfig({ cwd, home: cwd })).resolves.toEqual({
      configPath: join(cwd, ".plane-cli.yaml"),
      defaultWorkspace: "personal",
      workspaces: [
        {
          authType: "apiKey",
          baseUrl: "https://api.plane.so",
          displayName: undefined,
          hasCredentials: true,
          hasApiKey: true,
          name: "personal",
          workspaceSlug: "me",
        },
      ],
    });
  });

  test("loads nearest repo workspace and project hint", async () => {
    const root = await tempDir();
    const child = join(root, "a", "b");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, ".plane-cli-workspace"), "workspace: prod\nproject: Web\n");

    await expect(loadRepoWorkspaceHint({ cwd: child })).resolves.toEqual({
      path: join(root, ".plane-cli-workspace"),
      project: "Web",
      workspace: "prod",
    });
  });

  test("repo workspace hints still select env-backed home config workspaces", async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    await writeFile(join(cwd, ".plane-cli-workspace"), "prod\n");
    await mkdir(join(home, ".config", "plane-cli"), { recursive: true });
    await writeFile(
      join(home, ".config", "plane-cli", "config.yaml"),
      [
        "workspaces:",
        "  prod:",
        "    workspaceSlug: acme",
      ].join("\n"),
    );

    const hint = await loadRepoWorkspaceHint({ cwd });
    const config = await loadConfig({
      cwd,
      env: { [envApiKeyName("prod")]: "env-secret" },
      home,
    });

    expect(resolveWorkspace({ config, repoWorkspace: hint?.workspace })).toMatchObject({
      source: "repo",
      workspace: {
        apiKey: "env-secret",
        baseUrl: "https://api.plane.so",
        name: "prod",
      },
    });
  });

  test("resolves explicit workspace before repo and default workspace", async () => {
    const config = {
      defaultWorkspace: "default",
      workspaces: [
        { apiKey: "one", baseUrl: "https://api.plane.so", name: "default", workspaceSlug: "d" },
        { apiKey: "two", baseUrl: "https://api.plane.so", name: "repo", workspaceSlug: "r" },
        { apiKey: "three", baseUrl: "https://api.plane.so", name: "explicit", workspaceSlug: "e" },
      ],
    };

    expect(resolveWorkspace({ config, explicitWorkspace: "explicit", repoWorkspace: "repo" })).toMatchObject({
      source: "explicit",
      workspace: { name: "explicit" },
    });
  });

  test("writes a default config file for auth api-key", async () => {
    const home = await tempDir();
    const result = await upsertWorkspaceConfig({
      apiKey: "plane_api_secret",
      baseUrl: "https://api.plane.so",
      home,
      setDefault: true,
      workspace: "personal",
      workspaceSlug: "my-team",
    });

    expect(result.configPath).toBe(join(home, ".config", "plane-cli", "config.yaml"));
    expect(result.workspace).toEqual({
      baseUrl: "https://api.plane.so",
      displayName: undefined,
      hasCredentials: true,
      hasApiKey: true,
      authType: "apiKey",
      name: "personal",
      workspaceSlug: "my-team",
    });
  });

  test("tightens existing config file permissions when writing credentials", async () => {
    const home = await tempDir();
    const configPath = join(home, ".config", "plane-cli", "config.yaml");
    await mkdir(join(home, ".config", "plane-cli"), { recursive: true });
    await writeFile(
      configPath,
      [
        "defaultWorkspace: old",
        "workspaces:",
        "  old:",
        "    workspaceSlug: old-team",
        "    apiKey: old-secret",
      ].join("\n"),
      { mode: 0o644 },
    );
    await chmod(configPath, 0o644);
    const before = await stat(configPath);

    await upsertWorkspaceConfig({
      apiKey: "plane_api_secret",
      home,
      workspace: "personal",
      workspaceSlug: "my-team",
    });

    const after = await stat(configPath);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino);
  });

  test("writes oauth credentials and redacts token details from public config", async () => {
    const home = await tempDir();

    const result = await upsertOAuthWorkspaceConfig({
      auth: {
        accessToken: "access-token",
        appInstallationId: "installation-id",
        clientId: "client-id",
        clientSecret: "client-secret",
        expiresAt: "2026-06-26T05:00:00.000Z",
        flow: "client_credentials",
        tokenType: "Bearer",
        type: "oauth",
      },
      baseUrl: "https://plane.thezoo.house/",
      home,
      setDefault: true,
      workspace: "zoo",
      workspaceSlug: "engineering",
    });

    expect(result.workspace).toEqual({
      authType: "oauth",
      baseUrl: "https://plane.thezoo.house",
      displayName: undefined,
      hasCredentials: true,
      hasApiKey: false,
      name: "zoo",
      workspaceSlug: "engineering",
    });

    await expect(loadConfig({ cwd: home, env: {}, home })).resolves.toMatchObject({
      workspaces: [
        {
          auth: {
            accessToken: "access-token",
            appInstallationId: "installation-id",
            clientId: "client-id",
            clientSecret: "client-secret",
            type: "oauth",
          },
          baseUrl: "https://plane.thezoo.house",
          name: "zoo",
        },
      ],
    });
    await expect(loadPublicConfig({ cwd: home, home })).resolves.toMatchObject({
      workspaces: [{ authType: "oauth", hasApiKey: false, hasCredentials: true, name: "zoo" }],
    });
  });
});
