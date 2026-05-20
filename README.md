<p>
  <img src="logo.svg" alt="opencode-presets" width="720">
</p>

Small CLI that patches `~/.config/opencode/opencode.json` from
prepared presets. Use it to add LSP overrides, MCP servers, and
permission rules without hand-editing JSON.

## Install

```sh
npm install -g opencode-presets
```

Needs Node 22+.

## Use

```sh
opencode-presets list                              # what's available
opencode-presets install jdtls-lombok             # apply one preset by name
opencode-presets install jdtls-lombok permissions-git-safe
opencode-presets remove jdtls-lombok              # undo a preset
opencode-presets install --reset permission ./presets/foo.conf  # wipe then install
opencode-presets reset permission                 # wipe a section outright
```

Bare names are resolved through the preset search path (see "Where
presets are found" below). You can always pass an explicit path
instead, e.g. `install ./presets/jdtls-lombok.conf`.

Every change shows a diff and asks before touching anything. A
backup is written to `~/.cache/opencode-presets/backups/` before
each write — no auto-pruning, so they pile up.

### Non-interactive prompt values (`--set` / `--set-env`)

Presets with `@prompt` directives normally ask interactively. To
drive them from a script (or just paste a one-liner from a wiki),
pre-fill any prompt with `--set NAME=VALUE`:

```sh
opencode-presets install mcp-http \
  --set name=openrag \
  --set url=https://openrag.example.internal/mcp \
  --set headerName=X-Bitbucket-Token \
  --set 'headerValue=raw-token-here'
```

**Quote values that contain shell metacharacters** (`$`, `!`, `*`,
backticks, spaces, etc.) with single quotes — otherwise the shell
expands them before `opencode-presets` ever sees the value. A
Bitbucket PAT that starts with `$` will silently turn into an empty
string without quoting.

For secrets, prefer `--set-env NAME=ENV_VAR`. The CLI reads the
value from the named environment variable at install time, so the
token never appears in shell history or process listings:

```sh
export BITBUCKET_TOKEN=…
opencode-presets install mcp-http \
  --set name=openrag \
  --set url=https://openrag.example.internal/mcp \
  --set headerName=X-Bitbucket-Token \
  --set-env headerValue=BITBUCKET_TOKEN
```

`--set` / `--set-env` apply to a single preset per invocation — run
the command once per preset rather than bundling several with shared
flags. This keeps the wiring obvious ("this `--set` goes to *that*
preset") and avoids surprise: in a non-TTY shell script, a bundled
install would happily fill the first preset's prompts and then hang
on a readline for the next.

## Built-in presets

| Preset | Category | Mode | Description |
| --- | --- | --- | --- |
| `jdtls-lombok` | LSP | replace | Makes jdtls lombok-aware via `-javaagent` flag |
| `jdtls-clean-workspace` | LSP | replace | Stops jdtls from writing `.project`/`.classpath`/etc. into your project root |
| `mcp-http` | MCP | replace | Add an HTTP MCP server (localhost or remote) with one custom header (prompts for id, URL, header name, header value) |
| `mcp-http-noauth` | MCP | replace | Add an HTTP MCP server (localhost or remote) without auth headers (prompts for id, URL) |
| `mcp-intellij` | MCP | replace | Add the JetBrains IDE MCP server (loopback HTTP, default port 64342) |
| `mcp-playwright` | MCP | replace | Add the Playwright MCP server (`@playwright/mcp`, local stdio via npx) |
| `mcp-vscode` | MCP | replace | Add the VS Code MCP server via the `JuehangQin.vscode-mcp-server` extension (loopback HTTP, default port 3000) |
| `plugin-superpowers` | Plugin | append | Add the Superpowers OpenCode plugin from `obra/superpowers` (brainstorming, plans, TDD, review workflows) |
| `permissions-git-safe` | Permissions | merge | Read-only git commands (status, diff, log, branch --list, fetch, etc.) |
| `permissions-shell-safe` | Permissions | merge | Low-risk shell commands (ls, cat, grep, rg, jq, yq, etc.) |
| `permissions-build-tools` | Permissions | merge | Build tools (node, npm, mvn, gradle, make, python, pip, cargo, go) |
| `permissions-container-info` | Permissions | merge | Read-only docker, podman, oc inspection commands |
| `permissions-toolchain-info` | Permissions | merge | Version probes for common dev toolchains |
| `default-agent-plan` | Agent | replace | Sets the default agent to "plan" so opencode always starts in plan mode instead of build mode |

Install multiple at once:

```sh
opencode-presets install jdtls-lombok jdtls-clean-workspace
opencode-presets install permissions-git-safe permissions-shell-safe
```

Presets whose path uses a prompt (like `mcp-http`) can't be
removed with `remove` — use `reset` instead:

```sh
opencode-presets reset mcp.openrag-tom
```

## Modes

- `replace` — the preset owns the value at `@path`. Re-installing
  overwrites whatever's there.
- `merge` — the preset's keys are added; existing keys (yours or
  someone else's) are never overwritten. Use this for permission
  rules so user edits stick around.
- `append` — the preset's array entries are appended if missing;
  existing array entries are preserved. Use this for shared arrays
  like `plugin`.

Re-installing is always safe: a no-op produces no backup and no
write.

Plugin changes are loaded by opencode at startup. After installing a
plugin preset such as `plugin-superpowers`, quit and restart opencode.

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
// @name: my-preset
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
