# plane-cli

Machine-friendly TypeScript CLI for Plane.so, designed for LLM agents and automation scripts.

The CLI binary is `plane-cli`.

This project is not affiliated with Plane.

> [!NOTE]
> This project is built for LLM agents and was developed with substantial LLM
> assistance. Its primary interface is stable JSON for automation, not
> interactive human CLI ergonomics.

## Install

```bash
bun install
bun run build
```

Run locally after building:

```bash
./dist/plane-cli --help
./dist/plane-cli project list --json
```

During development:

```bash
bun src/index.ts project list --json
```

## Plane API Model

Plane's public API is REST. Plane Cloud uses:

```text
https://api.plane.so/
```

Self-hosted Plane instances can use a custom `baseUrl` per workspace. The CLI
authenticates with `X-API-Key` for personal access tokens or OAuth bearer tokens
from a Plane app. Secrets are kept out of JSON output.

## Multi-Workspace Auth

The CLI searches these config files, in order:

```text
.plane-cli.yaml
.plane-cli.json
~/.config/plane-cli/config.yaml
~/.config/plane-cli/config.json
```

YAML example:

```yaml
defaultWorkspace: personal

workspaces:
  personal:
    workspaceSlug: my-team
    apiKey: plane_api_xxx

  selfhosted:
    workspaceSlug: engineering
    baseUrl: https://plane.example.com
    apiKey: plane_api_yyy

  enterprise-oauth:
    workspaceSlug: engineering
    baseUrl: https://plane.example.com
    auth:
      type: oauth
      flow: client_credentials
      clientId: plane_oauth_client_id
      clientSecret: plane_oauth_client_secret
      appInstallationId: plane_app_installation_id
      accessToken: plane_oauth_access_token
```

Namespaced environment variables may override config API keys:

```bash
export PLANE_API_KEY_PERSONAL="plane_api_xxx"
export PLANE_WORKSPACE="personal"
```

Workspace names are uppercased and non-alphanumeric characters become
underscores. For example, `engineering-prod` maps to
`PLANE_API_KEY_ENGINEERING_PROD`.

## Repo Workspace Hint

To bind a repository checkout to a configured Plane workspace, add a dotfile at
the repo root:

```bash
printf "personal\n" > .plane-cli-workspace
```

To also bind issue commands to a default Plane project, use YAML:

```yaml
workspace: personal
project: Web
```

The project hint is used as the default `--project` for project-scoped commands.
An explicit `--project` flag always wins.

## Login With API Key

Add or update a workspace API key:

```bash
plane-cli auth api-key \
  --workspace personal \
  --api-key "$PLANE_API_KEY" \
  --default \
  --json
```

For self-hosted Plane:

```bash
plane-cli auth api-key \
  --workspace selfhosted \
  --base-url https://plane.example.com \
  --api-key "$PLANE_API_KEY" \
  --json
```

## Login With a Plane OAuth App

For self-hosted Plane Enterprise, create a Plane app in the workspace
integrations UI and use the instance URL as `--base-url`.

For LLM agents and automation, use the bot/app-installation flow:

```bash
plane-cli auth oauth bot \
  --workspace zoo \
  --base-url https://plane.thezoo.house \
  --client-id "$PLANE_OAUTH_CLIENT_ID" \
  --client-secret "$PLANE_OAUTH_CLIENT_SECRET" \
  --app-installation-id "$PLANE_APP_INSTALLATION_ID" \
  --default \
  --json
```

For a Linear-style browser login as your user, register this redirect URI in the
Plane app first:

```text
http://127.0.0.1:8717/callback
```

Then run:

```bash
plane-cli auth oauth login \
  --workspace zoo \
  --base-url https://plane.thezoo.house \
  --client-id "$PLANE_OAUTH_CLIENT_ID" \
  --client-secret "$PLANE_OAUTH_CLIENT_SECRET" \
  --default \
  --json
```

If you need a different callback URL, pass `--redirect-uri` and make sure the
same URL is configured in the Plane app. The CLI discovers the Plane
`workspaceSlug` during auth setup and stores it in config. `--workspace-slug`
exists only as an override for unusual server responses.

## JSON Contract

Successful JSON output:

```json
{
  "ok": true,
  "workspace": "personal",
  "data": {}
}
```

Error JSON output:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Missing required flag --project",
    "details": {}
  }
}
```

## Hosted MCP Server

The hosted MCP server exposes every CLI command as a typed MCP tool over
Streamable HTTP. Codex and Hermes can defer or search tools client-side; the
server still returns the full typed Plane tool catalog from `tools/list`.

Build and run locally:

```bash
bun run build
PORT=3000 PLANE_CLI_HOME="$HOME" node dist/mcp/index.js
```

Connect MCP clients to:

```text
http://localhost:3000/mcp
```

Docker image:

```bash
docker build -t plane-cli-mcp .
docker run --rm -p 3000:3000 \
  -e PLANE_MCP_AUTH_TOKEN="$PLANE_MCP_AUTH_TOKEN" \
  -e PLANE_MCP_REDIS_URL="$PLANE_MCP_REDIS_URL" \
  -v "$HOME/.config/plane-cli:/data/.config/plane-cli:ro" \
  plane-cli-mcp
```

The container runs only the hosted MCP server. It reads Plane configuration the
same way as the CLI, with `PLANE_CLI_HOME` defaulting to `/data`.
Deployment-specific secret injection should happen through ordinary environment
variables or mounted config files.

Hosted MCP request handling is stateless: each HTTP request creates a fresh MCP
transport/server, while the MCP `mcp-session-id` identifies session context.
Session context is stored in memory by default. Set `PLANE_MCP_REDIS_URL` or
`REDIS_URL` to store session markers and Plane workspace/project context in
Redis instead:

```bash
PLANE_MCP_REDIS_URL=redis://redis:6379
PLANE_MCP_REDIS_PREFIX=plane-cli:mcp
PLANE_MCP_SESSION_TTL_SECONDS=86400
```

Redis keys are scoped by the MCP `mcp-session-id`, so separate agents keep
separate Plane context even when they use the same hosted MCP deployment. With a
shared Redis store, multiple replicas can handle requests for the same
`mcp-session-id`; sticky routing is not required.

For repository-specific routing, keep `.plane-cli-workspace` local to the agent
checkout. The hosted MCP server does not need repo mounts and does not maintain a
workspace mapping. Agents should read the local file once and call:

```json
{
  "tool": "plane_context_set",
  "arguments": {
    "workspace": "MaudeCode",
    "project": "Plane CLI"
  }
}
```

That stores workspace/project defaults only for the current MCP session.
Subsequent typed tools use that session context when `workspace` or `project` is
omitted. Explicit tool arguments still win.

Public binds require `PLANE_MCP_AUTH_TOKEN`; MCP clients must send it as:

```text
Authorization: Bearer <token>
```

Requests without an `Origin` header are allowed. Browser requests with an
`Origin` header are accepted only from localhost/loopback origins by default. Set
`PLANE_MCP_ALLOWED_ORIGINS` to a comma-separated allowlist when a browser-based
client must call a hosted deployment:

```bash
PLANE_MCP_ALLOWED_ORIGINS=https://codex.example,https://hermes.example
```

Localhost development can run without the token. Set
`PLANE_MCP_ALLOW_UNAUTHENTICATED=true` only when another layer already restricts
access to the endpoint.

Credentials come from mounted normal `plane-cli` config files or environment
variables only. There is no external secret store integration. Separate clients
should use separate deployments, config files, or environment sets so workspace
context and credentials stay isolated.

## Commands

```text
auth api-key --workspace name --api-key plane_api_... [--base-url url] [--workspace-slug slug] [--default]
auth oauth bot --workspace name --base-url url --client-id id --client-secret secret --app-installation-id id [--workspace-slug slug] [--default]
auth oauth login --workspace name --base-url url --client-id id --client-secret secret [--redirect-port 8717] [--redirect-uri uri] [--scope scope] [--workspace-slug slug] [--default]
auth oauth code --workspace name --base-url url --client-id id --client-secret secret --redirect-uri uri --code code [--workspace-slug slug] [--default]
auth oauth url --base-url url --client-id id --redirect-uri uri [--scope scope] [--state state]
config show
config path
workspace current [--workspace name]
workspace validate [--workspace name]
user me
member list
project list [--fields fields] [--per-page 100] [--order-by field]
project get <project>
project create --name name [--identifier KEY] [--description text]
project update <project> [--name name] [--description text] [--identifier KEY]
project archive <project> --confirm
project unarchive <project>
project delete <project> --confirm
issue list --project project [--state id] [--assignee id] [--label id] [--fields fields] [--per-page 100]
issue search --query text [--project project] [--limit 10] [--workspace-search]
issue advanced-search [--query text] [--project project] [--filters-json json | --filters-file file] [--limit 10] [--workspace-search]
issue get <KEY-123 | issue-id> [--project project]
issue create --title title [--project project] [--description markdown] [--priority urgent|high|medium|low|none] [--state state-id] [--assignee user-id] [--label label-id] [--parent issue-id]
issue update <issue> --project project [--title title] [--description markdown] [--priority priority] [--state state-id] [--assignee user-id] [--label label-id]
issue delete <issue> --project project --confirm
issue type-schema --project project [--include members,labels] [--type-id type-id]
issue type-list --project project
issue link list <issue> --project project
issue link get <link-id> <issue> --project project
issue link create <issue> --project project --url url [--title title]
issue link update <link-id> <issue> --project project [--url url] [--title title]
issue link delete <link-id> <issue> --project project --confirm
issue attachment list <issue> --project project
issue attachment get <attachment-id> <issue> --project project
issue attachment request-upload <issue> --project project --name filename --size bytes [--type mime]
issue attachment complete <attachment-id> <issue> --project project
issue attachment upload <issue> --project project --file path [--name filename] [--type mime]
issue attachment update <attachment-id> <issue> --project project [--name filename] [--type mime]
issue attachment delete <attachment-id> <issue> --project project --confirm
state|label|module|cycle|page list --project project
state|label|module|cycle|page create --project project --name name [resource flags]
state|label|module|cycle|page update <id> --project project [resource flags]
state|label|module|cycle|page delete <id> --project project --confirm
cycle|module add-item <container-id> <issue-id> --project project
cycle|module remove-item <container-id> <issue-id> --project project
cycle|module items <container-id> --project project
comment list <issue> --project project
comment create <issue> --project project --body markdown
comment update <comment-id> <issue> --project project --body markdown
comment delete <comment-id> <issue> --project project --confirm
```

Aliases include `issue`, `issues`, `wi`, `work-item`; `project`, `projects`;
`state`, `states`; `label`, `labels`; `module`, `modules`; `cycle`, `cycles`;
and `list`/`ls`.

## Development

```bash
bun run test
bun run build
bun run lint
npm pack --dry-run
```
