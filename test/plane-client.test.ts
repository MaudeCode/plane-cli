import { describe, expect, test, vi } from "vitest";
import { PlaneClient, type FetchLike } from "../src/lib/plane-client.js";
import type { WorkspaceConfig } from "../src/lib/config.js";

const workspace: WorkspaceConfig = {
  apiKey: "plane_api_secret",
  baseUrl: "https://example.test/",
  name: "prod",
  workspaceSlug: "acme",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    status,
  });
}

describe("PlaneClient", () => {
  test("sends X-API-Key and normalized JSON payloads", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "ISSUE-ID", name: "Fix login" }));
    const client = new PlaneClient(workspace, { fetch });

    await expect(
      client.createWorkItem("PROJECT-ID", {
        assignees: ["USER-ID"],
        description: "Markdown body",
        name: "Fix login",
        priority: "high",
      }),
    ).resolves.toMatchObject({ id: "ISSUE-ID" });

    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/v1/workspaces/acme/projects/PROJECT-ID/work-items/",
      expect.objectContaining({
        body: JSON.stringify({
          assignees: ["USER-ID"],
          description_html: "Markdown body",
          description_stripped: "Markdown body",
          name: "Fix login",
          priority: "high",
        }),
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "plane_api_secret",
        }),
        method: "POST",
      }),
    );
  });

  test("paginates list responses until next_page_results is false", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ next_cursor: "2:1:0", next_page_results: true, results: [{ id: "1" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ next_page_results: false, results: [{ id: "2" }] }));
    const client = new PlaneClient(workspace, { fetch });

    await expect(client.listProjects({ per_page: 2 })).resolves.toEqual([{ id: "1" }, { id: "2" }]);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://example.test/api/v1/workspaces/acme/projects/?per_page=2",
      "https://example.test/api/v1/workspaces/acme/projects/?per_page=2&cursor=2%3A1%3A0",
    ]);
  });

  test("rejects pagination when Plane repeats a cursor while claiming more pages", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ next_cursor: "2:1:0", next_page_results: true, results: [{ id: "1" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ next_cursor: "2:1:0", next_page_results: true, results: [{ id: "2" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ next_page_results: false, results: [{ id: "3" }] }));
    const client = new PlaneClient(workspace, { fetch });

    await expect(client.listProjects({ per_page: 2 })).rejects.toMatchObject({
      code: "API_ERROR",
      details: {
        cursor: "2:1:0",
        path: "/api/v1/workspaces/acme/projects/",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("gets a work item by Plane identifier without requiring a project UUID", async () => {
    const fetch = vi.fn(async () => jsonResponse({ id: "ISSUE-ID", sequence_id: 123 }));
    const client = new PlaneClient(workspace, { fetch });

    await client.getWorkItemByIdentifier("WEB-123");

    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/v1/workspaces/acme/work-items/WEB-123/",
      expect.any(Object),
    );
  });

  test("adds module items through the documented module-issues endpoint", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new PlaneClient(workspace, { fetch });

    await client.addItemToContainer("PROJECT-ID", "modules", "MODULE-ID", ["ISSUE-1", "ISSUE-2"]);

    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/v1/workspaces/acme/projects/PROJECT-ID/modules/MODULE-ID/module-issues/",
      expect.objectContaining({
        body: JSON.stringify({ issues: ["ISSUE-1", "ISSUE-2"] }),
        method: "POST",
      }),
    );
  });

  test("lists and removes cycle items through the documented cycle-issues endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ next_page_results: false, results: [{ id: "ISSUE-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new PlaneClient(workspace, { fetch });

    await expect(client.listContainerItems("PROJECT-ID", "cycles", "CYCLE-ID")).resolves.toEqual([
      { id: "ISSUE-1" },
    ]);
    await client.removeItemFromContainer("PROJECT-ID", "cycles", "CYCLE-ID", "ISSUE-1");

    expect(fetch.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      [
        "https://example.test/api/v1/workspaces/acme/projects/PROJECT-ID/cycles/CYCLE-ID/cycle-issues/",
        "GET",
      ],
      [
        "https://example.test/api/v1/workspaces/acme/projects/PROJECT-ID/cycles/CYCLE-ID/cycle-issues/ISSUE-1/",
        "DELETE",
      ],
    ]);
  });

  test("rejects plaintext base URLs for non-local hosts", async () => {
    const fetch = vi.fn<FetchLike>(async () => jsonResponse({ results: [] }));
    const client = new PlaneClient(
      {
        ...workspace,
        baseUrl: "http://example.test/",
      },
      { fetch },
    );

    await expect(client.listProjects()).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("allows plaintext base URLs for localhost and private-network development", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return jsonResponse({ results: [] });
    };
    const localhostClient = new PlaneClient({ ...workspace, baseUrl: "http://localhost:3000/" }, { fetch });
    const privateClient = new PlaneClient({ ...workspace, baseUrl: "http://192.168.1.10/" }, { fetch });

    await localhostClient.listProjects();
    await privateClient.listProjects();

    expect(urls).toEqual([
      "http://localhost:3000/api/v1/workspaces/acme/projects/",
      "http://192.168.1.10/api/v1/workspaces/acme/projects/",
    ]);
  });

  test("turns non-2xx API responses into structured errors", async () => {
    const fetch = vi.fn(async () => jsonResponse({ detail: "Invalid token" }, 401));
    const client = new PlaneClient(workspace, { fetch });

    await expect(client.listProjects()).rejects.toMatchObject({
      code: "PLANE_AUTH_FAILED",
      details: { status: 401 },
    });
  });
});
