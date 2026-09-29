# OpenCode Usage

An OpenCode V2 plugin that displays the active OpenAI ChatGPT quota in the home and running-session footers.

## Features

- Shows remaining five-hour and seven-day quota percentages and reveals reset times on hover.
- Uses the active OpenCode-managed ChatGPT OAuth account.
- Keeps credentials server-side and does not write them to plugin storage.
- Refreshes at startup, every 60 seconds, after an OpenAI account switch, when the selected model changes provider, and when the active location changes.

## Requirements

- OpenCode V2.
- Bun for installation and development commands.
- An active OpenAI ChatGPT OAuth connection for quota data.

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

Start OpenCode with the plugin enabled. When an OpenAI model is selected, the home and running-session footers display
the active account and quota values in this format by default:

```text
OpenAI account@example.com · 76% · 42%
```

Hovering the quota shows the reset times:

```text
19:27 · in 4 Tagen, 19:45
```

The displayed times use German formatting. The account label comes from the active OpenCode connection.

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
