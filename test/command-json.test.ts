import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plane-cli-command-test-"));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("command JSON output", () => {
  test("emits stable JSON for project list", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn(async () =>
      response({ next_page_results: false, results: [{ id: "P1", name: "Web" }] }),
    );

    const result = await runCli(["project", "list", "--json"], {
      cwd,
      env: {},
      fetch,
      home: cwd,
    });

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        JSON.stringify({ ok: true, workspace: "prod", data: [{ id: "P1", name: "Web" }] }) + "\n",
    });
  });

  test("honors explicit workspace on normal commands before env/default routing", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      [
        "defaultWorkspace: default",
        "workspaces:",
        "  default:",
        "    workspaceSlug: default-slug",
        "    apiKey: default-secret",
        "  explicit:",
        "    workspaceSlug: explicit-slug",
        "    apiKey: explicit-secret",
        "  env:",
        "    workspaceSlug: env-slug",
        "    apiKey: env-secret",
      ].join("\n"),
    );
    const fetch = vi.fn(async () =>
      response({ next_page_results: false, results: [{ id: "P1", name: "Web" }] }),
    );

    const result = await runCli(["--workspace", "explicit", "project", "list", "--json"], {
      cwd,
      env: { PLANE_WORKSPACE: "env" },
      fetch,
      home: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      workspace: "explicit",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.plane.so/api/v1/workspaces/explicit-slug/projects/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "explicit-secret" }),
      }),
    );
  });

  test("resolves config show without applying the show alias", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );

    const result = await runCli(["config", "show", "--json"], {
      cwd,
      env: {},
      home: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { defaultWorkspace: "prod", workspaces: [{ name: "prod", workspaceSlug: "acme" }] },
      ok: true,
    });
    expect(result.stdout).not.toContain("plane_api_secret");
  });

  test("uses repo project hint for issue create and resolves project names", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    await writeFile(join(cwd, ".plane-cli-workspace"), "workspace: prod\nproject: Web\n");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID", name: "Fix login", sequence_id: 123 }));

    const result = await runCli(["issue", "create", "--title", "Fix login", "--json"], {
      cwd,
      env: {},
      fetch,
      home: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { id: "ISSUE-ID", identifier: "WEB-123", name: "Fix login" },
      ok: true,
      workspace: "prod",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/",
    );
  });

  test("preserves equals signs in inline flag values", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID", name: "Fix login", sequence_id: 123 }));

    const result = await runCli(
      [
        "issue",
        "create",
        "--project",
        "Web",
        "--title",
        "Fix login",
        "--description=a=b",
        "--json",
      ],
      {
        cwd,
        env: {},
        fetch,
        home: cwd,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        description_html: "a=b",
        description_stripped: "a=b",
        name: "Fix login",
      }),
      method: "POST",
    });
  });

  test("unknown commands return machine-readable validation errors in JSON mode", async () => {
    const result = await runCli(["nope", "--json"], { env: {} });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Unknown command: nope",
      },
      ok: false,
    });
  });

  test("auth api-key discovers workspace slug before saving config", async () => {
    const home = await tempDir();
    const fetch = vi.fn(async () =>
      response([{ id: "WORKSPACE-ID", name: "Zoo", slug: "engineering" }]),
    );

    const result = await runCli(
      [
        "auth",
        "api-key",
        "--workspace",
        "Zoo",
        "--base-url",
        "https://plane.thezoo.house",
        "--api-key",
        "plane_api_secret",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { workspace: { name: "Zoo", workspaceSlug: "engineering" } },
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://plane.thezoo.house/api/workspaces/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "plane_api_secret" }),
      }),
    );
  });

  test("auth api-key accepts workspace slug as an explicit override", async () => {
    const home = await tempDir();
    const fetch = vi.fn();

    const result = await runCli(
      [
        "auth",
        "api-key",
        "--workspace",
        "zoo",
        "--workspace-slug",
        "engineering",
        "--base-url",
        "https://plane.thezoo.house",
        "--api-key",
        "plane_api_secret",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    expect(result.exitCode).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { workspace: { workspaceSlug: "engineering" } },
      ok: true,
    });
  });

  test("auth api-key default=false does not replace the existing default workspace", async () => {
    const home = await tempDir();
    await mkdir(join(home, ".config", "plane-cli"), { recursive: true });
    await writeFile(
      join(home, ".config", "plane-cli", "config.yaml"),
      [
        "defaultWorkspace: prod",
        "workspaces:",
        "  prod:",
        "    workspaceSlug: acme",
        "    apiKey: plane_api_secret",
      ].join("\n"),
    );
    const fetch = vi.fn();

    const result = await runCli(
      [
        "auth",
        "api-key",
        "--workspace",
        "staging",
        "--workspace-slug",
        "staging-slug",
        "--api-key",
        "plane_api_staging",
        "--default=false",
        "--json",
      ],
      { env: {}, fetch, home },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { defaultWorkspace: "prod", workspace: { name: "staging" } },
      ok: true,
    });
  });

  test("fetches work item type schema for LLM field discovery", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ fields: [{ key: "state", type: "uuid" }] }));

    const result = await runCli(
      ["issue", "type-schema", "--project", "Web", "--include", "members,labels", "--json"],
      {
        cwd,
        env: {},
        fetch,
        home: cwd,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { fields: [{ key: "state", type: "uuid" }] },
      ok: true,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-item-types/schema/?include=members%2Clabels",
    );
  });

  test("uses Plane search API for issue search", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ issues: [{ id: "ISSUE-ID", name: "Login bug" }] }));

    const result = await runCli(
      ["issue", "search", "--project", "Web", "--query", "login", "--limit", "10", "--json"],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { issues: [{ id: "ISSUE-ID", name: "Login bug" }] },
      ok: true,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/work-items/search/?limit=10&project_id=PROJECT-ID&search=login",
    );
  });

  test("forwards issue list assignee and label filters", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ next_page_results: false, results: [{ id: "ISSUE-ID" }] }));

    const result = await runCli(
      [
        "issue",
        "list",
        "--project",
        "Web",
        "--assignee",
        "USER-ID",
        "--label",
        "LABEL-ID",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/?assignee=USER-ID&label=LABEL-ID",
    );
  });

  test("does not forward issue-only filters to non-issue list commands", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const makeFetch = () =>
      vi.fn().mockResolvedValue(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      );
    const dirtyFlags = [
      "--state",
      "STATE-ID",
      "--assignee",
      "USER-ID",
      "--label",
      "LABEL-ID",
      "--json",
    ];

    const projectFetch = makeFetch();
    await runCli(["project", "list", ...dirtyFlags], {
      cwd,
      env: {},
      fetch: projectFetch,
      home: cwd,
    });
    expect(projectFetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/",
    );

    const memberFetch = makeFetch();
    await runCli(["member", "list", ...dirtyFlags], {
      cwd,
      env: {},
      fetch: memberFetch,
      home: cwd,
    });
    expect(memberFetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/members/",
    );

    const cycleFetch = makeFetch();
    await runCli(["cycle", "list", "--project", "Web", ...dirtyFlags], {
      cwd,
      env: {},
      fetch: cycleFetch,
      home: cwd,
    });
    expect(cycleFetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/cycles/",
    );

    const linkFetch = makeFetch();
    await runCli(["issue", "link", "list", "ISSUE-ID", "--project", "Web", ...dirtyFlags], {
      cwd,
      env: {},
      fetch: linkFetch,
      home: cwd,
    });
    expect(linkFetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/links/",
    );

    const attachmentFetch = makeFetch();
    await runCli(["issue", "attachment", "list", "ISSUE-ID", "--project", "Web", ...dirtyFlags], {
      cwd,
      env: {},
      fetch: attachmentFetch,
      home: cwd,
    });
    expect(attachmentFetch.mock.calls.at(-1)?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/",
    );
  });

  test("posts advanced search filters to Plane", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn(async () => response([[{ id: "ISSUE-ID", name: "Login bug" }]]));

    const result = await runCli(
      [
        "issue",
        "advanced-search",
        "--query",
        "login",
        "--filters-json",
        '{"priority":["high"]}',
        "--workspace-search",
        "--limit",
        "5",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: [[{ id: "ISSUE-ID" }]], ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.plane.so/api/v1/workspaces/acme/work-items/advanced-search/",
      expect.objectContaining({
        body: JSON.stringify({
          filters: { priority: ["high"] },
          limit: 5,
          query: "login",
          workspace_search: true,
        }),
        method: "POST",
      }),
    );
  });

  test("resolves cycles list through the documented alias", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(
        response({ next_page_results: false, results: [{ id: "CYCLE-ID", name: "Sprint 1" }] }),
      );

    const result = await runCli(["cycles", "list", "--project", "Web", "--json"], {
      cwd,
      env: {},
      fetch,
      home: cwd,
    });

    expect(result.exitCode).toBe(0);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/cycles/",
    );
  });

  test("returns validation JSON for malformed inline advanced search filters", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn();

    const result = await runCli(["issue", "advanced-search", "--filters-json", "{", "--json"], {
      cwd,
      env: {},
      fetch,
      home: cwd,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Search filters must be valid JSON.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("returns validation JSON for malformed file advanced search filters", async () => {
    const cwd = await tempDir();
    const filtersPath = join(cwd, "filters.json");
    await writeFile(filtersPath, "{");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi.fn();

    const result = await runCli(
      ["issue", "advanced-search", "--filters-file", filtersPath, "--json"],
      {
        cwd,
        env: {},
        fetch,
        home: cwd,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Search filters must be valid JSON.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("does not treat confirm=false as destructive confirmation", async () => {
    const fetch = vi.fn();

    const result = await runCli(
      ["issue", "delete", "ISSUE-ID", "--project", "Web", "--confirm=false", "--json"],
      {
        env: {},
        fetch,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Destructive commands require --confirm.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("allows explicit confirm=true for destructive commands", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID" }));

    const result = await runCli(
      ["issue", "delete", "ISSUE-ID", "--project", "Web", "--confirm=true", "--json"],
      {
        cwd,
        env: {},
        fetch,
        home: cwd,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  test("documents redirect-uri in oauth login help", async () => {
    const result = await runCli(["--help"], { env: {} });

    expect(result.stdout).toContain(
      "auth oauth login --workspace name --base-url url --client-id id --client-secret secret [--redirect-port 8717] [--redirect-uri uri] [--scope scope] [--workspace-slug slug] [--default]",
    );
  });

  test("creates and lists work item links", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: "LINK-ID", title: "PR", url: "https://example.com/pr" }),
      )
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "LINK-ID", title: "PR", url: "https://example.com/pr" }],
        }),
      );

    const create = await runCli(
      [
        "issue",
        "link",
        "create",
        "ISSUE-ID",
        "--project",
        "Web",
        "--url",
        "https://example.com/pr",
        "--title",
        "PR",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );
    const list = await runCli(["issue", "link", "list", "ISSUE-ID", "--project", "Web", "--json"], {
      cwd,
      env: {},
      fetch,
      home: cwd,
    });

    expect(create.exitCode).toBe(0);
    expect(list.exitCode).toBe(0);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/links/",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ title: "PR", url: "https://example.com/pr" }),
      method: "POST",
    });
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/?per_page=100",
    );
    expect(fetch.mock.calls[3]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/links/",
    );
  });

  test("requests attachment credentials, uploads file, and completes upload", async () => {
    const cwd = await tempDir();
    const filePath = join(cwd, "trace.txt");
    await writeFile(filePath, "trace output");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(
        response({
          fields: { key: "attachments/a/trace.txt", policy: "policy", "x-amz-signature": "sig" },
          id: "ATTACHMENT-ID",
          upload_url: "https://uploads.example.test/",
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockResolvedValueOnce(response({ id: "ATTACHMENT-ID", is_uploaded: true }));

    const result = await runCli(
      [
        "issue",
        "attachment",
        "upload",
        "ISSUE-ID",
        "--project",
        "Web",
        "--file",
        filePath,
        "--type",
        "text/plain",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { attachment: { id: "ATTACHMENT-ID", is_uploaded: true } },
      ok: true,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ name: "trace.txt", size: 12, type: "text/plain" }),
      method: "POST",
    });
    expect(fetch.mock.calls[2]?.[0]).toBe("https://uploads.example.test/");
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[3]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/ATTACHMENT-ID/",
    );
  });

  test("completes attachment uploads with a standalone top-level asset_id", async () => {
    const cwd = await tempDir();
    const filePath = join(cwd, "asset.txt");
    await writeFile(filePath, "asset output");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
        }),
      )
      .mockResolvedValueOnce(
        response({
          asset_id: "ASSET-ID",
          fields: { key: "attachments/a/asset.txt" },
          upload_url: "https://uploads.example.test/asset",
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockResolvedValueOnce(response({ id: "ASSET-ID", is_uploaded: true }));

    const result = await runCli(
      [
        "issue",
        "attachment",
        "upload",
        "ISSUE-ID",
        "--project",
        "Web",
        "--file",
        filePath,
        "--type",
        "text/plain",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(fetch.mock.calls[3]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/ASSET-ID/",
    );
  });

  test("completes attachment uploads using credential ID precedence", async () => {
    const cwd = await tempDir();
    const filePath = join(cwd, "asset.txt");
    await writeFile(filePath, "asset output");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );

    const cases = [
      {
        credentials: {
          asset: { id: "NESTED-ASSET-ID" },
          asset_id: "ASSET-ID",
          attachment: { id: "NESTED-ATTACHMENT-ID" },
          attachment_id: "ATTACHMENT-ID",
          id: "ID",
        },
        expectedId: "ID",
      },
      {
        credentials: {
          asset: { id: "NESTED-ASSET-ID" },
          asset_id: "ASSET-ID",
          attachment: { id: "NESTED-ATTACHMENT-ID" },
          attachment_id: "ATTACHMENT-ID",
        },
        expectedId: "ATTACHMENT-ID",
      },
      {
        credentials: {
          asset: { id: "NESTED-ASSET-ID" },
          asset_id: "ASSET-ID",
          attachment: { id: "NESTED-ATTACHMENT-ID" },
        },
        expectedId: "NESTED-ATTACHMENT-ID",
      },
      {
        credentials: {
          asset: { id: "NESTED-ASSET-ID" },
          asset_id: "ASSET-ID",
        },
        expectedId: "ASSET-ID",
      },
      {
        credentials: {
          asset: { id: "NESTED-ASSET-ID" },
        },
        expectedId: "NESTED-ASSET-ID",
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response({
            next_page_results: false,
            results: [{ id: "PROJECT-ID", identifier: "WEB", name: "Web" }],
          }),
        )
        .mockResolvedValueOnce(
          response({
            ...entry.credentials,
            fields: { key: `attachments/a/asset-${index}.txt` },
            upload_url: `https://uploads.example.test/asset-${index}`,
          }),
        )
        .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
        .mockResolvedValueOnce(response({ id: entry.expectedId, is_uploaded: true }));

      const result = await runCli(
        [
          "issue",
          "attachment",
          "upload",
          "ISSUE-ID",
          "--project",
          "Web",
          "--file",
          filePath,
          "--type",
          "text/plain",
          "--json",
        ],
        { cwd, env: {}, fetch, home: cwd },
      );

      expect(result.exitCode).toBe(0);
      expect(fetch.mock.calls[3]?.[0]).toBe(
        `https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/${entry.expectedId}/`,
      );
    }
  });

  test("uploads attachment files with nested upload_data credentials", async () => {
    const cwd = await tempDir();
    const filePath = join(cwd, "notes.md");
    await writeFile(filePath, "# Notes\n");
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "CASA", name: "Casa" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID", sequence_id: 1 }))
      .mockResolvedValueOnce(
        response({
          asset_id: "ASSET-ID",
          asset_url: "https://assets.example.test/notes.md",
          attachment: { id: "ATTACHMENT-ID" },
          upload_data: {
            fields: { key: "attachments/a/notes.md", policy: "policy" },
            url: "https://uploads.example.test/nested",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockResolvedValueOnce(response({ id: "ATTACHMENT-ID", is_uploaded: true }));

    const result = await runCli(
      [
        "issue",
        "attachment",
        "upload",
        "CASA-1",
        "--project",
        "CASA",
        "--file",
        filePath,
        "--name",
        "notes.md",
        "--type",
        "text/markdown",
        "--json",
      ],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { attachment: { id: "ATTACHMENT-ID", is_uploaded: true } },
      ok: true,
    });
    expect(fetch.mock.calls[3]?.[0]).toBe("https://uploads.example.test/nested");
    expect(fetch.mock.calls[3]?.[1]).toMatchObject({ method: "POST" });
    const uploadBody = (fetch.mock.calls[3]?.[1] as RequestInit | undefined)?.body;
    expect(uploadBody).toBeInstanceOf(FormData);
    const uploadForm = uploadBody as FormData;
    expect(uploadForm.get("key")).toBe("attachments/a/notes.md");
    expect(uploadForm.get("policy")).toBe("policy");
    const filePart = uploadForm.get("file");
    expect(filePart).toBeInstanceOf(Blob);
    expect(await (filePart as Blob).text()).toBe("# Notes\n");
    expect(fetch.mock.calls[4]?.[0]).toBe(
      "https://api.plane.so/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/ISSUE-ID/attachments/ATTACHMENT-ID/",
    );
  });

  test("lists attachments from value response envelopes", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, ".plane-cli.yaml"),
      "defaultWorkspace: prod\nworkspaces:\n  prod:\n    workspaceSlug: acme\n    apiKey: plane_api_secret\n",
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          next_page_results: false,
          results: [{ id: "PROJECT-ID", identifier: "CASA", name: "Casa" }],
        }),
      )
      .mockResolvedValueOnce(response({ id: "ISSUE-ID", sequence_id: 1 }))
      .mockResolvedValueOnce(
        response({
          value: [{ id: "ATTACHMENT-ID", name: "notes.md" }],
        }),
      );

    const result = await runCli(
      ["issue", "attachment", "list", "CASA-1", "--project", "CASA", "--json"],
      { cwd, env: {}, fetch, home: cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: [{ id: "ATTACHMENT-ID", name: "notes.md" }],
      ok: true,
    });
  });
});

describe("destructive command JSON guards", () => {
  test.each([
    ["project_archive", ["project", "archive", "PROJECT"]],
    ["project_delete", ["project", "delete", "PROJECT"]],
    ["issue_delete", ["issue", "delete", "ISSUE-ID", "--project", "WEB"]],
    ["issue_link_delete", ["issue", "link", "delete", "LINK-ID", "ISSUE-ID", "--project", "WEB"]],
    [
      "issue_attachment_delete",
      ["issue", "attachment", "delete", "ATTACHMENT-ID", "ISSUE-ID", "--project", "WEB"],
    ],
    ["state_delete", ["state", "delete", "STATE-ID", "--project", "WEB"]],
    ["label_delete", ["label", "delete", "LABEL-ID", "--project", "WEB"]],
    ["module_delete", ["module", "delete", "MODULE-ID", "--project", "WEB"]],
    ["cycle_delete", ["cycle", "delete", "CYCLE-ID", "--project", "WEB"]],
    ["page_delete", ["page", "delete", "PAGE-ID", "--project", "WEB"]],
    ["comment_delete", ["comment", "delete", "COMMENT-ID", "ISSUE-ID", "--project", "WEB"]],
  ])("%s requires --confirm before API access", async (_name, argv) => {
    const fetch = vi.fn();

    const result = await runCli([...argv, "--json"], { env: {}, fetch });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Destructive commands require --confirm.",
      },
      ok: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
