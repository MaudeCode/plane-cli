import { AppError, NotFoundError, exitCodes } from "./errors.js";
import type { WorkspaceConfig } from "./config.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type JsonObject = Record<string, unknown>;
export type JsonValue = JsonObject | JsonValue[] | string | number | boolean | null;
export type Query = Record<string, string | number | boolean | undefined>;

export class PlaneClient {
  private readonly fetch: FetchLike;
  readonly workspace: WorkspaceConfig;

  constructor(workspace: WorkspaceConfig, options: { fetch?: FetchLike } = {}) {
    this.workspace = workspace;
    this.fetch = options.fetch ?? fetch;
  }

  async listProjects(query: Query = {}): Promise<JsonObject[]> {
    return this.paginate(`/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/`, query);
  }

  async getProject(projectId: string, query: Query = {}): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/`,
      {
        query,
      },
    );
  }

  async createProject(input: JsonObject): Promise<JsonObject> {
    return this.request("POST", `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/`, {
      body: input,
    });
  }

  async updateProject(projectId: string, input: JsonObject): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/`,
      {
        body: input,
      },
    );
  }

  async archiveProject(projectId: string): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/archive/`,
    );
  }

  async unarchiveProject(projectId: string): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/unarchive/`,
    );
  }

  async deleteProject(projectId: string): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/`,
    );
  }

  async listWorkItems(projectId: string, query: Query = {}): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/`,
      query,
    );
  }

  async searchWorkItems(query: Query): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/work-items/search/`,
      {
        query,
      },
    );
  }

  async advancedSearchWorkItems(input: JsonObject): Promise<JsonValue> {
    return this.requestAny(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/work-items/advanced-search/`,
      {
        body: dropUndefined(input),
      },
    );
  }

  async getWorkItemByIdentifier(identifier: string, query: Query = {}): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/work-items/${identifier.toUpperCase()}/`,
      { query },
    );
  }

  async getWorkItem(projectId: string, issueId: string, query: Query = {}): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
      { query },
    );
  }

  async createWorkItem(projectId: string, input: JsonObject): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/`,
      { body: normalizeWorkItemInput(input) },
    );
  }

  async updateWorkItem(projectId: string, issueId: string, input: JsonObject): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
      { body: normalizeWorkItemInput(input) },
    );
  }

  async deleteWorkItem(projectId: string, issueId: string): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
    );
  }

  async listLinks(projectId: string, issueId: string, query: Query = {}): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/links/`,
      query,
    );
  }

  async getLink(
    projectId: string,
    issueId: string,
    linkId: string,
    query: Query = {},
  ): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/links/${linkId}/`,
      { query },
    );
  }

  async createLink(projectId: string, issueId: string, input: JsonObject): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/links/`,
      { body: dropUndefined(input) },
    );
  }

  async updateLink(
    projectId: string,
    issueId: string,
    linkId: string,
    input: JsonObject,
  ): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/links/${linkId}/`,
      { body: dropUndefined(input) },
    );
  }

  async deleteLink(projectId: string, issueId: string, linkId: string): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/links/${linkId}/`,
    );
  }

  async getWorkItemTypeSchema(projectId: string, query: Query = {}): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-item-types/schema/`,
      { query },
    );
  }

  async listWorkItemTypes(projectId: string, query: Query = {}): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-item-types/`,
      query,
    );
  }

  async listResource(
    projectId: string,
    resource: ProjectResource,
    query: Query = {},
  ): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/`,
      query,
    );
  }

  async createResource(
    projectId: string,
    resource: ProjectResource,
    input: JsonObject,
  ): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/`,
      { body: input },
    );
  }

  async updateResource(
    projectId: string,
    resource: ProjectResource,
    resourceId: string,
    input: JsonObject,
  ): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/${resourceId}/`,
      { body: input },
    );
  }

  async deleteResource(
    projectId: string,
    resource: ProjectResource,
    resourceId: string,
  ): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/${resourceId}/`,
    );
  }

  async addItemToContainer(
    projectId: string,
    resource: "cycles" | "modules",
    resourceId: string,
    workItemIds: string[],
  ): Promise<JsonObject> {
    const segment = containerIssueSegment(resource);
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/${resourceId}/${segment}/`,
      { body: { issues: workItemIds } },
    );
  }

  async removeItemFromContainer(
    projectId: string,
    resource: "cycles" | "modules",
    resourceId: string,
    workItemId: string,
  ): Promise<JsonObject> {
    const segment = containerIssueSegment(resource);
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/${resourceId}/${segment}/${workItemId}/`,
    );
  }

  async listContainerItems(
    projectId: string,
    resource: "cycles" | "modules",
    resourceId: string,
  ): Promise<JsonObject[]> {
    const segment = containerIssueSegment(resource);
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/${resource}/${resourceId}/${segment}/`,
    );
  }

  async listComments(projectId: string, issueId: string): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/comments/`,
    );
  }

  async listAttachments(
    projectId: string,
    issueId: string,
    query: Query = {},
  ): Promise<JsonObject[]> {
    return this.paginate(
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/`,
      query,
    );
  }

  async getAttachment(
    projectId: string,
    issueId: string,
    attachmentId: string,
  ): Promise<JsonObject> {
    return this.request(
      "GET",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/${attachmentId}/`,
    );
  }

  async requestAttachmentUpload(
    projectId: string,
    issueId: string,
    input: JsonObject,
  ): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/`,
      { body: dropUndefined(input) },
    );
  }

  async completeAttachmentUpload(
    projectId: string,
    issueId: string,
    attachmentId: string,
  ): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/${attachmentId}/`,
      { body: { is_uploaded: true } },
    );
  }

  async updateAttachment(
    projectId: string,
    issueId: string,
    attachmentId: string,
    input: JsonObject,
  ): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/${attachmentId}/`,
      { body: dropUndefined(input) },
    );
  }

  async deleteAttachment(
    projectId: string,
    issueId: string,
    attachmentId: string,
  ): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/attachments/${attachmentId}/`,
    );
  }

  async uploadAttachmentFile(
    credentials: JsonObject,
    file: { bytes: Uint8Array; name: string; type?: string },
  ): Promise<JsonObject> {
    const uploadUrl = extractUploadUrl(credentials);
    const fields = extractUploadFields(credentials);
    const form = new FormData();
    const type = file.type || stringField(fields, "Content-Type") || "application/octet-stream";

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null) form.append(key, String(value));
    }
    if (!Object.hasOwn(fields, "Content-Type")) form.append("Content-Type", type);
    const bytes = file.bytes.slice().buffer;
    form.append("file", new Blob([bytes], { type }), file.name);

    const response = await this.fetch(uploadUrl, { body: form, method: "POST" });
    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, uploaded: true };
    }
    const body = await response.text();
    throw new AppError(
      "API_ERROR",
      `Attachment upload failed with status ${response.status}`,
      exitCodes.api,
      {
        body,
        status: response.status,
      },
    );
  }

  async createComment(projectId: string, issueId: string, comment: string): Promise<JsonObject> {
    return this.request(
      "POST",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/comments/`,
      { body: { comment_html: comment, comment_stripped: comment } },
    );
  }

  async updateComment(
    projectId: string,
    issueId: string,
    commentId: string,
    comment: string,
  ): Promise<JsonObject> {
    return this.request(
      "PATCH",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/comments/${commentId}/`,
      { body: { comment_html: comment, comment_stripped: comment } },
    );
  }

  async deleteComment(projectId: string, issueId: string, commentId: string): Promise<JsonObject> {
    return this.request(
      "DELETE",
      `/api/v1/workspaces/${this.workspace.workspaceSlug}/projects/${projectId}/work-items/${issueId}/comments/${commentId}/`,
    );
  }

  async listMembers(query: Query = {}): Promise<JsonObject[]> {
    return this.paginate(`/api/v1/workspaces/${this.workspace.workspaceSlug}/members/`, query);
  }

  async getCurrentUser(): Promise<JsonObject> {
    return this.request("GET", "/api/v1/users/me/");
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; query?: Query } = {},
  ): Promise<JsonObject> {
    const data = await this.requestAny(method, path, options);
    return asObject(data);
  }

  async requestAny(
    method: string,
    path: string,
    options: { body?: unknown; query?: Query } = {},
  ): Promise<JsonValue> {
    const url = this.url(path, options.query);
    const response = await this.fetch(url, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: this.headers(options.body !== undefined),
      method,
    });
    return parseResponse(response);
  }

  private async paginate(path: string, query: Query = {}): Promise<JsonObject[]> {
    const results: JsonObject[] = [];
    let cursor = typeof query.cursor === "string" ? query.cursor : undefined;
    const seenCursors = new Set<string>();
    if (cursor) seenCursors.add(cursor);
    do {
      const page = await this.request("GET", path, { query: { ...query, cursor } });
      if (Array.isArray(page.results)) {
        results.push(...(page.results as JsonObject[]));
        const nextCursor =
          typeof page.next_cursor === "string" && page.next_page_results
            ? page.next_cursor
            : undefined;
        if (nextCursor && seenCursors.has(nextCursor)) {
          throw new AppError(
            "API_ERROR",
            "Plane API pagination repeated a cursor.",
            exitCodes.api,
            {
              cursor: nextCursor,
              path,
            },
          );
        }
        cursor = nextCursor;
        if (cursor) seenCursors.add(cursor);
      } else if (Array.isArray(page.value)) {
        results.push(...(page.value as JsonObject[]));
        cursor = undefined;
      } else if (Array.isArray(page)) {
        results.push(...page);
        cursor = undefined;
      } else {
        results.push(page);
        cursor = undefined;
      }
    } while (cursor);
    return results;
  }

  private url(path: string, query: Query = {}): string {
    const url = new URL(path.replace(/^\/+/, ""), `${this.workspace.baseUrl.replace(/\/+$/, "")}/`);
    if (url.protocol !== "https:" && (url.protocol !== "http:" || !isAllowedPlaintextHost(url.hostname))) {
      throw new AppError(
        "CONFIG_INVALID",
        "Plane workspace baseUrl must use HTTPS unless it points to local development.",
        exitCodes.validationOrConfig,
        { baseUrl: this.workspace.baseUrl },
      );
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const auth = this.workspace.auth;
    if (auth?.type === "oauth") headers.Authorization = `Bearer ${auth.accessToken}`;
    else
      headers["X-API-Key"] = auth?.type === "apiKey" ? auth.apiKey : (this.workspace.apiKey ?? "");
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }
}

export type ProjectResource = "states" | "labels" | "modules" | "cycles" | "pages";

type ContainerResource = "cycles" | "modules";

function containerIssueSegment(resource: ContainerResource): "cycle-issues" | "module-issues" {
  return resource === "cycles" ? "cycle-issues" : "module-issues";
}

export async function resolveProject(client: PlaneClient, lookup: string): Promise<JsonObject> {
  const projects = await client.listProjects({ per_page: 100 });
  const normalizedLookup = lookup.toLowerCase();
  const exact = projects.find(
    (project) =>
      String(project.id ?? "").toLowerCase() === normalizedLookup ||
      String(project.identifier ?? "").toLowerCase() === normalizedLookup ||
      String(project.name ?? "").toLowerCase() === normalizedLookup,
  );
  if (exact) return exact;
  const fuzzy = projects.find((project) =>
    String(project.name ?? "")
      .toLowerCase()
      .includes(normalizedLookup),
  );
  if (fuzzy) return fuzzy;
  throw new NotFoundError("project", lookup);
}

export function identifierFromWorkItem(item: JsonObject, project?: JsonObject): string | undefined {
  const sequence = item.sequence_id;
  if (sequence === undefined || sequence === null || sequence === "") return undefined;
  const identifier =
    item.project_identifier ??
    (typeof item.project_detail === "object" && item.project_detail !== null
      ? (item.project_detail as JsonObject).identifier
      : undefined) ??
    project?.identifier;
  return identifier ? `${String(identifier).toUpperCase()}-${sequence}` : String(sequence);
}

function normalizeWorkItemInput(input: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "description" && typeof value === "string") {
      output.description_html = value;
      output.description_stripped = value;
    } else {
      output[key] = value;
    }
  }
  return dropUndefined(output);
}

export function dropUndefined(input: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function parseResponse(response: Response): Promise<JsonValue> {
  const status = response.status;
  const text = await response.text();
  const body = text ? safeJson(text) : {};
  if (status >= 200 && status < 300) return body;
  const bodyObject = asObject(body);
  const message =
    typeof bodyObject.detail === "string"
      ? bodyObject.detail
      : typeof bodyObject.error === "string"
        ? bodyObject.error
        : `Plane API request failed with status ${status}`;
  if (status === 401 || status === 403) {
    throw new AppError("PLANE_AUTH_FAILED", message, exitCodes.auth, { status });
  }
  if (status === 404) throw new AppError("NOT_FOUND", message, exitCodes.notFound, { status });
  throw new AppError("API_ERROR", message, exitCodes.api, { body, status });
}

function safeJson(text: string): JsonValue {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonValue(parsed) ? parsed : { value: String(parsed) };
  } catch {
    return { body: text };
  }
}

function asObject(data: JsonValue): JsonObject {
  return typeof data === "object" && data !== null && !Array.isArray(data) ? data : { value: data };
}

function isAllowedPlaintextHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]") {
    return true;
  }

  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object";
}

function extractUploadUrl(credentials: JsonObject): string {
  const value =
    stringField(credentials, "upload_url") ??
    stringField(credentials, "uploadUrl") ??
    stringField(credentials, "url") ??
    stringField(credentials, "asset_upload_url") ??
    stringField(nestedObject(credentials, "upload_data"), "url");
  if (!value) {
    throw new AppError(
      "API_ERROR",
      "Plane upload credentials did not include an upload URL.",
      exitCodes.api,
      {
        credentials: Object.keys(credentials),
      },
    );
  }
  return value;
}

function extractUploadFields(credentials: JsonObject): JsonObject {
  const candidates = [
    credentials.fields,
    credentials.upload_fields,
    credentials.form_fields,
    credentials.form_data,
    nestedObject(credentials, "upload_data")?.fields,
    typeof credentials.data === "object" && credentials.data !== null
      ? (credentials.data as JsonObject).fields
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
      return candidate as JsonObject;
    }
  }
  return {};
}

function stringField(object: JsonObject | undefined, key: string): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function nestedObject(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
