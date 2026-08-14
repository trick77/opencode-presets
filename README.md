<p>
  <img src="logo.svg" alt="opencode-presets" width="720">
</p>

Ready-made presets for OpenCode: permission rules, MCP servers, LSP
overrides, agent limits, TUI preferences. A small CLI merges them into
your `opencode.json` and `tui.json` so you never hand-edit the JSON.

## Install

```sh
npm install -g opencode-presets
```

Needs Node 22+.

## Built-in presets

Fresh install? Start with the permission bundle — one command, no prompts
for the everyday read-only commands, and hard blocks on the destructive ones:

```sh
opencode-presets install permissions-recommended
```

**It is opinionated, and it is not a free pass.** These are one person's
defaults for everyday work, not an audited sandbox and not a security boundary.
They cut prompting for read-only commands and hard-block a list of known
footguns — that is the whole claim. Anything not listed still falls through to a
prompt you have to read; the deny rules miss env-prefixed and `sh -c`-wrapped
invocations; and the presets you add on top can undo them. Read the rules before
trusting them, and keep deciding for yourself.

Install any row below with `opencode-presets install <preset>`. Presets that need
something outside your opencode config say so in their description.

| Preset | Category | Mode | Description |
| --- | --- | --- | --- |
| `permissions-recommended` | Permissions | bundle | **Start here.** Installs the six presets marked *In the bundle* |
| `permissions-shell-safe` | Permissions | merge | In the bundle. Low-risk shell commands (ls, cat, grep, rg, jq, yq, etc.) |
| `permissions-git-safe` | Permissions | merge | In the bundle. Read-only git commands (status, diff, log, branch --list, fetch, etc.) |
| `permissions-toolchain-info` | Permissions | merge | In the bundle. Version probes for common dev toolchains |
| `permissions-container-info` | Permissions | merge | In the bundle. Read-only docker and podman inspection commands (the `oc` rules moved to `permissions-cluster-info` in 0.2.0) |
| `permissions-deny-destructive` | Permissions | merge | In the bundle. Hard-denies `sudo`, root/home-anchored `rm -rf`, `dd`, `mkfs`, force-push, `reset --hard` |
| `permissions-deny-cluster-write` | Permissions | merge | In the bundle. Hard-denies mutating and exec `oc`, `kubectl`, `helm` verbs — no prompt, not bypassable by `--auto` |
| `permissions-build-tools` | Permissions | merge | Not in the bundle. Build tools (node, npm, mvn, gradle, make, python, pip, cargo, go) |
| `permissions-cluster-info` | Permissions | merge | Not in the bundle. Read-only `oc` (OpenShift) inspection — grants read access to whichever cluster you are logged into |
| `permissions-webfetch-ask` | Permissions | merge | Not in the bundle. Requires approval before opencode uses the webfetch tool |
| `jdtls-lombok` | LSP | replace | Makes jdtls lombok-aware via `-javaagent` flag (pins lombok 1.18.46, sha256-verified) |
| `jdtls-clean-workspace` | LSP | replace | Stops jdtls from writing `.project`/`.classpath`/etc. into your project root |
| `mcp-http` | MCP | replace | Add an HTTP MCP server (localhost or remote) with one custom header (prompts for id, URL, header name, header value) |
| `mcp-http-noauth` | MCP | replace | Add an HTTP MCP server (localhost or remote) without auth headers (prompts for id, URL) |
| `mcp-intellij` | MCP | replace | Add the JetBrains IDE MCP server (loopback HTTP, default port 64342) |
| `mcp-litellm` | MCP | replace | Add a LiteLLM proxy's MCP gateway as a remote MCP server (prompts for gateway URL and LiteLLM key; auth via `x-litellm-api-key`, no login flow) |
| `mcp-litellm-passthrough` | MCP | replace | Add one `x-mcp-<alias>-<header>` passthrough header to the `mcp.litellm` server so an upstream MCP server authenticates as you (run once per header; install `mcp-litellm` first) |
| `mcp-playwright` | MCP | replace | Add the Playwright MCP server (local stdio via npx; pins `@playwright/mcp` 0.0.79) |
| `mcp-vscode` | MCP | replace | Add the VS Code MCP server via the `JuehangQin.vscode-mcp-server` extension (loopback HTTP, default port 3000) |
| `plugin-litellm-pricing` | Plugin | append | Add `opencode-plugin-litellm-pricing` — discovers a LiteLLM proxy's models at runtime and adds them to the picker with real per-model pricing from a LiteLLM-format price table instead of `$0`. The table URL has no default, so install `provider-litellm` too — without it the models are still discovered, just unpriced (pins `opencode-plugin-litellm-pricing` 0.6.0) |
| `provider-litellm` | Provider | replace | Point the `litellm` provider at your proxy URL for `plugin-litellm-pricing`, and name the price table it bills against — the plugin has none of its own (prompts for base URL, API key and price-table URL, the last defaulting to LiteLLM's published `model_prices_and_context_window.json`; no models list) |
| `plugin-superpowers` | Plugin | append | Add the Superpowers OpenCode plugin from `obra/superpowers` (brainstorming, plans, TDD, review workflows; pins tag `v6.3.0`) |
| `plugin-dcg` | Plugin | append | Add `opencode-plugin-dcg` — runs every bash command past the external `dcg` binary and blocks the destructive ones. Install the binary yourself first: `brew install dicklesworthstone/tap/dcg`, or `curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/main/install.sh" \| bash -s -- --no-configure`. Without it the plugin warns once and commands run unchecked (pins `opencode-plugin-dcg` 0.1.0) |
| `agent-runaway-guard` | Agent | merge | Adds step limits to built-in agents to prevent runaway tool loops |
| `default-agent-plan` | Agent | replace | Sets the default agent to "plan" so opencode always starts in plan mode instead of build mode |
| `tui-disable-mouse` | TUI | replace | Disables TUI mouse capture so native terminal selection and scrolling keep working |

### Bundles

A preset whose header is `@include` lines is a **bundle**: a list of other
presets, with no rules of its own. `permissions-recommended` is the only one
shipped, and this is all of it:

```
permissions-recommended
  permissions-shell-safe           22 keys   ls, cat, grep, rg, jq, ps        allow
  permissions-git-safe             40 keys   status, diff, log, blame, fetch  allow
  permissions-toolchain-info       60 keys   node -v, python -V, mvn -v       allow
  permissions-container-info       52 keys   docker/podman ps, logs, inspect  allow
  permissions-deny-destructive     34 keys   sudo, dd, mkfs, rm -rf /, -f     deny
  permissions-deny-cluster-write   64 keys   oc/kubectl/helm delete, exec     deny
```

The order is part of the definition: opencode is last-match-wins and `merge`
appends new keys at the end, so the denies have to land after every allow.

```sh
opencode-presets install permissions-recommended
opencode-presets install permissions-recommended permissions-build-tools
```

**Reset first?** Only if you already have hand-written `permission.bash` rules.
`merge` never overwrites, so any rule of yours with the same pattern string as a
preset's keeps that rule out — and when the casualty is a deny, a guardrail you
think you installed is absent. Wiping the path first guarantees every rule lands:

```sh
jq '.permission.bash, .agent' ~/.config/opencode/opencode.json   # see what you'd lose
opencode-presets install --reset permission.bash permissions-recommended
```

That deletes every hand-written rule at `permission.bash` — a backup is written
first, and nothing else in the config is touched. On a config with no bash rules
of your own it changes nothing, so skip it. Either way the installer names any
deny that was kept out, so you can start with a plain install and only reset if
it complains.

`remove` expands a bundle the same way. There is no per-preset ownership
tracking, so removing it also clears keys an earlier standalone install of a
member wrote — the confirmation lists every preset first.

Not in the bundle, on purpose:

- `permissions-build-tools` — runs project-defined code, and `python -c "…"` /
  `node -e "…"` execute commands opencode never sees as shell commands, so no
  deny rule can match them.
- `permissions-cluster-info` — read access to whichever cluster you are logged
  into, production included. Worth an explicit decision.
- `permissions-webfetch-ask` — *adds* friction; wrong for a defaults bundle.

### About the `deny` presets

A denied command is rejected outright — no prompt, and `--auto` only
auto-approves what is *not* explicitly denied. That is the one tier a habit of
clicking "allow" cannot defeat. Compound commands are split before matching, so
`cd /x && oc delete pod y` is caught too.

It is a guardrail, not a security boundary: env-prefixed
(`KUBECONFIG=x oc delete …`), `sh -c "…"`-wrapped and aliased invocations slip
through.

Every shipped deny pattern is disjoint from every shipped allow pattern
(enforced by a test), so install order does not matter among these presets. A
broad hand-written rule of your own, like `"oc *": "allow"`, still wins if it
was written after the deny — install the deny presets last.

When one of your rules keeps a deny out, the installer says so instead of
letting the guardrail go missing quietly:

```
• permissions-deny-destructive — added 27, preserved 3
  ⚠ "sudo *" is already "ask" in your config — the deny was NOT applied
  ⚠ "rm -rf /" is already "allow" in your config — the deny was NOT applied

To apply those denies, pick one:
  1. delete the listed keys from permission.bash in ~/.config/opencode/opencode.json,
     then re-run: opencode-presets install permissions-deny-destructive
  2. wipe the whole path and reinstall from scratch:
     opencode-presets install --reset permission.bash permissions-deny-destructive
     this also deletes any other hand-written rules at that path
  3. keep your rule deliberately — nothing to do, but the guardrail is off
```

It also warns *before* you confirm if any agent sets its own permission rules:
`agent.<name>.permission` is evaluated after the global rules and wins, so global
denies do nothing for that agent.

Upgrading `permissions-container-info` to 0.2.0 **does not revoke `oc` access an
earlier install already granted** — `merge` never removes keys, and 0.2.0 no
longer lists the `oc` rules. Clear them with
`opencode-presets remove permissions-cluster-info`.

Install multiple at once:

```sh
opencode-presets install jdtls-lombok jdtls-clean-workspace
```

Presets whose path uses a prompt (like `mcp-http`) can't be
removed with `remove` — use `reset` instead:

```sh
opencode-presets reset mcp.openrag-tom
```

### Pricing a LiteLLM proxy

`plugin-litellm-pricing` 0.6.0 dropped the built-in price-table URL: the plugin
now fetches the table you name in `options.pricingURL` and nothing else. Name
none and the models are still discovered and injected — they just carry no cost,
and the startup log says so, naming the provider:

```
[litellm-pricing] provider "litellm" has no options.pricingURL — set it to a
  price table in LiteLLM `model_prices_and_context_window.json` format;
  every model will be injected without pricing.
```

`provider-litellm` writes that URL, defaulting to LiteLLM's published file. If
your gateway serves an enriched copy — upstream's entries plus your own model
names, with their real context and pricing — point the prompt at that instead
and those models price by exact name rather than by substring against the
public line.

**If you set this up before `provider-litellm` 0.4.0**, your config has no
`pricingURL` at all — that release added the prompt. Until now it did not
matter: plugin 0.4.1 priced from models.dev, and 0.5.0 fell back to LiteLLM's
published file when the option was unset. 0.6.0 has neither. Nothing warns you
at install time either, because `plugin-litellm-pricing` and `provider-litellm`
are separate presets and bumping the first does not touch the second. Re-run it:

```sh
opencode-presets install provider-litellm
```

It is a `replace` preset, so it rewrites the whole `provider.litellm` block and
re-prompts for the base URL and key as well — have the key to hand.

### Checking commands with `dcg`

`plugin-dcg` is a second tier, not an alternative one: the deny rules
glob-match the command line,
[dcg](https://github.com/Dicklesworthstone/destructive_command_guard) parses it.
That catches shapes a whole-line pattern cannot — it splits compound commands,
and it extracts and re-checks inline scripts and heredoc bodies, so a
`bash -c "git reset --hard"` or a `python -c "shutil.rmtree(…)"` is judged on
what it would run. It is still a guardrail, not a boundary: env-var prefixes,
shell aliases and anything dcg cannot statically reconstruct can slip past it
too.

**Run it alongside `permissions-recommended`, not instead of it.** opencode
fires plugin hooks before the tool executes and asks for permission inside it,
so the order is: dcg decides first, then your permission rules apply to whatever
it let through. Two consequences worth knowing before you install both:

- An `allow` rule does **not** buy a command past dcg. The allowlists still do
  their job — no prompts for `ls`, `git status` and friends — but dcg has
  already seen every one of them.
- The overlap is only with the deny half, on the classic footguns (`rm -rf /`,
  `dd`, `mkfs`). Redundant, and deliberately so: dcg fails **open** when its
  binary is missing or times out, and only inspects the tools in
  `DCG_PLUGIN_TOOLS` — the deny presets are what remains when it does. Keep
  them.

The two announce themselves differently, which is the point: a dcg block quotes
its rule id and a suggestion, an opencode deny names the pattern it matched.

The binary is a separate project and the preset does not install it. Homebrew
covers macOS and Linux; the install script is upstream's own recommendation, and
[dcg's docs](https://github.com/Dicklesworthstone/destructive_command_guard#installation)
list the rest (cargo, prebuilt release binaries, manual build):

```sh
brew install dicklesworthstone/tap/dcg
# or — binary only, no agent hooks wired up
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/main/install.sh?$(date +%s)" | bash -s -- --no-configure

dcg --version
dcg --robot test "rm -rf /"   # prints JSON with a deny decision
```

`--no-configure` is the flag that matters here. Left off, the installer wires
dcg into the hooks of every coding agent it detects — Claude Code, Codex CLI,
Cursor and friends — which `plugin-dcg` neither needs nor uses: it calls the
binary itself, and all it needs is `dcg` on `PATH`. Drop the flag (or run dcg's
own `dcg install` later) if you do want dcg guarding those other agents too.

The binary lands in `~/.local/bin`. If that is not already on your `PATH`, add
`--easy-mode`, which appends it to your shell rc files. And keep the URL quoted:
the `?` cache-buster is a glob in zsh.

Without the binary the plugin warns once per session and lets commands through
unchecked. Everything else is tuned by environment variable, not by the config
file the preset writes: `DCG_PLUGIN_FAIL_MODE=closed` blocks instead when dcg is
unavailable, `DCG_PLUGIN_ENABLED=false` turns it off, and `DCG_PLUGIN_TOOLS`,
`DCG_PLUGIN_TIMEOUT_MS` and `DCG_PLUGIN_BINARY` cover the rest. Which commands
count as destructive is dcg's own policy, in `~/.config/dcg/config.toml` or a
project `.dcg.toml`.

## Use

```sh
opencode-presets list                              # what's available
opencode-presets install jdtls-lombok             # apply one preset by name
opencode-presets install jdtls-lombok permissions-git-safe
opencode-presets remove jdtls-lombok              # undo a preset
opencode-presets install --reset permission ./presets/foo.conf  # wipe then install
opencode-presets reset permission                 # wipe a section outright
opencode-presets validate                         # check opencode.json and tui.json
```

Bare names are resolved through the preset search path (see "Where
presets are found" below). You can always pass an explicit path
instead, e.g. `install ./presets/jdtls-lombok.conf`.

Every change shows a diff and asks before touching anything. A
backup is written to `~/.cache/opencode-presets/backups/` before
each write — no auto-pruning, so they pile up.

`validate` checks the configured `opencode.json` and `tui.json`
against OpenCode's current schemas. Use `validate config`,
`validate tui`, or `validate all` to choose targets. Missing files
are skipped in `all` mode; invalid files print labeled `where`,
`what`, and `detail` lines and exit nonzero.

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

## Pointing at different config files

```sh
OPENCODE_CONFIG=/path/to/other-opencode.json opencode-presets install ...
OPENCODE_PRESETS_CACHE=/some/cache opencode-presets install ...
```

TUI presets target `~/.config/opencode/tui.json` by default. Override
that path with `OPENCODE_TUI_CONFIG`:

```sh
OPENCODE_TUI_CONFIG=/path/to/tui.json opencode-presets install tui-disable-mouse
```

## Writing your own preset

Plain JSONC with a header. Drop into one of the dirs above, or pass
an absolute path.

```jsonc
// @name: my-preset
// @description: one or two sentences on what this fixes / sets up.
// @author: you <you@example.com>
// @version: 1.0.0
// @target: config
// @path: some.dotted.path
// @mode: merge
{ "key": "value" }
```

`@target` is optional and defaults to `config`, which writes
`opencode.json`. Use `@target: tui` for TUI presets that write
`tui.json`. A single install or remove operation cannot mix `config`
and `tui` presets; run separate commands for those.

`@fetch: <url> -> <dest> [sha256=hex]` downloads to the cache.
`@prompt: name | text|secret | help` collects input at install time.
Both repeatable. Reference fetched files as `{{cache}}/<name>` and
prompt values as `{{prompt:<name>}}` in the body or `@path`.

`@pins: <name> <version>` records a third-party artifact the preset
installs at an exact version — the npm package behind an `mcp` command,
a plugin spec, a `@fetch`ed jar. Optional and repeatable. It's shown on
the install confirmation and in `list -l`, so you can see what a preset
drags in before saying yes:

```jsonc
// @pins: @playwright/mcp 0.0.79
```

The version string must also appear in the body or `@fetch` line it
describes; a test enforces that, so a bump can't land on one side only.

See the existing `presets/*.conf` for working examples.
