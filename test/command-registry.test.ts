import { describe, expect, test } from "vitest";
import {
  buildMcpInputSchema,
  commandKey,
  defaultMcpName,
  flagToMcpName,
  mcpInputToArgv,
  mcpNameToFlagName,
} from "../src/commands/registry.js";

describe("command registry helpers", () => {
  test("keeps MCP tool names stable for hyphenated commands", () => {
    expect(commandKey(["issue", "type-schema"])).toBe("issue type-schema");
    expect(defaultMcpName(["issue", "type-schema"])).toBe("issue_type_schema");
    expect(flagToMcpName("workspace-slug")).toBe("workspace_slug");
    expect(mcpNameToFlagName("workspace_slug")).toBe("workspace-slug");
  });

  test("builds JSON schema with required args, flags, and workspace", () => {
    const schema = buildMcpInputSchema({
      args: [{ description: "Title", name: "title", required: true }],
      flags: [
        { description: "Workspace slug", name: "workspace-slug", type: "string", required: true },
        { description: "Estimate", name: "estimate", type: "number" },
      ],
    });

    expect(schema).toEqual({
      additionalProperties: false,
      properties: {
        estimate: { description: "Estimate", type: "number" },
        title: { description: "Title", type: "string" },
        workspace: { description: "Optional workspace name", type: "string" },
        workspace_slug: { description: "Workspace slug", type: "string" },
      },
      required: ["title", "workspace_slug"],
      type: "object",
    });
  });

  test("converts typed MCP input to comment create argv", () => {
    const argv = mcpInputToArgv(
      {
        args: [{ description: "Title", name: "title", required: true }],
        flags: [
          { description: "Project", name: "project", type: "string", required: true },
          { description: "Labels", name: "label", type: "string[]" },
          { description: "Notify", name: "notify", type: "boolean" },
          { description: "Priority", name: "priority", type: "integer" },
        ],
        words: ["comment", "create"],
      },
      {
        label: ["bug", "frontend"],
        notify: true,
        priority: 2,
        project: "WEB",
        title: "Ship it",
        workspace: "prod",
      },
    );

    expect(argv).toEqual([
      "comment",
      "create",
      "--workspace",
      "prod",
      "Ship it",
      "--project",
      "WEB",
      "--label",
      "bug",
      "--label",
      "frontend",
      "--notify",
      "--priority",
      "2",
      "--json",
    ]);
  });

  test("omits false boolean flags and repeats array flags", () => {
    const argv = mcpInputToArgv(
      {
        flags: [
          { description: "Dry run", name: "dry-run", type: "boolean" },
          { description: "Labels", name: "label", type: "string[]" },
        ],
        words: ["issue", "list"],
      },
      {
        "dry-run": false,
        label: ["triage", "docs"],
      },
    );

    expect(argv).toEqual(["issue", "list", "--label", "triage", "--label", "docs", "--json"]);
  });

  test("omits blank string values for workspace args and flags", () => {
    const argv = mcpInputToArgv(
      {
        args: [{ description: "Title", name: "title" }],
        flags: [{ description: "Label", name: "label", type: "string" }],
        words: ["issue", "create"],
      },
      {
        label: "   ",
        title: "  ",
        workspace: "",
      },
    );

    expect(argv).toEqual(["issue", "create", "--json"]);
  });

  test("omits blank items from string array flags", () => {
    const argv = mcpInputToArgv(
      {
        flags: [{ description: "Labels", name: "label", type: "string[]" }],
        words: ["issue", "list"],
      },
      {
        label: ["bug", " ", "", "frontend"],
      },
    );

    expect(argv).toEqual(["issue", "list", "--label", "bug", "--label", "frontend", "--json"]);
  });

  test("uses custom mcp names for input properties and original CLI flag names in argv", () => {
    const argv = mcpInputToArgv(
      {
        flags: [{ description: "Workspace slug", mcpName: "workspaceSlug", name: "workspace-slug", type: "string" }],
        words: ["auth", "api-key"],
      },
      {
        workspaceSlug: "engineering",
      },
    );

    expect(argv).toEqual(["auth", "api-key", "--workspace-slug", "engineering", "--json"]);
  });
});
