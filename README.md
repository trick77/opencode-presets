# opencode-presets

Small CLI that patches `~/.config/opencode/opencode.json` from
prepared modules. Use it to add LSP overrides, MCP servers, and
permission rules without hand-editing JSON.

## Install

```sh
npm install -g opencode-presets
```

Needs Node 22+.

## Use

```sh
opencode-presets list                              # what's available
opencode-presets install lombok                   # apply one preset by name
opencode-presets install lombok permissions-git-safe
opencode-presets remove lombok                    # undo a preset
opencode-presets install --reset permission ./presets/foo.conf  # wipe then install
opencode-presets reset permission                 # wipe a section outright
```

Bare names are resolved through the preset search path (see "Where
presets are found" below). You can always pass an explicit path
instead, e.g. `install ./presets/lombok.conf`.

Every change shows a diff and asks before touching anything. A
backup is written to `~/.cache/opencode-presets/backups/` before
each write — no auto-pruning, so they pile up.

## Built-in presets

| Preset | Mode | Category | Description |
| --- | --- | --- | --- |
| `lombok` | replace | LSP | Makes jdtls lombok-aware via `-javaagent` flag |
| `jdtls-clean-workspace` | replace | LSP | Stops jdtls from writing `.project`/`.classpath`/etc. into your project root |
| `mcp-remote-add` | replace | MCP | Add a remote MCP server with bearer-token auth (prompts for id, URL, token) |
| `mcp-remote-add-noauth` | replace | MCP | Add a remote MCP server without auth (prompts for id, URL) |
| `permissions-git-safe` | merge | Permissions | Read-only git commands (status, diff, log, branch --list, fetch, etc.) |
| `permissions-shell-safe` | merge | Permissions | Harmless shell commands (ls, cat, grep, rg, jq, yq, etc.) |
| `permissions-build-tools` | merge | Permissions | Build tools (node, npm, mvn, gradle, make, python, pip, cargo, go) |
| `permissions-container-info` | merge | Permissions | Read-only docker, podman, oc inspection commands |
| `permissions-toolchain-info` | merge | Permissions | Version probes for common dev toolchains |

Install multiple at once:

```sh
opencode-presets install lombok jdtls-clean-workspace
opencode-presets install permissions-git-safe permissions-shell-safe
```

Presets whose path uses a prompt (like `mcp-remote-add`) can't be
removed with `remove` — use `reset` instead:

```sh
opencode-presets reset mcp.openrag-tom
```

## Modes

- `replace` — the module owns the value at `@path`. Re-installing
  overwrites whatever's there.
- `merge` — the module's keys are added; existing keys (yours or
  someone else's) are never overwritten. Use this for permission
  rules so user edits stick around.

Re-installing is always safe: a no-op produces no backup and no
write.

## Where presets are found

`opencode-presets list` searches dirs in this order:

1. Anything in `$OPENCODE_PRESETS_PATH` (colon-separated).
2. `./presets/` relative to your current directory (honoured when it exists).
3. The shipped `presets/` baked into the tool.

Earlier dirs win on name collision; the lower one is still listed
but flagged `shadowed`. Pass a positional arg (`opencode-presets list
~/some/dir`) to scan exactly one dir instead.

## Bringing your own presets

For a team or cross-machine setup, keep your presets in **their own
git repo** (not in `~/.config`, not inside the cloned tool). Point
the env var at it:

```sh
# ~/.zshrc or similar
export OPENCODE_PRESETS_PATH="$HOME/work/team-opencode-presets"
```

Multiple repos? Colon-separate them, highest priority first:

```sh
export OPENCODE_PRESETS_PATH="$HOME/personal-presets:$HOME/work/team-presets"
```

For ad-hoc presets you don't want to put in a repo and don't need
on other machines, drop them in `./presets/` from wherever you run
the tool, or use `OPENCODE_PRESETS_PATH`.

## Pointing at a different opencode.json

```sh
OPENCODE_CONFIG=/path/to/other-opencode.json opencode-presets install ...
OPENCODE_PRESETS_CACHE=/some/cache opencode-presets install ...
```

## Writing your own preset

Plain JSONC with a header. Drop into one of the dirs above, or pass
an absolute path.

```jsonc
// @name: my-module
// @description: one paragraph of what this fixes / sets up.
// @author: you <you@example.com>
// @version: 1.0.0
// @path: some.dotted.path
// @mode: merge
{ "key": "value" }
```

`@fetch: <url> -> <dest> [sha256=hex]` downloads to the cache.
`@prompt: name | text|secret | help` collects input at install time.
Both repeatable. Reference fetched files as `{{cache}}/<name>` and
prompt values as `{{prompt:<name>}}` in the body or `@path`.

See the existing `presets/*.conf` for working examples.
