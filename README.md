# OpenCode Usage

An OpenCode V2 plugin that displays the selected provider's account quota in the home and running-session footers.

## Features

- Shows remaining five-hour and seven-day quota percentages and reveals reset times on hover, or the reason when data is unavailable.
- Supports OpenAI ChatGPT and Claude Agent subscription usage.
- Uses the active OpenCode-managed ChatGPT OAuth account or Claude Code login.
- Keeps credentials server-side and does not write them to plugin storage.
- Reports when the active account's ChatGPT usage limit already blocks its model requests.
- Refreshes at startup, when switching session tabs, at the focused session's turn start and end, after an account switch, when the selected model or variant changes, and when the active location changes. Claude usage requests share an in-flight lookup and are cached for at least one minute to limit requests to its usage endpoint.

## Requirements

- OpenCode V2.
- Bun for installation and development commands.
- For OpenAI: an active ChatGPT OAuth connection. OpenAI's usage API only accepts connections
  that store a ChatGPT account ID, which the legacy Codex sign-in methods provide. The newer
  Sign in with ChatGPT flow does not expose the usage API, so its connections show a reason instead of
  quota values.
- For Claude Agent: an active Claude Code external connection for `claude-agent` and a Claude subscription login through a current
  Claude Code CLI on Linux. The plugin reads the login from `CLAUDE_CONFIG_DIR` (or `~/.claude`) using
  `claude auth status`, then reads `.credentials.json` server-side. `CLAUDE_CODE_OAUTH_TOKEN` takes
  precedence when set. API keys, cloud providers, and custom endpoints do not expose subscription quota.
  Claude Code owns login renewal; the plugin never refreshes or modifies its credentials.
  The selected model and variant's connection settings apply to quota lookup. The CLI is selected through
  `OPENCODE_CLAUDE_PATH` when set, otherwise `claude` on `PATH`.

## Global GitHub installation

Choose the latest release from the repository's Releases section on GitHub. Replace `<release-tag>` below with that
release's tag and add the Git package to the global OpenCode configuration at `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-usage@git+https://github.com/mdc-git/opencode-usage.git#<release-tag>"]
}
```

OpenCode loads the server and TUI entrypoints from the package together.

## Local checkout

Install dependencies and run OpenCode from the repository root:

```sh
bun install --frozen-lockfile
opencode --standalone
```

The project configuration disables the deployed plugin identities and loads the local wrappers from `.opencode/`.

## Usage

Start OpenCode with the plugin enabled. When an OpenAI or Claude Agent model is selected, the home and running-session footers display
the active account and quota values in this format by default:

```text
OpenAI account@example.com · 76% · 42%
Claude Agent account@example.com · 76% · 42%
```

Hovering the quota shows the remaining time until each reset:

```text
in 3:42 · in 3d 23:19
```

When no data is available, the hover shows the reason instead. OpenAI's newer Sign in with ChatGPT flow
does not expose its usage API, so connections signed in that way show why nothing can be displayed, and
show `Usage limit reached` once this account's model requests report hitting the limit.

The account label comes from the active OpenCode connection for OpenAI and `claude auth status` for Claude Agent.
Claude usage comes from Anthropic's undocumented OAuth usage endpoint. If it rejects the request or returns no
quota windows, hovering the quota shows the reason. Other providers do not display a quota.

## Development

Install dependencies:

```sh
bun install --frozen-lockfile
```

Run repository checks:

```sh
bun run check
```

Inspect the distributable package contents:

```sh
bun pm pack --dry-run
```

Production source lives under `plugins/usage/`. The `.opencode/` directory contains only local checkout wrappers and
configuration.
