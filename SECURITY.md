# Security

Report security issues privately to the repository owner.

Do not include Plane API keys, OAuth tokens, config files with secrets, or
customer workspace data in public issues.

The CLI stores API keys in local config files and redacts secrets from
`config show --json`. Prefer environment variables or OS-level secret
management for shared machines.
