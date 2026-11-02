# Agent guidance for opencode-presets

## Testing — never touch the real config

`OPENCODE_CONFIG` + `OPENCODE_PRESETS_CACHE` → temp dir. Never
install/remove/reset against `~/.config/opencode/opencode.json`.

Non-interactive → `--set`/`--set-env`, not piped `printf`/`yes` (fragile).

What opencode 2 makes of it: `opencode debug config` asks the shared
background service, which reads `OPENCODE_CONFIG` from *its* env and owns port
49374 → isolate with a temp `HOME`, `opencode service set port <other>`,
`OPENCODE_CONFIG=… opencode service restart`, `opencode debug config`,
`opencode service stop`.

## opencode 2

- Bodies keep 1.x key shapes (`permission`, `agent`, `mcp.<name>`, `plugin`,
  `provider`); V2 normalizes in memory. Mixing V2 top-level keys into a
  1.x-shaped user config is what the migration guide warns against.
- `plugin` entries must be V2 plugins (`Plugin.define` default export); a 1.x
  plugin fails to load with a warning only in the log.
- MCP entry without `type` is dropped → a partial `mcp.<name>` preset
  (`mcp-litellm-passthrough`) needs its base preset first.

## Writing presets

- `@description` — 1–2 sentences: what it does, what it touches. No rationale,
  history, troubleshooting. Bundle's (shown before confirm) → what it is *not*.
- `@archive` hashes the gunzipped tar: GitHub changed only gzip so far (Jan
  2023); `git archive` from any clone is the second source.
- `@requires-bin` only when the preset is inert without it. `@part-of` not for
  members useful alone (`permissions-*`).
- One concern per preset; two unrelated paths → split. Same `@path` in
  `replace` collides → go deep enough.
- Never `@include` a preset that runs project code (`permissions-build-tools`)
  in a defaults bundle: `python -c` routes around every deny rule.
- Say "preset" in anything a user reads; "module" is internal only.

## Behaviour that must not drift

- Warn, don't silently no-op: a `deny` that `merge` kept out = guardrail
  missing. Every warning names the concrete command or key to change.
- `merge` never overwrites: users rely on it to keep hand-edits and other
  presets' rules. Need overwrite → `merge-overwrite`, said in `@description`.
- Renaming a versioned `{{cache}}` dest family (`planify-*` →
  `opencode-planify-german-*`) still stacks once in `append`.
- Dynamic `@path` → `remove` points at `reset`, never re-prompts: secrets must
  not be asked twice.
- Backups: no auto-pruning, never under `~/.config/opencode/`.

## Permission rule curation

Matcher is whole-line glob; `*` matches any chars.

- No wildcard admitting a destructive subcommand/flag. `git branch *` exposes
  `-D` → `git branch --list *`. `find *` exposes `-delete`/`-exec` → skip.
- No in-place mutation flags (`sed -i`, `gawk -i inplace`, Mike Farah's
  `yq -i`) unless the description accepts the trade-off.
- No interactive viewers (`less`, `more`, `vim`, `man`, `tldr`) or unbounded
  streamers (`docker stats` without `--no-stream`) — they hang the agent.
- Harmless isn't enough; agents must *also* call it often. No `whoami`,
  `uptime`, `hostname`, `uname` filler.
- Never `find`, `xargs`, `bash`, `sh`, `./<anything>` in allowlists.
- Deny: user can't approve past it → over-matching is unfixable by them.
  Never leading `*`; `rm -rf /*` also matches `rm -rf /tmp/x` → anchor exactly.
- No `|` in a deny: opencode tree-sitter-splits `&&`/`|`/`;` before matching,
  so `curl * | sh` can never match.

## Don't add

- Runtime deps beyond `chalk` + `ajv`, unjustified.
- Auto-update / auto-fetch for presets. User opts in.
- Telemetry, network calls beyond declared `@fetch`/`@archive` URLs.
- A second prompt UI library (`src/ui.ts` has one).

## Supply chain

No explicit human review → not in package.json:

- `optionalDependencies`, or a `git+`/`http(s):`/`file:`/tarball dep. The May
  2026 TanStack worm shipped its payload via exactly this shape.
- Install-time lifecycle scripts beyond `prepare`/`prepublishOnly` → `tsc`.
- Floating ranges (`^`, `~`, `*`, `latest`). Pin exact; lockfile is the truth.

Third-party code in a preset → exact version, tag or SHA in `@pins`. Unpinned
→ justify in `@description`. opencode caches by full spec string and never
re-checks: an unpinned ref freezes at first resolve.

Pin *ahead* of upstream in `check-pins` = that `PIN_SOURCES` lookup is wrong,
not good news — lombok (since dropped) needed git tags because Maven Central
and projectlombok.org each reported a stale "latest".

`@fetch` → always `sha256=` and a versioned dest filename: `fetchAsset` skips
an existing dest, so a reused filename makes a bump a no-op. Verify the hash
against a second source.

`@fetch` of a file in this repo (`rules/*`) → two PRs: content first (its
commit SHA must exist to pin), then `@version`, dest filename, URL commit and
`sha256` together. Editing the file alone serves old bytes with `npm test`
green — only `check-fetch-hashes` (weekly in `pins.yaml`) catches it.
