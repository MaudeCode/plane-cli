import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { type CliDeps, commandSpecs, runMcpCommand } from "../cli.js";
import type { CommandFlagSpec, CommandSpec, PrimitiveFlagType } from "../commands/registry.js";
import { flagToMcpName } from "../commands/registry.js";
import { jsonError, jsonSuccess } from "../lib/output.js";

export type PlaneMcpServerOptions = CliDeps & {
  name?: string;
  version?: string;
};

type InputShape = Record<string, ZodTypeAny>;

const instructions =
  "Plane MCP exposes typed Plane tools generated from plane-cli. Use typed tools directly; Plane permissions are determined by the configured Plane token/app installation.";

export function createPlaneMcpServer(options: PlaneMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "plane-cli",
      version: options.version ?? "0.1.0",
    },
    { instructions },
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
          const result = await runMcpCommand(spec.mcpName, input as Record<string, unknown>, options);
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
    shape[propertyName] = flag.required ? schema : schema.optional();
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
