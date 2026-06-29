# Contributing

Run the local checks before opening a pull request:

```bash
bun install
bun run test
bun run build
bun run lint
```

This CLI is JSON-first. New commands should preserve the `{ "ok": true,
"workspace": "...", "data": ... }` success envelope and the `{ "ok": false,
"error": ... }` error envelope when `--json` is used.

Do not print API keys, OAuth tokens, or raw config secrets in command output.
