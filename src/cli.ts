import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  type ConfigLoadOptions,
  type WorkspaceConfig,
  loadConfig,
  loadPublicConfig,
  loadRepoWorkspaceHint,
  resolveWorkspace,
  upsertOAuthWorkspaceConfig,
  upsertWorkspaceConfig,
} from "./lib/config.js";
import { AppError, ValidationAppError, exitCodes, toAppError } from "./lib/errors.js";
import { jsonError, jsonSuccess } from "./lib/output.js";
import {
  type FetchLike,
  type JsonObject,
  type ProjectResource,
  type Query,
  PlaneClient,
  dropUndefined,
  identifierFromWorkItem,
  resolveProject,
} from "./lib/plane-client.js";
import { buildPlaneOAuthAuthorizeUrl, exchangePlaneOAuthToken } from "./lib/plane-oauth.js";
import {
  type CommandSpec,
  commandKey,
  defaultMcpName,
  mcpInputToArgv,
  mcpInputToContextInput,
} from "./commands/registry.js";

export type CliDeps = ConfigLoadOptions & {
  fetch?: FetchLike;
};

export type CliResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type ParsedArgv = {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
};

const mcpFileFlags = new Set(["description-file", "file", "filters-file"]);

export type CommandContext = {
  argv: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: FetchLike;
  flags: Record<string, string | boolean | string[]>;
  home?: string;
  json: boolean;
  positionals: string[];
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;
export type CommandResult = {
  data: unknown;
  human?: string;
  workspace?: WorkspaceConfig;
};

function arg(name: string, description: string, required = true) {
  return { description, name, required };
}

function flag(
  name: string,
  description: string,
  type: "boolean" | "integer" | "number" | "string" | "string[]" = "string",
  required = false,
) {
  return { description, name, required, type };
}

function spec(
  options: Omit<CommandSpec<CommandHandler>, "mcpName"> & { mcpName?: string },
): CommandSpec<CommandHandler> {
  return { ...options, mcpName: options.mcpName ?? defaultMcpName(options.words) };
}

const workspaceAuthFlags = [
  flag("workspace", "Local workspace name used by plane-cli.", "string", true),
  flag("workspace-slug", "Plane workspace slug for API URLs."),
  flag("display-name", "Optional display name stored in config."),
  flag("default", "Make this workspace the default workspace.", "boolean"),
];
const queryFlagsSpec = [
  flag("fields", "Comma-separated fields to request from Plane."),
  flag("per-page", "Number of results per page.", "integer"),
  flag("order-by", "Plane ordering field."),
  flag("cursor", "Pagination cursor."),
  flag("expand", "Comma-separated related fields to expand."),
];
const projectFlag = flag("project", "Project name, identifier, or id.");
const confirmFlag = flag("confirm", "Confirm a destructive operation.", "boolean", true);
const issueMutationFlags = [
  flag("title", "Issue title."),
  flag("description", "Issue description markdown."),
  flag("description-file", "File containing issue description markdown."),
  flag("priority", "Issue priority."),
  flag("state", "State id."),
  flag("assignee", "Assignee user id.", "string[]"),
  flag("label", "Label id.", "string[]"),
  flag("parent", "Parent issue id."),
  flag("start-date", "Issue start date."),
  flag("target-date", "Issue target date."),
  flag("type-id", "Work item type id."),
];
const resourceFlags = [
  flag("name", "Resource name."),
  flag("description", "Resource description."),
  flag("color", "Resource color."),
  flag("group", "State group."),
  flag("start-date", "Cycle start date."),
  flag("end-date", "Cycle end date."),
  flag("target-date", "Target date."),
];

function workItemAliases(words: string[]): string[][] {
  return [["work-item", ...words.slice(1)]];
}

function resourceSpecs(
  resource: "cycle" | "label" | "module" | "page" | "state",
  handlerResource: ProjectResource,
) {
  const label = resource[0]?.toUpperCase() + resource.slice(1);
  return [
    spec({
      args: [],
      category: "resources",
      description: `List ${resource} resources for a project.`,
      flags: [projectFlag, ...queryFlagsSpec],
      handler: resourceList(handlerResource),
      usage: `${resource} list --project project`,
      words: [resource, "list"],
    }),
    spec({
      category: "resources",
      description: `Create a ${resource} resource in a project.`,
      flags: [
        projectFlag,
        flag("name", `${label} name.`, "string", true),
        ...resourceFlags.slice(1),
      ],
      handler: resourceCreate(handlerResource),
      usage: `${resource} create --project project --name name [resource flags]`,
      words: [resource, "create"],
    }),
    spec({
      args: [arg("id", `${label} id.`)],
      category: "resources",
      description: `Update a ${resource} resource in a project.`,
      flags: [projectFlag, ...resourceFlags],
      handler: resourceUpdate(handlerResource),
      usage: `${resource} update <id> --project project [resource flags]`,
      words: [resource, "update"],
    }),
    spec({
      args: [arg("id", `${label} id.`)],
      category: "resources",
      description: `Delete a ${resource} resource from a project.`,
      destructive: true,
      flags: [projectFlag, confirmFlag],
      handler: resourceDelete(handlerResource),
      usage: `${resource} delete <id> --project project --confirm`,
      words: [resource, "delete"],
    }),
  ];
}

function containerSpecs(resource: "cycle" | "module", handlerResource: "cycles" | "modules") {
  return [
    spec({
      args: [arg("container", `${resource} id.`), arg("issue", "Issue id or identifier.")],
      category: "containers",
      description: `Add an issue to a ${resource}.`,
      flags: [projectFlag],
      handler: containerAddItem(handlerResource),
      usage: `${resource} add-item <container-id> <issue-id> --project project`,
      words: [resource, "add-item"],
    }),
    spec({
      args: [arg("container", `${resource} id.`), arg("issue", "Issue id or identifier.")],
      category: "containers",
      description: `Remove an issue from a ${resource}.`,
      flags: [projectFlag],
      handler: containerRemoveItem(handlerResource),
      usage: `${resource} remove-item <container-id> <issue-id> --project project`,
      words: [resource, "remove-item"],
    }),
    spec({
      args: [arg("container", `${resource} id.`)],
      category: "containers",
      description: `List issues in a ${resource}.`,
      flags: [projectFlag],
      handler: containerItems(handlerResource),
      usage: `${resource} items <container-id> --project project`,
      words: [resource, "items"],
    }),
  ];
}

export const commandSpecs: CommandSpec<CommandHandler>[] = [
  spec({
    category: "auth",
    description: "Save API key credentials for a Plane workspace.",
    flags: [
      flag("api-key", "Plane API key.", "string", true),
      flag("base-url", "Plane API base URL."),
      ...workspaceAuthFlags,
    ],
    handler: authApiKey,
    usage:
      "auth api-key --workspace name --api-key plane_api_... [--base-url url] [--workspace-slug slug] [--default]",
    words: ["auth", "api-key"],
  }),
  spec({
    category: "auth",
    description: "Save OAuth client credentials for a Plane bot installation.",
    flags: [
      flag("base-url", "Plane API base URL.", "string", true),
      flag("client-id", "OAuth client id.", "string", true),
      flag("client-secret", "OAuth client secret.", "string", true),
      flag("app-installation-id", "Plane app installation id.", "string", true),
      ...workspaceAuthFlags,
    ],
    handler: authOAuthBot,
    usage:
      "auth oauth bot --workspace name --base-url url --client-id id --client-secret secret --app-installation-id id [--workspace-slug slug] [--default]",
    words: ["auth", "oauth", "bot"],
  }),
  spec({
    category: "auth",
    description: "Run a browser OAuth login and save user credentials.",
    flags: [
      flag("base-url", "Plane API base URL.", "string", true),
      flag("client-id", "OAuth client id.", "string", true),
      flag("client-secret", "OAuth client secret.", "string", true),
      flag("redirect-port", "Local callback port.", "integer"),
      flag("redirect-uri", "OAuth redirect URI."),
      flag("scope", "OAuth scope.", "string[]"),
      flag("state", "OAuth state."),
      flag("no-open", "Do not open the browser automatically.", "boolean"),
      ...workspaceAuthFlags,
    ],
    handler: authOAuthLogin,
    usage:
      "auth oauth login --workspace name --base-url url --client-id id --client-secret secret [--redirect-port 8717] [--redirect-uri uri] [--scope scope] [--workspace-slug slug] [--default]",
    words: ["auth", "oauth", "login"],
  }),
  spec({
    category: "auth",
    description: "Exchange an OAuth authorization code and save user credentials.",
    flags: [
      flag("base-url", "Plane API base URL.", "string", true),
      flag("client-id", "OAuth client id.", "string", true),
      flag("client-secret", "OAuth client secret.", "string", true),
      flag("redirect-uri", "OAuth redirect URI.", "string", true),
      flag("code", "OAuth authorization code.", "string", true),
      ...workspaceAuthFlags,
    ],
    handler: authOAuthCode,
    usage:
      "auth oauth code --workspace name --base-url url --client-id id --client-secret secret --redirect-uri uri --code code [--workspace-slug slug] [--default]",
    words: ["auth", "oauth", "code"],
  }),
  spec({
    category: "auth",
    description: "Build an OAuth authorization URL.",
    flags: [
      flag("base-url", "Plane API base URL.", "string", true),
      flag("client-id", "OAuth client id.", "string", true),
      flag("redirect-uri", "OAuth redirect URI.", "string", true),
      flag("scope", "OAuth scope.", "string[]"),
      flag("state", "OAuth state."),
    ],
    handler: authOAuthUrl,
    usage:
      "auth oauth url --base-url url --client-id id --redirect-uri uri [--scope scope] [--state state]",
    words: ["auth", "oauth", "url"],
  }),
  spec({
    category: "config",
    description: "Show plane-cli config without secrets.",
    handler: configShow,
    usage: "config show",
    words: ["config", "show"],
  }),
  spec({
    category: "config",
    description: "Print the active config file path.",
    handler: configPath,
    usage: "config path",
    words: ["config", "path"],
  }),
  spec({
    category: "workspace",
    description: "Show the currently resolved workspace.",
    flags: [flag("workspace", "Workspace name override.")],
    handler: workspaceCurrent,
    usage: "workspace current [--workspace name]",
    words: ["workspace", "current"],
  }),
  spec({
    category: "workspace",
    description: "Validate credentials for the resolved workspace.",
    flags: [flag("workspace", "Workspace name override.")],
    handler: workspaceValidate,
    usage: "workspace validate [--workspace name]",
    words: ["workspace", "validate"],
  }),
  spec({
    aliases: [["whoami"]],
    category: "users",
    description: "Show the current Plane user.",
    handler: userMe,
    usage: "user me",
    words: ["user", "me"],
  }),
  spec({
    aliases: [["members", "list"]],
    category: "users",
    description: "List workspace members.",
    flags: queryFlagsSpec,
    handler: memberList,
    usage: "member list",
    words: ["member", "list"],
  }),
  spec({
    category: "projects",
    description: "List projects in the workspace.",
    flags: queryFlagsSpec,
    handler: projectList,
    usage: "project list [--fields fields] [--per-page 100] [--order-by field]",
    words: ["project", "list"],
  }),
  spec({
    aliases: [["project", "show"]],
    args: [arg("project", "Project name, identifier, or id.")],
    category: "projects",
    description: "Get a project by name, identifier, or id.",
    handler: projectGet,
    usage: "project get <project>",
    words: ["project", "get"],
  }),
  spec({
    category: "projects",
    description: "Create a project.",
    flags: [
      flag("name", "Project name.", "string", true),
      flag("identifier", "Project identifier."),
      flag("description", "Project description."),
      flag("lead", "Project lead user id."),
    ],
    handler: projectCreate,
    usage: "project create --name name [--identifier KEY] [--description text]",
    words: ["project", "create"],
  }),
  spec({
    args: [arg("project", "Project name, identifier, or id.")],
    category: "projects",
    description: "Update a project.",
    flags: [
      flag("name", "Project name."),
      flag("description", "Project description."),
      flag("identifier", "Project identifier."),
      flag("lead", "Project lead user id."),
    ],
    handler: projectUpdate,
    usage: "project update <project> [--name name] [--description text] [--identifier KEY]",
    words: ["project", "update"],
  }),
  spec({
    args: [arg("project", "Project name, identifier, or id.")],
    category: "projects",
    description: "Archive a project.",
    destructive: true,
    flags: [confirmFlag],
    handler: projectArchive,
    usage: "project archive <project> --confirm",
    words: ["project", "archive"],
  }),
  spec({
    args: [arg("project", "Project name, identifier, or id.")],
    category: "projects",
    description: "Unarchive a project.",
    handler: projectUnarchive,
    usage: "project unarchive <project>",
    words: ["project", "unarchive"],
  }),
  spec({
    args: [arg("project", "Project name, identifier, or id.")],
    category: "projects",
    description: "Delete a project.",
    destructive: true,
    flags: [confirmFlag],
    handler: projectDelete,
    usage: "project delete <project> --confirm",
    words: ["project", "delete"],
  }),
  spec({
    aliases: workItemAliases(["issue", "list"]),
    category: "issues",
    description: "List issues for a project.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("state", "State id."),
      flag("assignee", "Assignee user id."),
      flag("label", "Label id."),
      ...queryFlagsSpec,
    ],
    handler: issueList,
    usage:
      "issue list --project project [--state id] [--assignee id] [--label id] [--fields fields] [--per-page 100]",
    words: ["issue", "list"],
  }),
  spec({
    aliases: workItemAliases(["issue", "search"]),
    category: "issues",
    description: "Search issues by text.",
    flags: [
      flag("query", "Search text.", "string", true),
      projectFlag,
      flag("limit", "Maximum results.", "integer"),
      flag("workspace-search", "Search across the workspace.", "boolean"),
    ],
    handler: issueSearch,
    usage: "issue search --query text [--project project] [--limit 10] [--workspace-search]",
    words: ["issue", "search"],
  }),
  spec({
    aliases: workItemAliases(["issue", "advanced-search"]),
    category: "issues",
    description: "Search issues with structured filters.",
    flags: [
      flag("query", "Search text."),
      projectFlag,
      flag("filters-json", "Filters JSON object."),
      flag("filters-file", "Path to filters JSON file."),
      flag("limit", "Maximum results.", "integer"),
      flag("workspace-search", "Search across the workspace.", "boolean"),
    ],
    handler: issueAdvancedSearch,
    usage:
      "issue advanced-search [--query text] [--project project] [--filters-json json | --filters-file file] [--limit 10] [--workspace-search]",
    words: ["issue", "advanced-search"],
  }),
  spec({
    aliases: workItemAliases(["issue", "get"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "issues",
    description: "Get an issue by identifier or id.",
    flags: [projectFlag, ...queryFlagsSpec],
    handler: issueGet,
    usage: "issue get <KEY-123 | issue-id> [--project project]",
    words: ["issue", "get"],
  }),
  spec({
    aliases: workItemAliases(["issue", "create"]),
    category: "issues",
    description: "Create an issue.",
    flags: [
      flag("title", "Issue title.", "string", true),
      projectFlag,
      ...issueMutationFlags.slice(1),
    ],
    handler: issueCreate,
    usage:
      "issue create --title title [--project project] [--description markdown] [--priority urgent|high|medium|low|none] [--state state-id] [--assignee user-id] [--label label-id] [--parent issue-id]",
    words: ["issue", "create"],
  }),
  spec({
    aliases: workItemAliases(["issue", "update"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "issues",
    description: "Update an issue.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      ...issueMutationFlags,
    ],
    handler: issueUpdate,
    usage:
      "issue update <issue> --project project [--title title] [--description markdown] [--priority priority] [--state state-id] [--assignee user-id] [--label label-id]",
    words: ["issue", "update"],
  }),
  spec({
    aliases: workItemAliases(["issue", "delete"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "issues",
    description: "Delete an issue.",
    destructive: true,
    flags: [flag("project", "Project name, identifier, or id.", "string", true), confirmFlag],
    handler: issueDelete,
    usage: "issue delete <issue> --project project --confirm",
    words: ["issue", "delete"],
  }),
  spec({
    aliases: workItemAliases(["issue", "type-schema"]),
    category: "issues",
    description: "Show the work item type schema for a project.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("include", "Related schema sections to include."),
      flag("type-id", "Work item type id."),
    ],
    handler: issueTypeSchema,
    usage: "issue type-schema --project project [--include members,labels] [--type-id type-id]",
    words: ["issue", "type-schema"],
  }),
  spec({
    aliases: workItemAliases(["issue", "type-list"]),
    category: "issues",
    description: "List work item types for a project.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true), ...queryFlagsSpec],
    handler: issueTypeList,
    usage: "issue type-list --project project",
    words: ["issue", "type-list"],
  }),
  spec({
    aliases: workItemAliases(["issue", "link", "list"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "links",
    description: "List links attached to an issue.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true), ...queryFlagsSpec],
    handler: linkList,
    usage: "issue link list <issue> --project project",
    words: ["issue", "link", "list"],
  }),
  spec({
    aliases: workItemAliases(["issue", "link", "get"]),
    args: [arg("link", "Link id."), arg("issue", "Issue identifier or id.")],
    category: "links",
    description: "Get an issue link.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true), ...queryFlagsSpec],
    handler: linkGet,
    usage: "issue link get <link-id> <issue> --project project",
    words: ["issue", "link", "get"],
  }),
  spec({
    aliases: workItemAliases(["issue", "link", "create"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "links",
    description: "Create an issue link.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("url", "Link URL.", "string", true),
      flag("title", "Link title."),
    ],
    handler: linkCreate,
    usage: "issue link create <issue> --project project --url url [--title title]",
    words: ["issue", "link", "create"],
  }),
  spec({
    aliases: workItemAliases(["issue", "link", "update"]),
    args: [arg("link", "Link id."), arg("issue", "Issue identifier or id.")],
    category: "links",
    description: "Update an issue link.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("url", "Link URL."),
      flag("title", "Link title."),
    ],
    handler: linkUpdate,
    usage: "issue link update <link-id> <issue> --project project [--url url] [--title title]",
    words: ["issue", "link", "update"],
  }),
  spec({
    aliases: workItemAliases(["issue", "link", "delete"]),
    args: [arg("link", "Link id."), arg("issue", "Issue identifier or id.")],
    category: "links",
    description: "Delete an issue link.",
    destructive: true,
    flags: [flag("project", "Project name, identifier, or id.", "string", true), confirmFlag],
    handler: linkDelete,
    usage: "issue link delete <link-id> <issue> --project project --confirm",
    words: ["issue", "link", "delete"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "list"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "List issue attachments.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true), ...queryFlagsSpec],
    handler: attachmentList,
    usage: "issue attachment list <issue> --project project",
    words: ["issue", "attachment", "list"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "get"]),
    args: [arg("attachment", "Attachment id."), arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Get an issue attachment.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true)],
    handler: attachmentGet,
    usage: "issue attachment get <attachment-id> <issue> --project project",
    words: ["issue", "attachment", "get"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "request-upload"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Request upload credentials for an issue attachment.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("name", "Attachment filename.", "string", true),
      flag("size", "Attachment size in bytes.", "number", true),
      flag("type", "Attachment MIME type."),
      flag("external-id", "External attachment id."),
      flag("external-source", "External attachment source."),
    ],
    handler: attachmentRequestUpload,
    usage:
      "issue attachment request-upload <issue> --project project --name filename --size bytes [--type mime]",
    words: ["issue", "attachment", "request-upload"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "complete"]),
    args: [arg("attachment", "Attachment id."), arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Complete an issue attachment upload.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true)],
    handler: attachmentComplete,
    usage: "issue attachment complete <attachment-id> <issue> --project project",
    words: ["issue", "attachment", "complete"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "upload"]),
    args: [arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Upload a file as an issue attachment.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("file", "Path to upload.", "string", true),
      flag("name", "Attachment filename."),
      flag("type", "Attachment MIME type."),
      flag("external-id", "External attachment id."),
      flag("external-source", "External attachment source."),
    ],
    handler: attachmentUpload,
    usage:
      "issue attachment upload <issue> --project project --file path [--name filename] [--type mime]",
    words: ["issue", "attachment", "upload"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "update"]),
    args: [arg("attachment", "Attachment id."), arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Update an issue attachment.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("name", "Attachment filename."),
      flag("type", "Attachment MIME type."),
    ],
    handler: attachmentUpdate,
    usage:
      "issue attachment update <attachment-id> <issue> --project project [--name filename] [--type mime]",
    words: ["issue", "attachment", "update"],
  }),
  spec({
    aliases: workItemAliases(["issue", "attachment", "delete"]),
    args: [arg("attachment", "Attachment id."), arg("issue", "Issue identifier or id.")],
    category: "attachments",
    description: "Delete an issue attachment.",
    destructive: true,
    flags: [flag("project", "Project name, identifier, or id.", "string", true), confirmFlag],
    handler: attachmentDelete,
    usage: "issue attachment delete <attachment-id> <issue> --project project --confirm",
    words: ["issue", "attachment", "delete"],
  }),
  ...resourceSpecs("state", "states"),
  ...resourceSpecs("label", "labels"),
  ...resourceSpecs("module", "modules"),
  ...containerSpecs("module", "modules"),
  ...resourceSpecs("cycle", "cycles"),
  ...containerSpecs("cycle", "cycles"),
  ...resourceSpecs("page", "pages"),
  spec({
    args: [arg("issue", "Issue identifier or id.")],
    category: "comments",
    description: "List comments on an issue.",
    flags: [flag("project", "Project name, identifier, or id.", "string", true)],
    handler: commentList,
    usage: "comment list <issue> --project project",
    words: ["comment", "list"],
  }),
  spec({
    args: [arg("issue", "Issue identifier or id.")],
    category: "comments",
    description: "Create a comment on an issue.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("body", "Comment body markdown.", "string", true),
    ],
    handler: commentCreate,
    usage: "comment create <issue> --project project --body markdown",
    words: ["comment", "create"],
  }),
  spec({
    args: [arg("comment", "Comment id."), arg("issue", "Issue identifier or id.")],
    category: "comments",
    description: "Update an issue comment.",
    flags: [
      flag("project", "Project name, identifier, or id.", "string", true),
      flag("body", "Comment body markdown.", "string", true),
    ],
    handler: commentUpdate,
    usage: "comment update <comment-id> <issue> --project project --body markdown",
    words: ["comment", "update"],
  }),
  spec({
    args: [arg("comment", "Comment id."), arg("issue", "Issue identifier or id.")],
    category: "comments",
    description: "Delete an issue comment.",
    destructive: true,
    flags: [flag("project", "Project name, identifier, or id.", "string", true), confirmFlag],
    handler: commentDelete,
    usage: "comment delete <comment-id> <issue> --project project --confirm",
    words: ["comment", "delete"],
  }),
];

const commands = new Map<string, CommandHandler>();
for (const commandSpec of commandSpecs) {
  commands.set(commandKey(commandSpec.words), commandSpec.handler);
  for (const aliasWords of commandSpec.aliases ?? [])
    commands.set(commandKey(aliasWords), commandSpec.handler);
}

export function buildHelpText(specs: CommandSpec<CommandHandler>[] = commandSpecs): string {
  const usages = specs.map((commandSpec) => `  ${commandSpec.usage}`).join("\n");
  return `plane-cli

USAGE
  plane-cli <topic> <command> [flags]

COMMANDS
${usages}

GLOBAL FLAGS
  --json  Emit only JSON to stdout.
`;
}

export const helpText = buildHelpText();

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stderr: "", stdout: `${helpText}\n` };
  }

  const parsed = parseArgv(argv);
  const json = Boolean(parsed.flags.json);
  try {
    const resolved = resolveCommand(parsed.positionals);
    if (!resolved) {
      throw new ValidationAppError(
        `Unknown command: ${parsed.positionals.slice(0, 3).join(" ") || argv[0]}`,
        {
          commands: [...commands.keys()],
        },
      );
    }
    const context: CommandContext = {
      argv,
      cwd: deps.cwd,
      env: deps.env ?? process.env,
      fetch: deps.fetch,
      flags: parsed.flags,
      home: deps.home,
      json,
      positionals: parsed.positionals.slice(resolved.words),
    };
    const result = await resolved.handler(context);
    const stdout = json
      ? `${jsonSuccess(result.data, result.workspace?.name)}\n`
      : `${result.human ?? JSON.stringify(result.data, null, 2)}\n`;
    return { exitCode: 0, stderr: "", stdout };
  } catch (error) {
    if (json) {
      const rendered = jsonError(error);
      return { exitCode: rendered.exitCode, stderr: "", stdout: `${rendered.body}\n` };
    }
    const appError = toAppError(error);
    return { exitCode: appError.exitCode, stderr: `${appError.message}\n`, stdout: "" };
  }
}

export async function runMcpCommand(
  mcpName: string,
  input: Record<string, unknown>,
  deps: CliDeps = {},
): Promise<CommandResult> {
  const spec = commandSpecs.find((candidate) => candidate.mcpName === mcpName);
  if (!spec) {
    throw new ValidationAppError(`Unknown MCP tool: ${mcpName}`, {
      tools: commandSpecs.map((candidate) => candidate.mcpName),
    });
  }
  const argv = mcpInputToArgv(spec, input);
  const parsed = mcpInputToContextInput(spec, input);
  await constrainMcpFileFlags(parsed.flags, deps.cwd);
  const context: CommandContext = {
    argv,
    cwd: deps.cwd,
    env: deps.env ?? process.env,
    fetch: deps.fetch,
    flags: parsed.flags,
    home: deps.home,
    json: true,
    positionals: parsed.positionals,
  };
  return spec.handler(context);
}

async function constrainMcpFileFlags(
  flags: Record<string, string | boolean | string[]>,
  cwd = process.cwd(),
): Promise<void> {
  const root = await realpath(resolve(cwd));

  for (const flagName of mcpFileFlags) {
    const value = flags[flagName];
    if (typeof value !== "string") continue;

    const filePath = await realpath(resolve(root, value));
    if (!isInsidePath(root, filePath)) {
      throw new ValidationAppError(
        `MCP file flag --${flagName} must resolve inside the configured workspace root.`,
        { flag: flagName },
      );
    }
    flags[flagName] = filePath;
  }
}

function isInsidePath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path.length > 0 && !path.startsWith("..") && !isAbsolute(path));
}

function parseArgv(argv: string[]): ParsedArgv {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      positionals.push(token ?? "");
      continue;
    }
    const rawFlag = token.slice(2);
    const equalsIndex = rawFlag.indexOf("=");
    const rawName = equalsIndex === -1 ? rawFlag : rawFlag.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : rawFlag.slice(equalsIndex + 1);
    const name = rawName ?? "";
    const next = argv[index + 1];
    const value = inlineValue ?? (!next || next.startsWith("--") ? true : next);
    if (inlineValue === undefined && value === next) index += 1;
    addFlag(flags, name, value);
  }
  return { flags, positionals };
}

function addFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string | boolean,
): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[name] = [String(existing), String(value)];
  }
}

function resolveCommand(
  positionals: string[],
): { handler: CommandHandler; words: number } | undefined {
  for (const words of [3, 2, 1]) {
    const id = positionals.slice(0, words).join(" ");
    const handler = commands.get(id);
    if (handler) return { handler, words };
  }
  const aliases = positionals.map((part) => alias(part));
  for (const words of [3, 2, 1]) {
    const id = aliases.slice(0, words).join(" ");
    const handler = commands.get(id);
    if (handler) return { handler, words };
  }
  return undefined;
}

function alias(value: string): string {
  const aliases: Record<string, string> = {
    comments: "comment",
    cycles: "cycle",
    docs: "page",
    document: "page",
    documents: "page",
    issues: "issue",
    labels: "label",
    ls: "list",
    members: "member",
    modules: "module",
    projects: "project",
    read: "get",
    show: "get",
    states: "state",
    users: "member",
    wi: "issue",
  };
  return aliases[value] ?? value;
}

export function normalizeCommandWordsForTest(words: string[]): string[] {
  return words.map((word) => alias(word));
}

async function authApiKey(context: CommandContext): Promise<CommandResult> {
  const workspace = requiredFlag(context, "workspace");
  const apiKey = requiredFlag(context, "api-key");
  const baseUrl = stringFlag(context, "base-url") ?? "https://api.plane.so";
  const workspaceSlug =
    stringFlag(context, "workspace-slug") ??
    (await discoverWorkspaceSlug({
      auth: { apiKey, type: "apiKey" },
      baseUrl,
      fetch: context.fetch,
      workspace,
    }));
  const result = await upsertWorkspaceConfig({
    apiKey,
    baseUrl,
    cwd: context.cwd,
    displayName: stringFlag(context, "display-name"),
    home: context.home,
    setDefault: booleanFlag(context, "default") ?? false,
    workspace,
    workspaceSlug,
  });
  return { data: result, human: `Saved Plane workspace ${workspace} to ${result.configPath}` };
}

async function authOAuthBot(context: CommandContext): Promise<CommandResult> {
  const workspace = requiredFlag(context, "workspace");
  const baseUrl = requiredFlag(context, "base-url");
  const clientId = requiredFlag(context, "client-id");
  const clientSecret = requiredFlag(context, "client-secret");
  const appInstallationId = requiredFlag(context, "app-installation-id");
  const token = await exchangePlaneOAuthToken(
    {
      appInstallationId,
      baseUrl,
      clientId,
      clientSecret,
      grantType: "client_credentials",
    },
    { fetch: context.fetch },
  );
  const workspaceSlug =
    stringFlag(context, "workspace-slug") ??
    (await discoverWorkspaceSlugFromAppInstallation({
      accessToken: token.accessToken,
      appInstallationId,
      baseUrl,
      fetch: context.fetch,
      workspace,
    }));
  const result = await upsertOAuthWorkspaceConfig({
    auth: {
      accessToken: token.accessToken,
      appInstallationId,
      clientId,
      clientSecret,
      expiresAt: token.expiresAt,
      flow: "client_credentials",
      scopes: token.scopes,
      tokenType: token.tokenType,
      type: "oauth",
    },
    baseUrl,
    cwd: context.cwd,
    displayName: stringFlag(context, "display-name"),
    home: context.home,
    setDefault: booleanFlag(context, "default") ?? false,
    workspace,
    workspaceSlug,
  });
  return {
    data: result,
    human: `Saved Plane OAuth app workspace ${workspace} to ${result.configPath}`,
  };
}

async function authOAuthCode(context: CommandContext): Promise<CommandResult> {
  const workspace = requiredFlag(context, "workspace");
  const baseUrl = requiredFlag(context, "base-url");
  const clientId = requiredFlag(context, "client-id");
  const clientSecret = requiredFlag(context, "client-secret");
  const redirectUri = requiredFlag(context, "redirect-uri");
  const token = await exchangePlaneOAuthToken(
    {
      baseUrl,
      clientId,
      clientSecret,
      code: requiredFlag(context, "code"),
      grantType: "authorization_code",
      redirectUri,
    },
    { fetch: context.fetch },
  );
  const workspaceSlug =
    stringFlag(context, "workspace-slug") ??
    (await discoverWorkspaceSlug({
      auth: { accessToken: token.accessToken, type: "oauth" },
      baseUrl,
      fetch: context.fetch,
      workspace,
    }));
  const result = await upsertOAuthWorkspaceConfig({
    auth: {
      accessToken: token.accessToken,
      clientId,
      clientSecret,
      expiresAt: token.expiresAt,
      flow: "authorization_code",
      refreshToken: token.refreshToken,
      scopes: token.scopes,
      tokenType: token.tokenType,
      type: "oauth",
    },
    baseUrl,
    cwd: context.cwd,
    displayName: stringFlag(context, "display-name"),
    home: context.home,
    setDefault: booleanFlag(context, "default") ?? false,
    workspace,
    workspaceSlug,
  });
  return {
    data: result,
    human: `Saved Plane OAuth user workspace ${workspace} to ${result.configPath}`,
  };
}

async function authOAuthUrl(context: CommandContext): Promise<CommandResult> {
  const state = stringFlag(context, "state") ?? randomBytes(16).toString("hex");
  const url = buildPlaneOAuthAuthorizeUrl({
    baseUrl: requiredFlag(context, "base-url"),
    clientId: requiredFlag(context, "client-id"),
    redirectUri: requiredFlag(context, "redirect-uri"),
    scopes: scopesFlag(context),
    state,
  });
  return { data: { state, url }, human: url };
}

async function authOAuthLogin(context: CommandContext): Promise<CommandResult> {
  const workspace = requiredFlag(context, "workspace");
  const baseUrl = requiredFlag(context, "base-url");
  const clientId = requiredFlag(context, "client-id");
  const clientSecret = requiredFlag(context, "client-secret");
  const port = numberFlag(context, "redirect-port") ?? 8717;
  const redirectUri = stringFlag(context, "redirect-uri") ?? `http://127.0.0.1:${port}/callback`;
  const state = stringFlag(context, "state") ?? randomBytes(16).toString("hex");
  const url = buildPlaneOAuthAuthorizeUrl({
    baseUrl,
    clientId,
    redirectUri,
    scopes: scopesFlag(context),
    state,
  });
  const code = await waitForOAuthCode({ port, state, url, openBrowser: !context.flags["no-open"] });
  const token = await exchangePlaneOAuthToken(
    {
      baseUrl,
      clientId,
      clientSecret,
      code,
      grantType: "authorization_code",
      redirectUri,
    },
    { fetch: context.fetch },
  );
  const workspaceSlug =
    stringFlag(context, "workspace-slug") ??
    (await discoverWorkspaceSlug({
      auth: { accessToken: token.accessToken, type: "oauth" },
      baseUrl,
      fetch: context.fetch,
      workspace,
    }));
  const result = await upsertOAuthWorkspaceConfig({
    auth: {
      accessToken: token.accessToken,
      clientId,
      clientSecret,
      expiresAt: token.expiresAt,
      flow: "authorization_code",
      refreshToken: token.refreshToken,
      scopes: token.scopes,
      tokenType: token.tokenType,
      type: "oauth",
    },
    baseUrl,
    cwd: context.cwd,
    displayName: stringFlag(context, "display-name"),
    home: context.home,
    setDefault: booleanFlag(context, "default") ?? false,
    workspace,
    workspaceSlug,
  });
  return {
    data: result,
    human: `Saved Plane OAuth user workspace ${workspace} to ${result.configPath}`,
  };
}

async function configShow(context: CommandContext): Promise<CommandResult> {
  return { data: await loadPublicConfig(loadOptions(context)) };
}

async function configPath(context: CommandContext): Promise<CommandResult> {
  const config = await loadConfig(loadOptions(context));
  return { data: { path: config.configPath }, human: config.configPath };
}

async function workspaceCurrent(context: CommandContext): Promise<CommandResult> {
  const resolution = await resolveCurrentWorkspace(context);
  return {
    data: {
      source: resolution.source,
      workspace: {
        baseUrl: resolution.workspace.baseUrl,
        displayName: resolution.workspace.displayName,
        name: resolution.workspace.name,
        workspaceSlug: resolution.workspace.workspaceSlug,
      },
    },
    workspace: resolution.workspace,
  };
}

async function workspaceValidate(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const user = await client.getCurrentUser();
  return { data: { user, valid: true }, human: `Validated ${workspace.name}`, workspace };
}

async function userMe(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  return { data: await client.getCurrentUser(), workspace };
}

async function memberList(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const data = await client.listMembers(queryFlags(context));
  return { data, workspace };
}

async function projectList(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  return { data: await client.listProjects(queryFlags(context)), workspace };
}

async function projectGet(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const project = await resolveProject(client, requiredArg(context, 0, "project"));
  return { data: project, workspace };
}

async function projectCreate(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const project = await client.createProject(
    dropUndefined({
      description: stringFlag(context, "description"),
      identifier: stringFlag(context, "identifier"),
      name: requiredFlag(context, "name"),
      project_lead: stringFlag(context, "lead"),
    }),
  );
  return { data: project, human: `Created project ${project.name ?? project.id}`, workspace };
}

async function projectUpdate(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const project = await resolveProject(client, requiredArg(context, 0, "project"));
  const data = await client.updateProject(
    String(project.id),
    dropUndefined({
      description: stringFlag(context, "description"),
      identifier: stringFlag(context, "identifier"),
      name: stringFlag(context, "name"),
      project_lead: stringFlag(context, "lead"),
    }),
  );
  return { data, workspace };
}

async function projectArchive(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, workspace } = await clientFor(context);
  const project = await resolveProject(client, requiredArg(context, 0, "project"));
  return { data: await client.archiveProject(String(project.id)), workspace };
}

async function projectUnarchive(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const project = await resolveProject(client, requiredArg(context, 0, "project"));
  return { data: await client.unarchiveProject(String(project.id)), workspace };
}

async function projectDelete(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, workspace } = await clientFor(context);
  const project = await resolveProject(client, requiredArg(context, 0, "project"));
  return { data: await client.deleteProject(String(project.id)), workspace };
}

async function issueList(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const data = await client.listWorkItems(String(project.id), issueListQueryFlags(context));
  return { data: enrichItems(data, project), workspace };
}

async function issueSearch(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const projectLookup = stringFlag(context, "project") ?? (await repoProject(context));
  const project = projectLookup ? await resolveProject(client, projectLookup) : undefined;
  const data = await client.searchWorkItems(
    dropUndefined({
      limit: numberFlag(context, "limit"),
      project_id: project?.id === undefined ? undefined : String(project.id),
      search: requiredFlag(context, "query"),
      workspace_search: context.flags["workspace-search"] ? true : undefined,
    }) as Query,
  );
  return { data, workspace };
}

async function issueAdvancedSearch(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const projectLookup = stringFlag(context, "project") ?? (await repoProject(context));
  const project = projectLookup ? await resolveProject(client, projectLookup) : undefined;
  const data = await client.advancedSearchWorkItems(
    dropUndefined({
      filters: await filtersInput(context),
      limit: numberFlag(context, "limit"),
      project_id: project?.id === undefined ? undefined : String(project.id),
      query: stringFlag(context, "query"),
      workspace_search: context.flags["workspace-search"] ? true : undefined,
    }),
  );
  return { data, workspace };
}

async function issueGet(context: CommandContext): Promise<CommandResult> {
  const { client, workspace } = await clientFor(context);
  const issue = requiredArg(context, 0, "issue");
  const projectLookup = stringFlag(context, "project") ?? (await repoProject(context));
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issue) && !projectLookup) {
    return { data: await client.getWorkItemByIdentifier(issue), workspace };
  }
  const project = await getProjectForLookup(client, projectLookup);
  const data = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issue)
    ? await client.getWorkItemByIdentifier(issue)
    : await client.getWorkItem(String(project.id), issue, queryFlags(context));
  return { data: enrichItem(data, project), workspace };
}

async function issueCreate(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const data = await client.createWorkItem(
    String(project.id),
    dropUndefined({
      assignees: arrayFlag(context, "assignee"),
      description:
        stringFlag(context, "description") ?? (await fileFlag(context, "description-file")),
      labels: arrayFlag(context, "label"),
      name: requiredFlag(context, "title"),
      parent: stringFlag(context, "parent"),
      priority: stringFlag(context, "priority"),
      state: stringFlag(context, "state"),
      start_date: stringFlag(context, "start-date"),
      target_date: stringFlag(context, "target-date"),
      type_id: stringFlag(context, "type-id"),
    }),
  );
  const enriched = enrichItem(data, project);
  return { data: enriched, human: `Created ${enriched.identifier ?? enriched.id}`, workspace };
}

async function issueUpdate(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const issue = requiredArg(context, 0, "issue");
  const issueId = await resolveIssueId(client, project, issue);
  const data = await client.updateWorkItem(
    String(project.id),
    issueId,
    dropUndefined({
      assignees: context.flags.assignee === "none" ? [] : arrayFlag(context, "assignee"),
      description:
        stringFlag(context, "description") ?? (await fileFlag(context, "description-file")),
      labels: arrayFlag(context, "label"),
      name: stringFlag(context, "title"),
      parent: stringFlag(context, "parent"),
      priority: stringFlag(context, "priority"),
      state: stringFlag(context, "state"),
      start_date: stringFlag(context, "start-date"),
      target_date: stringFlag(context, "target-date"),
      type_id: stringFlag(context, "type-id"),
    }),
  );
  return { data: enrichItem(data, project), workspace };
}

async function issueDelete(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(client, project, requiredArg(context, 0, "issue"));
  return { data: await client.deleteWorkItem(String(project.id), issueId), workspace };
}

async function issueTypeSchema(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const data = await client.getWorkItemTypeSchema(
    String(project.id),
    dropUndefined({
      include: stringFlag(context, "include"),
      type_id: stringFlag(context, "type-id"),
    }) as Query,
  );
  return { data, workspace };
}

async function issueTypeList(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  return {
    data: await client.listWorkItemTypes(String(project.id), queryFlags(context)),
    workspace,
  };
}

async function linkList(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 0);
  return {
    data: await client.listLinks(String(project.id), issueId, queryFlags(context)),
    workspace,
  };
}

async function linkGet(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.getLink(
      String(project.id),
      issueId,
      requiredArg(context, 0, "link"),
      queryFlags(context),
    ),
    workspace,
  };
}

async function linkCreate(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 0);
  return {
    data: await client.createLink(
      String(project.id),
      issueId,
      dropUndefined({ title: stringFlag(context, "title"), url: requiredFlag(context, "url") }),
    ),
    workspace,
  };
}

async function linkUpdate(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.updateLink(
      String(project.id),
      issueId,
      requiredArg(context, 0, "link"),
      dropUndefined({ title: stringFlag(context, "title"), url: stringFlag(context, "url") }),
    ),
    workspace,
  };
}

async function linkDelete(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.deleteLink(String(project.id), issueId, requiredArg(context, 0, "link")),
    workspace,
  };
}

async function attachmentList(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 0);
  return {
    data: await client.listAttachments(String(project.id), issueId, queryFlags(context)),
    workspace,
  };
}

async function attachmentGet(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.getAttachment(
      String(project.id),
      issueId,
      requiredArg(context, 0, "attachment"),
    ),
    workspace,
  };
}

async function attachmentRequestUpload(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 0);
  return {
    data: await client.requestAttachmentUpload(
      String(project.id),
      issueId,
      attachmentUploadPayload(context),
    ),
    workspace,
  };
}

async function attachmentComplete(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.completeAttachmentUpload(
      String(project.id),
      issueId,
      requiredArg(context, 0, "attachment"),
    ),
    workspace,
  };
}

async function attachmentUpload(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 0);
  const path = requiredFlag(context, "file");
  const stats = await stat(path);
  const name = stringFlag(context, "name") ?? basename(path);
  const type = stringFlag(context, "type") ?? "application/octet-stream";
  const credentials = await client.requestAttachmentUpload(
    String(project.id),
    issueId,
    dropUndefined({
      external_id: stringFlag(context, "external-id"),
      external_source: stringFlag(context, "external-source"),
      name,
      size: stats.size,
      type,
    }),
  );
  const upload = await client.uploadAttachmentFile(credentials, {
    bytes: await readFile(path),
    name,
    type,
  });
  const attachmentId = attachmentIdFromCredentials(credentials);
  const attachment = attachmentId
    ? await client.completeAttachmentUpload(String(project.id), issueId, attachmentId)
    : credentials;
  return { data: { attachment, upload }, workspace };
}

async function attachmentUpdate(context: CommandContext): Promise<CommandResult> {
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.updateAttachment(
      String(project.id),
      issueId,
      requiredArg(context, 0, "attachment"),
      dropUndefined({
        attributes: attachmentAttributes(context),
        name: stringFlag(context, "name"),
        type: stringFlag(context, "type"),
      }),
    ),
    workspace,
  };
}

async function attachmentDelete(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, issueId, project, workspace } = await clientProjectIssue(context, 1);
  return {
    data: await client.deleteAttachment(
      String(project.id),
      issueId,
      requiredArg(context, 0, "attachment"),
    ),
    workspace,
  };
}

function resourceList(resource: ProjectResource): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    return {
      data: await client.listResource(String(project.id), resource, queryFlags(context)),
      workspace,
    };
  };
}

function resourceCreate(resource: ProjectResource): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    const data = await client.createResource(
      String(project.id),
      resource,
      resourcePayload(context),
    );
    return { data, workspace };
  };
}

function resourceUpdate(resource: ProjectResource): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    const data = await client.updateResource(
      String(project.id),
      resource,
      requiredArg(context, 0, "id"),
      resourcePayload(context, false),
    );
    return { data, workspace };
  };
}

function resourceDelete(resource: ProjectResource): CommandHandler {
  return async (context) => {
    requireConfirm(context);
    const { client, project, workspace } = await clientAndProject(context);
    return {
      data: await client.deleteResource(
        String(project.id),
        resource,
        requiredArg(context, 0, "id"),
      ),
      workspace,
    };
  };
}

function containerAddItem(resource: "cycles" | "modules"): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    const issueId = await resolveIssueId(client, project, requiredArg(context, 1, "issue"));
    return {
      data: await client.addItemToContainer(
        String(project.id),
        resource,
        requiredArg(context, 0, "container"),
        [issueId],
      ),
      workspace,
    };
  };
}

function containerRemoveItem(resource: "cycles" | "modules"): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    const issueId = await resolveIssueId(client, project, requiredArg(context, 1, "issue"));
    return {
      data: await client.removeItemFromContainer(
        String(project.id),
        resource,
        requiredArg(context, 0, "container"),
        issueId,
      ),
      workspace,
    };
  };
}

function containerItems(resource: "cycles" | "modules"): CommandHandler {
  return async (context) => {
    const { client, project, workspace } = await clientAndProject(context);
    return {
      data: await client.listContainerItems(
        String(project.id),
        resource,
        requiredArg(context, 0, "container"),
      ),
      workspace,
    };
  };
}

async function commentList(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(client, project, requiredArg(context, 0, "issue"));
  return { data: await client.listComments(String(project.id), issueId), workspace };
}

async function commentCreate(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(client, project, requiredArg(context, 0, "issue"));
  return {
    data: await client.createComment(String(project.id), issueId, requiredFlag(context, "body")),
    workspace,
  };
}

async function commentUpdate(context: CommandContext): Promise<CommandResult> {
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(client, project, requiredArg(context, 1, "issue"));
  return {
    data: await client.updateComment(
      String(project.id),
      issueId,
      requiredArg(context, 0, "comment"),
      requiredFlag(context, "body"),
    ),
    workspace,
  };
}

async function commentDelete(context: CommandContext): Promise<CommandResult> {
  requireConfirm(context);
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(client, project, requiredArg(context, 1, "issue"));
  return {
    data: await client.deleteComment(
      String(project.id),
      issueId,
      requiredArg(context, 0, "comment"),
    ),
    workspace,
  };
}

async function clientFor(
  context: CommandContext,
): Promise<{ client: PlaneClient; workspace: WorkspaceConfig }> {
  const resolution = await resolveCurrentWorkspace(context);
  return {
    client: new PlaneClient(resolution.workspace, { fetch: context.fetch }),
    workspace: resolution.workspace,
  };
}

async function clientAndProject(
  context: CommandContext,
): Promise<{ client: PlaneClient; project: JsonObject; workspace: WorkspaceConfig }> {
  const { client, workspace } = await clientFor(context);
  return {
    client,
    project: await getProjectForLookup(
      client,
      stringFlag(context, "project") ?? (await repoProject(context)),
    ),
    workspace,
  };
}

async function getProjectForLookup(
  client: PlaneClient,
  lookup: string | undefined,
): Promise<JsonObject> {
  if (!lookup) {
    throw new ValidationAppError("Project is required for this command.", {
      hint: "Pass --project <name-or-id> or set project in .plane-cli-workspace.",
    });
  }
  return resolveProject(client, lookup);
}

async function clientProjectIssue(
  context: CommandContext,
  issueArgIndex: number,
): Promise<{
  client: PlaneClient;
  issueId: string;
  project: JsonObject;
  workspace: WorkspaceConfig;
}> {
  const { client, project, workspace } = await clientAndProject(context);
  const issueId = await resolveIssueId(
    client,
    project,
    requiredArg(context, issueArgIndex, "issue"),
  );
  return { client, issueId, project, workspace };
}

async function resolveCurrentWorkspace(context: CommandContext) {
  const config = await loadConfig(loadOptions(context));
  const repo = await loadRepoWorkspaceHint({ cwd: context.cwd });
  return resolveWorkspace({
    config,
    envWorkspace: context.env.PLANE_WORKSPACE,
    explicitWorkspace: stringFlag(context, "workspace"),
    repoWorkspace: repo?.workspace,
  });
}

function loadOptions(context: CommandContext): ConfigLoadOptions {
  return { cwd: context.cwd, env: context.env, home: context.home };
}

async function repoProject(context: CommandContext): Promise<string | undefined> {
  return (await loadRepoWorkspaceHint({ cwd: context.cwd }))?.project;
}

function queryFlags(context: CommandContext): Query {
  return dropUndefined({
    cursor: stringFlag(context, "cursor"),
    expand: stringFlag(context, "expand"),
    fields: stringFlag(context, "fields"),
    order_by: stringFlag(context, "order-by"),
    per_page: numberFlag(context, "per-page"),
  }) as Query;
}

function issueListQueryFlags(context: CommandContext): Query {
  return dropUndefined({
    ...queryFlags(context),
    state: stringFlag(context, "state"),
    assignee: stringFlag(context, "assignee"),
    label: stringFlag(context, "label"),
  }) as Query;
}

function resourcePayload(context: CommandContext, requireName = true): JsonObject {
  return dropUndefined({
    color: stringFlag(context, "color"),
    description: stringFlag(context, "description"),
    end_date: stringFlag(context, "end-date"),
    group: stringFlag(context, "group"),
    name: requireName ? requiredFlag(context, "name") : stringFlag(context, "name"),
    start_date: stringFlag(context, "start-date"),
    target_date: stringFlag(context, "target-date"),
  });
}

async function resolveIssueId(
  client: PlaneClient,
  project: JsonObject,
  issue: string,
): Promise<string> {
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issue)) {
    const resolved = await client.getWorkItemByIdentifier(issue);
    return String(resolved.id);
  }
  return issue;
}

function enrichItems(items: JsonObject[], project: JsonObject): JsonObject[] {
  return items.map((item) => enrichItem(item, project));
}

function enrichItem(item: JsonObject, project: JsonObject): JsonObject {
  return { identifier: identifierFromWorkItem(item, project), ...item };
}

async function fileFlag(context: CommandContext, name: string): Promise<string | undefined> {
  const path = stringFlag(context, name);
  return path ? readFile(path, "utf8") : undefined;
}

async function filtersInput(context: CommandContext): Promise<JsonObject | undefined> {
  const inline = stringFlag(context, "filters-json");
  const file = stringFlag(context, "filters-file");
  const raw = inline ?? (file ? await readFile(file, "utf8") : undefined);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationAppError("Search filters must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationAppError("Search filters must be a JSON object.");
  }
  return parsed as JsonObject;
}

function attachmentUploadPayload(context: CommandContext): JsonObject {
  return dropUndefined({
    external_id: stringFlag(context, "external-id"),
    external_source: stringFlag(context, "external-source"),
    name: requiredFlag(context, "name"),
    size: requiredNumberFlag(context, "size"),
    type: stringFlag(context, "type"),
  });
}

function attachmentAttributes(context: CommandContext): JsonObject | undefined {
  const attributes = dropUndefined({
    name: stringFlag(context, "name"),
    type: stringFlag(context, "type"),
  });
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function attachmentIdFromCredentials(credentials: JsonObject): string | undefined {
  for (const key of ["id", "attachment_id"]) {
    const value = credentials[key];
    if (typeof value === "string") return value;
  }
  const attachment = credentials.attachment;
  if (typeof attachment === "object" && attachment !== null && !Array.isArray(attachment)) {
    const value = (attachment as JsonObject).id;
    if (typeof value === "string") return value;
  }
  const assetId = credentials.asset_id;
  if (typeof assetId === "string") return assetId;
  const asset = credentials.asset;
  if (typeof asset === "object" && asset !== null && !Array.isArray(asset)) {
    const value = (asset as JsonObject).id;
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function discoverWorkspaceSlugFromAppInstallation(options: {
  accessToken: string;
  appInstallationId: string;
  baseUrl: string;
  fetch?: FetchLike;
  workspace: string;
}): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const url = new URL("/auth/o/app-installation/", `${options.baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("id", options.appInstallationId);
  const response = await fetcher(url.toString(), {
    headers: authHeaders({ accessToken: options.accessToken, type: "oauth" }),
    method: "GET",
  });
  const text = await response.text();
  const body = text ? safeJsonObject(text) : {};
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PLANE_AUTH_FAILED",
      "Plane rejected the OAuth token while discovering app installation.",
      exitCodes.auth,
      {
        status: response.status,
      },
    );
  }
  if (response.status === 404) {
    throw new AppError(
      "NOT_FOUND",
      "Plane app installation endpoint was not found.",
      exitCodes.notFound,
      {
        status: response.status,
      },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AppError(
      "API_ERROR",
      `Plane app installation lookup failed with status ${response.status}`,
      exitCodes.api,
      {
        body,
        status: response.status,
      },
    );
  }

  const installations = workspaceObjects(body);
  const match =
    matchWorkspace(installations, options.workspace) ??
    (installations.length === 1 ? installations[0] : undefined);
  const slug = match ? workspaceSlugFromObject(match) : undefined;
  if (!slug) {
    throw new ValidationAppError(
      "Could not discover the Plane workspace slug from the app installation.",
      {
        appInstallationId: options.appInstallationId,
        hint: "Use --workspace with the Plane workspace name or slug, or pass --workspace-slug as an override.",
        workspace: options.workspace,
        workspaceCount: installations.length,
      },
    );
  }
  return slug;
}

async function discoverWorkspaceSlug(options: {
  auth: NonNullable<WorkspaceConfig["auth"]>;
  baseUrl: string;
  fetch?: FetchLike;
  workspace: string;
}): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(
    new URL("/api/workspaces/", `${options.baseUrl.replace(/\/+$/, "")}/`).toString(),
    {
      headers: authHeaders(options.auth),
      method: "GET",
    },
  );
  const text = await response.text();
  const body = text ? safeJsonObject(text) : {};
  if (response.status === 401 || response.status === 403) {
    throw new AppError(
      "PLANE_AUTH_FAILED",
      "Plane rejected the credentials while discovering workspaces.",
      exitCodes.auth,
      {
        status: response.status,
      },
    );
  }
  if (response.status === 404) {
    throw new AppError(
      "NOT_FOUND",
      "Plane workspace discovery endpoint was not found.",
      exitCodes.notFound,
      {
        status: response.status,
      },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AppError(
      "API_ERROR",
      `Plane workspace discovery failed with status ${response.status}`,
      exitCodes.api,
      {
        body,
        status: response.status,
      },
    );
  }

  const workspaces = workspaceObjects(body);
  const match =
    matchWorkspace(workspaces, options.workspace) ??
    (workspaces.length === 1 ? workspaces[0] : undefined);
  const slug = match ? workspaceSlugFromObject(match) : undefined;
  if (!slug) {
    throw new ValidationAppError("Could not discover the Plane workspace slug.", {
      hint: "Use --workspace with the Plane workspace name or slug, or pass --workspace-slug as an override.",
      workspace: options.workspace,
      workspaceCount: workspaces.length,
    });
  }
  return slug;
}

function authHeaders(auth: NonNullable<WorkspaceConfig["auth"]>): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth.type === "oauth") headers.Authorization = `Bearer ${auth.accessToken}`;
  else headers["X-API-Key"] = auth.apiKey;
  return headers;
}

function workspaceObjects(body: unknown): JsonObject[] {
  const candidates = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? [
          (body as JsonObject).results,
          (body as JsonObject).workspaces,
          (body as JsonObject).workspace,
          (body as JsonObject).data,
        ]
      : [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isJsonObject);
    }
    if (isJsonObject(candidate)) return [candidate];
  }
  return [];
}

function matchWorkspace(workspaces: JsonObject[], lookup: string): JsonObject | undefined {
  const normalized = normalizeLookup(lookup);
  return workspaces.find((workspace) =>
    [
      workspace.id,
      workspace.name,
      workspace.slug,
      workspace.workspace_slug,
      workspace.display_name,
      workspace.displayName,
      workspace.workspace,
      typeof workspace.workspace_detail === "object" && workspace.workspace_detail !== null
        ? (workspace.workspace_detail as JsonObject).name
        : undefined,
      typeof workspace.workspace_detail === "object" && workspace.workspace_detail !== null
        ? (workspace.workspace_detail as JsonObject).slug
        : undefined,
    ].some((value) => normalizeLookup(value) === normalized),
  );
}

function workspaceSlugFromObject(workspace: JsonObject): string | undefined {
  const direct = stringValue(workspace, "slug") ?? stringValue(workspace, "workspace_slug");
  if (direct) return direct;
  const detail = workspace.workspace_detail;
  if (isJsonObject(detail)) return workspaceSlugFromObject(detail);
  const nested = workspace.workspace;
  if (isJsonObject(nested)) return workspaceSlugFromObject(nested);
  return undefined;
}

function safeJsonObject(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text };
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeLookup(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function stringFlag(context: CommandContext, name: string): string | undefined {
  const value = context.flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
}

function arrayFlag(context: CommandContext, name: string): string[] | undefined {
  const value = context.flags[name];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return undefined;
}

function scopesFlag(context: CommandContext): string[] | undefined {
  const scopes = arrayFlag(context, "scope");
  if (!scopes?.length) return undefined;
  return scopes.flatMap((value) => value.split(/[,\s]+/)).filter(Boolean);
}

function numberFlag(context: CommandContext, name: string): number | undefined {
  const value = stringFlag(context, name);
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ValidationAppError(`--${name} must be a number`);
  return number;
}

function booleanFlag(context: CommandContext, name: string): boolean | undefined {
  const value = context.flags[name];
  if (Array.isArray(value)) return parseBooleanFlag(name, value.at(-1));
  return parseBooleanFlag(name, value);
}

function parseBooleanFlag(name: string, value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new ValidationAppError(`--${name} must be true or false`);
}

function requiredNumberFlag(context: CommandContext, name: string): number {
  const number = numberFlag(context, name);
  if (number === undefined) throw new ValidationAppError(`Missing required flag --${name}`);
  return number;
}

function requiredFlag(context: CommandContext, name: string): string {
  const value = stringFlag(context, name);
  if (!value) throw new ValidationAppError(`Missing required flag --${name}`);
  return value;
}

function requiredArg(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (!value) throw new ValidationAppError(`Missing required argument ${name}`);
  return value;
}

function requireConfirm(context: CommandContext): void {
  if (!isExplicitConfirm(context.flags.confirm)) {
    throw new ValidationAppError("Destructive commands require --confirm.");
  }
}

function isExplicitConfirm(value: string | boolean | string[] | undefined): boolean {
  if (value === true || value === "true") return true;
  return Array.isArray(value) && value.length > 0 && value.every((item) => item === "true");
}

async function waitForOAuthCode(options: {
  openBrowser: boolean;
  port: number;
  state: string;
  url: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new ValidationAppError("Timed out waiting for Plane OAuth callback."));
      },
      5 * 60 * 1000,
    );

    const server = createServer((request, response) => {
      try {
        const callbackUrl = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);
        if (callbackUrl.pathname !== "/callback") {
          response.writeHead(404, { "Content-Type": "text/plain" });
          response.end("Not found");
          return;
        }
        const error = callbackUrl.searchParams.get("error");
        if (error) throw new ValidationAppError(`Plane OAuth returned error: ${error}`);
        const code = callbackUrl.searchParams.get("code");
        const state = callbackUrl.searchParams.get("state");
        if (!code) throw new ValidationAppError("Plane OAuth callback did not include a code.");
        if (state !== options.state)
          throw new ValidationAppError("Plane OAuth callback state did not match.");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          "<html><body><h1>Plane CLI login complete</h1><p>You can close this window.</p></body></html>",
        );
        clearTimeout(timeout);
        server.close();
        resolve(code);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain" });
        response.end(error instanceof Error ? error.message : "OAuth callback failed");
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });

    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(options.port, "127.0.0.1", () => {
      if (options.openBrowser) openUrl(options.url);
    });
  });
}

function openUrl(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function exitCodeForError(error: unknown): number {
  return error instanceof AppError ? error.exitCode : exitCodes.generic;
}
