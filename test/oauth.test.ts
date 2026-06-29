import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { PlaneClient } from "../src/lib/plane-client.js";
import {
  buildPlaneOAuthAuthorizeUrl,
  exchangePlaneOAuthToken,
} from "../src/lib/plane-oauth.js";
import type { WorkspaceConfig } from "../src/lib/config.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plane-cli-oauth-test-"));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Plane OAuth", () => {
  test("builds authorization-code URLs for a self-hosted Plane app", () => {
    const url = buildPlaneOAuthAuthorizeUrl({
      baseUrl: "https://plane.thezoo.house/",
      clientId: "client-id",
      redirectUri: "http://127.0.0.1:8717/callback",
      scopes: ["read:workspace", "write:issue"],
      state: "state-token",
    });

    expect(url).toBe(
      "https://plane.thezoo.house/auth/o/authorize-app/?client_id=client-id&redirect_uri=http%3A%2F%2F127.0.0.1%3A8717%2Fcallback&response_type=code&scope=read%3Aworkspace+write%3Aissue&state=state-token",
    );
  });

  test("exchanges bot app installation credentials with Plane OAuth token endpoint", async () => {
    const fetch = vi.fn(async () =>
      response({
        access_token: "bot-token",
        expires_in: 3600,
        scope: "read:workspace write:issue",
        token_type: "Bearer",
      }),
    );

    const token = await exchangePlaneOAuthToken(
      {
        appInstallationId: "installation-id",
        baseUrl: "https://plane.thezoo.house/",
        clientId: "client-id",
        clientSecret: "client-secret",
        grantType: "client_credentials",
      },
      { fetch, now: new Date("2026-06-26T04:00:00.000Z") },
    );

    expect(token).toMatchObject({
      accessToken: "bot-token",
      expiresAt: "2026-06-26T05:00:00.000Z",
      scopes: ["read:workspace", "write:issue"],
      tokenType: "Bearer",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://plane.thezoo.house/auth/o/token/",
      expect.objectContaining({
        body: "grant_type=client_credentials&app_installation_id=installation-id",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Basic Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQ=",
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        method: "POST",
      }),
    );
  });

  test("auth oauth bot discovers workspace slug before saving config", async () => {
    const home = await tempDir();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ access_token: "bot-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        response([
          {
            app_bot: "BOT-ID",
            id: "installation-id",
            status: "installed",
            workspace: "WORKSPACE-ID",
            workspace_detail: { name: "Zoo", slug: "engineering" },
          },
        ]),
      );

    const result = await runCli(
      [
        "auth",
        "oauth",
        "bot",
        "--workspace",
        "Zoo",
        "--base-url",
        "https://plane.thezoo.house",
        "--client-id",
        "client-id",
        "--client-secret",
        "client-secret",
        "--app-installation-id",
        "installation-id",
        "--default",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { workspace: { authType: "oauth", name: "Zoo" } },
      ok: true,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe("https://plane.thezoo.house/auth/o/app-installation/?id=installation-id");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer bot-token" }),
      method: "GET",
    });

    const rawConfig = await readFile(join(home, ".config", "plane-cli", "config.yaml"), "utf8");
    expect(rawConfig).toContain("accessToken: bot-token");
    expect(rawConfig).toContain("appInstallationId: installation-id");
    expect(rawConfig).toContain("workspaceSlug: engineering");
    expect(rawConfig).not.toContain("apiKey:");
  });

  test("auth oauth login accepts the localhost callback and stores the exchanged token", async () => {
    const home = await tempDir();
    const port = 18717;
    const fetch = vi.fn(async () => response({ access_token: "user-token", refresh_token: "refresh-token", token_type: "Bearer" }));

    const run = runCli(
      [
        "auth",
        "oauth",
        "login",
        "--workspace",
        "zoo",
        "--workspace-slug",
        "engineering",
        "--base-url",
        "https://plane.thezoo.house",
        "--client-id",
        "client-id",
        "--client-secret",
        "client-secret",
        "--redirect-port",
        String(port),
        "--state",
        "test-state",
        "--no-open",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    await waitForCallbackServer(port);
    const callback = await fetchThis(`http://127.0.0.1:${port}/callback?code=user-code&state=test-state`);
    expect(callback.status).toBe(200);

    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { workspace: { authType: "oauth", name: "zoo" } },
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://plane.thezoo.house/auth/o/token/",
      expect.objectContaining({
        body: "grant_type=authorization_code&client_id=client-id&client_secret=client-secret&code=user-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A18717%2Fcallback",
      }),
    );
  });

  test("includes form credentials when exchanging authorization codes", async () => {
    const fetch = vi.fn(async () => response({ access_token: "user-token", token_type: "Bearer" }));

    await exchangePlaneOAuthToken(
      {
        baseUrl: "https://plane.thezoo.house/",
        clientId: "client-id",
        clientSecret: "client-secret",
        code: "user-code",
        grantType: "authorization_code",
        redirectUri: "http://127.0.0.1:8717/callback",
      },
      { fetch },
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://plane.thezoo.house/auth/o/token/",
      expect.objectContaining({
        body: "grant_type=authorization_code&client_id=client-id&client_secret=client-secret&code=user-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8717%2Fcallback",
      }),
    );
  });

  test("auth oauth code exchanges a pasted authorization code", async () => {
    const home = await tempDir();
    const fetch = vi.fn(async () => response({ access_token: "user-token", refresh_token: "refresh-token", token_type: "Bearer" }));

    const result = await runCli(
      [
        "auth",
        "oauth",
        "code",
        "--workspace",
        "zoo",
        "--workspace-slug",
        "engineering",
        "--base-url",
        "https://plane.thezoo.house",
        "--client-id",
        "client-id",
        "--client-secret",
        "client-secret",
        "--redirect-uri",
        "http://127.0.0.1:8717/callback",
        "--code",
        "user-code",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { workspace: { authType: "oauth", name: "zoo" } },
      ok: true,
    });
  });

  test("PlaneClient sends bearer tokens for oauth workspaces", async () => {
    const workspace: WorkspaceConfig = {
      auth: { accessToken: "oauth-token", type: "oauth" },
      baseUrl: "https://plane.thezoo.house",
      name: "zoo",
      workspaceSlug: "engineering",
    };
    const fetch = vi.fn(async () => response({ id: "me" }));
    const client = new PlaneClient(workspace, { fetch });

    await client.getCurrentUser();

    expect(fetch).toHaveBeenCalledWith(
      "https://plane.thezoo.house/api/v1/users/me/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
        }),
      }),
    );
  });
});

async function waitForCallbackServer(port: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    try {
      await fetchThis(`http://127.0.0.1:${port}/not-callback`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Callback server did not start.");
}

async function fetchThis(url: string): Promise<Response> {
  return globalThis.fetch(url);
}
