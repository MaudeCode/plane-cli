import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { type CliDeps, commandSpecs, runMcpCommand } from "../cli.js";
import type { CommandFlagSpec, CommandSpec, PrimitiveFlagType } from "../commands/registry.js";
import { flagToMcpName } from "../commands/registry.js";
import { jsonError, jsonSuccess } from "../lib/output.js";
import {
  createMemoryContextStore,
  type PlaneMcpContextStore,
  type PlaneMcpSessionContext,
} from "./session-context.js";

export type PlaneMcpServerOptions = CliDeps & {
  context?: PlaneMcpSessionContext;
  contextStore?: PlaneMcpContextStore;
  name?: string;
  sessionId?: string;
  version?: string;
};

type InputShape = Record<string, ZodTypeAny>;

const instructions =
  "Plane MCP exposes typed Plane tools generated from plane-cli. Before Plane work in a local repository, read the local .plane-cli-workspace file and call plane_context_set once with its workspace and optional project. Tool calls then default to that MCP session context. Explicit tool arguments still win. Plane permissions are determined by the configured Plane token/app installation.";

export function createPlaneMcpServer(options: PlaneMcpServerOptions = {}): McpServer {
  const sessionId = options.sessionId ?? randomUUID();
  const contextStore =
    options.contextStore ??
    createMemoryContextStore(options.context ? [[sessionId, options.context]] : []);
  const server = new McpServer(
    {
      name: options.name ?? "plane-cli",
      version: options.version ?? "0.2.1",
    },
    { instructions },
  );

  server.registerTool(
    "plane_context_set",
    {
      annotations: {
        destructiveHint: false,
        readOnlyHint: false,
      },
      description:
        "Set the Plane workspace/project context for this MCP session. Read local .plane-cli-workspace and call this once before repo-scoped Plane work.",
      inputSchema: {
        project: z.string().describe("Plane project name, identifier, or id.").optional(),
        workspace: z.string().describe("Local plane-cli workspace name.").min(1),
      },
    },
    async (input) => {
      const context = { project: optionalString(input.project), workspace: input.workspace };
      await contextStore.set(sessionId, context);
      return contextResult(await contextStore.get(sessionId));
    },
  );

  server.registerTool(
    "plane_context_get",
    {
      annotations: {
        destructiveHint: false,
        readOnlyHint: true,
      },
      description: "Get the current Plane workspace/project context for this MCP session.",
      inputSchema: {},
    },
    async () => contextResult(await contextStore.get(sessionId)),
  );

  server.registerTool(
    "plane_context_clear",
    {
      annotations: {
        destructiveHint: false,
        readOnlyHint: false,
      },
      description: "Clear the Plane workspace/project context for this MCP session.",
      inputSchema: {},
    },
    async () => {
      await contextStore.clear(sessionId);
      return contextResult({});
    },
  );

  for (const spec of commandSpecs) {
    server.registerTool(
      spec.mcpName,
      {
        annotations: {
          destructiveHint: spec.destructive === true,
          readOnlyHint: isReadOnlyCommand(spec),
        },
        description: spec.description,
        inputSchema: zodShapeForSpec(spec),
      },
      async (input) => {
        try {
          const context = await contextStore.get(sessionId);
          const result = await runMcpCommand(
            spec.mcpName,
            applySessionContext(spec, input as Record<string, unknown>, context),
            options,
          );
          const workspace = result.workspace?.name;
          const structuredContent = workspace
            ? { ok: true, workspace, data: result.data }
            : { ok: true, data: result.data };
          return {
            content: [{ type: "text" as const, text: jsonSuccess(result.data, workspace) }],
            structuredContent,
          };
        } catch (error) {
          const structuredContent = JSON.parse(jsonError(error).body) as {
            ok: false;
            error: { code: string; message: string; details: Record<string, unknown> };
          };
          return {
            content: [{ type: "text" as const, text: structuredContent.error.message }],
            isError: true,
            structuredContent,
          };
        }
      },
    );
  }

  return server;
}

function contextResult(context: PlaneMcpSessionContext) {
  const data = {
    ...(context.workspace ? { workspace: context.workspace } : {}),
    ...(context.project ? { project: context.project } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: true, data }) }],
    structuredContent: { ok: true, data },
  };
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function applySessionContext(
  spec: CommandSpec<unknown>,
  input: Record<string, unknown>,
  context: PlaneMcpSessionContext,
): Record<string, unknown> {
  const resolvedInput = { ...input };

  if (
    spec.category !== "auth" &&
    context.workspace &&
    isMissingInputValue(resolvedInput.workspace)
  ) {
    resolvedInput.workspace = context.workspace;
  }

  if (context.project && specHasMcpFlag(spec, "project") && isMissingInputValue(resolvedInput.project)) {
    resolvedInput.project = context.project;
  }

  return resolvedInput;
}

function isMissingInputValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function specHasMcpFlag(spec: Pick<CommandSpec<unknown>, "flags">, propertyName: string): boolean {
  return (spec.flags ?? []).some((flag) => flagMcpPropertyName(flag) === propertyName);
}

function zodShapeForSpec(spec: Pick<CommandSpec<unknown>, "args" | "flags">): InputShape {
  const shape: InputShape = {};

  if (!hasExplicitWorkspaceFlag(spec)) {
    shape.workspace = z.string().describe("Optional workspace name").optional();
  }

  for (const arg of spec.args ?? []) {
    const schema = z.string().describe(arg.description);
    shape[arg.name] = arg.required ? schema : schema.optional();
  }

  for (const flag of spec.flags ?? []) {
    const propertyName = flagMcpPropertyName(flag);
    const schema = zodForFlagType(flag.type).describe(flag.description);
    shape[propertyName] = flag.required && propertyName !== "project" ? schema : schema.optional();
  }

  return shape;
}

function zodForFlagType(type: PrimitiveFlagType): ZodTypeAny {
  switch (type) {
    case "boolean":
      return z.boolean();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "string":
      return z.string();
    case "string[]":
      return z.array(z.string());
  }
}

function flagMcpPropertyName(flag: CommandFlagSpec): string {
  return flag.mcpName ?? flagToMcpName(flag.name);
}

function hasExplicitWorkspaceFlag(spec: Pick<CommandSpec<unknown>, "flags">): boolean {
  return (spec.flags ?? []).some((flag) => flagMcpPropertyName(flag) === "workspace");
}

function isReadOnlyCommand(spec: Pick<CommandSpec<unknown>, "destructive" | "words">): boolean {
  if (spec.destructive) return false;

  const action = spec.words.at(-1);
  return !(
    action === "add-item" ||
    action === "api-key" ||
    action === "archive" ||
    action === "bot" ||
    action === "code" ||
    action === "complete" ||
    action === "create" ||
    action === "login" ||
    action === "remove-item" ||
    action === "request-upload" ||
    action === "unarchive" ||
    action === "update" ||
    action === "upload"
  );
}
