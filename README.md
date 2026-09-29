# OpenCode Usage

This project contains a combined OpenCode server and TUI plugin for displaying provider quota information in the TUI footer.

Production source lives under `plugins/usage`. The `.opencode` directory contains local wrappers and checkout configuration. The server wrapper registers a typed `opencode.usage` RPC, and the TUI wrapper contributes a compact status to `prompt.footer.status`.

## Local setup

Install dependencies with Bun:

```sh
bun install
```

Run OpenCode from this directory. The local `.opencode/opencode.jsonc` disables the deployed server ID and loads the local wrappers.

The status refreshes at startup, every 60 seconds, and when the active OpenAI account changes.

To enable the checkout from another OpenCode location, add the absolute `.opencode` directory to the global `plugins` list in `opencode.jsonc`.

## Provider adapters

Provider-specific quota APIs are intentionally kept in `plugins/usage/quota.ts`. Each adapter can use the server plugin context to resolve an OpenCode connection, call the provider usage endpoint, and return normalized quota snapshots.

The OpenAI adapter reads the active ChatGPT OAuth account and displays its Codex windows as remaining percentages with compact reset times. Switching the active OpenAI account with `/connect` triggers an immediate refresh.

The footer displays the provider account and remaining windows when an adapter returns a snapshot. API keys and resolved credentials are not written to plugin storage.

## Validation

```sh
bun run check
```
