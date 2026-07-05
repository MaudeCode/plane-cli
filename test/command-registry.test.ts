import { describe, expect, test } from "vitest";
import {
  buildMcpInputSchema,
  commandKey,
  defaultMcpName,
  flagToMcpName,
  mcpInputToArgv,
  mcpNameToFlagName,
} from "../src/commands/registry.js";
import { commandSpecs, normalizeCommandWordsForTest } from "../src/cli.js";

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

  test("prepends generic workspace when a command has no explicit workspace flag", () => {
    const argv = mcpInputToArgv(
      {
        flags: [{ description: "Project", name: "project", type: "string", required: true }],
        words: ["project", "list"],
      },
      {
        project: "WEB",
        workspace: "prod",
      },
    );

    expect(argv).toEqual(["project", "list", "--workspace", "prod", "--project", "WEB", "--json"]);
  });

  test("uses explicit workspace flags without duplicating generic workspace argv", () => {
    const argv = mcpInputToArgv(
      {
        flags: [
          { description: "Workspace to save", name: "workspace", type: "string", required: true },
        ],
        words: ["auth", "api-key"],
      },
      {
        workspace: "prod",
      },
    );

    expect(argv).toEqual(["auth", "api-key", "--workspace", "prod", "--json"]);
  });

  test("lets explicit workspace flag metadata win in schema", () => {
    const schema = buildMcpInputSchema({
      flags: [
        { description: "Workspace to save", name: "workspace", type: "string", required: true },
      ],
    });

    expect(schema).toEqual({
      additionalProperties: false,
      properties: {
        workspace: { description: "Workspace to save", type: "string" },
      },
      required: ["workspace"],
      type: "object",
    });
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
        flags: [
          {
            description: "Workspace slug",
            mcpName: "workspaceSlug",
            name: "workspace-slug",
            type: "string",
          },
        ],
        words: ["auth", "api-key"],
      },
      {
        workspaceSlug: "engineering",
      },
    );

    expect(argv).toEqual(["auth", "api-key", "--workspace-slug", "engineering", "--json"]);
  });
});

describe("CLI command specs", () => {
  test("uses unique MCP tool names", () => {
    const names = commandSpecs.map((spec) => spec.mcpName);

    expect(new Set(names).size).toBe(names.length);
  });

  test("uses unique CLI command and alias keys", () => {
    const keys = commandSpecs.flatMap((spec) => [
      commandKey(spec.words),
      ...(spec.aliases ?? []).map((aliasWords) => commandKey(aliasWords)),
    ]);

    expect(new Set(keys).size).toBe(keys.length);
  });

  test("uses unique normalized CLI command and alias keys across commands", () => {
    const normalizedOwners = new Map<string, Set<string>>();
    for (const spec of commandSpecs) {
      for (const words of [spec.words, ...(spec.aliases ?? [])]) {
        const key = commandKey(normalizeCommandWordsForTest(words));
        const owners = normalizedOwners.get(key) ?? new Set<string>();
        owners.add(spec.mcpName);
        normalizedOwners.set(key, owners);
      }
    }

    expect(
      [...normalizedOwners.entries()]
        .filter(([, owners]) => owners.size > 1)
        .map(([key, owners]) => ({ key, owners: [...owners].sort() })),
    ).toEqual([]);
  });

  test("defines required metadata for every command", () => {
    for (const spec of commandSpecs) {
      expect(spec.words.length).toBeGreaterThan(0);
      expect(spec.usage).not.toBe("");
      expect(spec.description).not.toBe("");
      expect(spec.mcpName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test("includes core command tools", () => {
    expect(commandSpecs.map((spec) => spec.mcpName)).toEqual(
      expect.arrayContaining([
        "issue_search",
        "issue_get",
        "issue_create",
        "issue_update",
        "project_list",
        "project_get",
        "comment_create",
        "cycle_list",
        "module_add_item",
      ]),
    );
  });

  test("keeps work-item as CLI aliases instead of separate MCP tools", () => {
    expect(commandSpecs.some((spec) => spec.mcpName.startsWith("work_item_"))).toBe(false);
    expect(commandSpecs.find((spec) => spec.mcpName === "issue_get")?.aliases).toContainEqual([
      "work-item",
      "get",
    ]);
  });

  test("marks known destructive commands", () => {
    const destructiveNames = commandSpecs
      .filter((spec) => spec.destructive)
      .map((spec) => spec.mcpName)
      .sort();

    expect(destructiveNames).toEqual(
      [
        "comment_delete",
        "cycle_delete",
        "issue_attachment_delete",
        "issue_delete",
        "issue_link_delete",
        "label_delete",
        "module_delete",
        "page_delete",
        "project_archive",
        "project_delete",
        "state_delete",
      ].sort(),
    );
  });

  test("marks destructive commands with a required boolean confirm flag", () => {
    for (const spec of commandSpecs.filter((candidate) => candidate.destructive)) {
      expect(spec.flags).toContainEqual(
        expect.objectContaining({
          name: "confirm",
          required: true,
          type: "boolean",
        }),
      );
    }
  });
});
