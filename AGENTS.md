# Agent guidance for opencode-presets

## Testing — never touch the real config

Point the CLI at a temp target/cache. Never install/remove/reset against the
user's real `~/.config/opencode/{opencode,tui}.json`.

```sh
rm -rf /tmp/oc-test && mkdir -p /tmp/oc-test/cache /tmp/oc-test/cfg
export OPENCODE_CONFIG=/tmp/oc-test/cfg/opencode.json
export OPENCODE_TUI_CONFIG=/tmp/oc-test/cfg/tui.json
export OPENCODE_PRESETS_CACHE=/tmp/oc-test/cache
npm run build && node dist/bin/opencode-presets.js install ./presets/<name>.conf
```

Non-interactive → `--set NAME=VALUE`, `--set-env NAME=ENV_VAR` for secrets.
Not piped `printf`/`yes` (works, but fragile).

## Conf format — headers

Order irrelevant.

- `@name`, `@description`, `@author`, `@version`, `@path` — required.
- `@description` — 1–2 sentences: what it does, what it touches. No rationale,
  history, troubleshooting. Cap 450 chars (tested).
- `@target` — `config` (default, `opencode.json`) | `tui` (`tui.json`).
- `@mode` — `replace` (default) | `merge` | `merge-overwrite` | `append`.
- `@fetch: URL -> dest [sha256=hex]` — repeatable.
- `@pins: name version` — repeatable, one per pinned third-party artifact.
  Version must also appear in body or `@fetch` (tested).
- `@prompt: name | type | help | default` — repeatable; type `text`/`secret`.
  Help/default optional. Default forbidden for `secret`. Empty input → default.
- `@include: <name|path>` — repeatable. Makes the module a **bundle**.

## Bundles (`@include`)

- Bundle = pure list. No `@path`, no body — parser rejects both. That's what
  stops one reaching an applier: empty `@path` → `applyAtPath` treats the whole
  config as the leaf and replaces it.
- `expandIncludes` (`src/expand-includes.ts`) flattens to leaves only, keeps
  declaration order, dedupes a leaf to its first position, throws on cycles.
- Order is load-bearing for permissions — list deny modules last.
- Never `@include` a module that runs project code (`permissions-build-tools`)
  in a defaults bundle: `python -c` routes around every deny rule.
- `remove <bundle>` strips all members. No ownership tracking — say so.
- A bundle's `@description` is printed before the confirm (the bundle itself
  never reaches the summary). Use it to say what the bundle is *not*.
- Say "preset" in anything a user reads. "Module" is the internal word for the
  parsed struct; it must not appear in output, errors or descriptions.

## Warn, don't silently no-op

`merge` preserving an existing key is normal. Preserving one whose incoming
value is `deny` means a guardrail did not install — name the key and say how to
fix it (`findShadowedDenies` in `src/batch.ts`). Same for
`agent.<name>.permission`: it beats global rules, so warn before the confirm
(`agentOverrideWarnings`). Every such warning states the concrete command or
key to change — never just that something happened.

Body is JSONC, must parse to JSON matching the `@path` leaf: any shape for
`replace`, object for `merge`/`merge-overwrite`, array for `append`.
Substitutions in body and `@path`: `{{cache}}`, `{{prompt:<name>}}`.

## Merge stays additive

`merge` MUST NOT overwrite existing keys — existing values win, only missing
keys added. Users rely on this to keep hand-edits and other modules' rules.
Need overwrite → `merge-overwrite`, called out in `@description`. Never turn
`merge` into deep-merge-overwrite.

## Backups

One before every real write; skipped on byte-equal no-op. None for `--help`,
`list`, declined prompts. Path `<cache>/backups/`, ms-precision UTC. No
auto-pruning.

## Dynamic-path removal

`@path` with `{{prompt:…}}` → `remove` can't resolve it (prompts not
re-collected). Reject, point at `opencode-presets reset <resolved-path>`.
Never re-prompt — secrets must not be asked twice.

## Permission rule curation

Matcher is whole-line glob; `*` matches any chars.

- No wildcard admitting a destructive subcommand/flag. `git branch *` exposes
  `-D` → use `git branch --list *`. `find *` exposes `-delete`/`-exec` → skip.
- No in-place mutation flags (`sed -i`, `gawk -i inplace`, Mike Farah's
  `yq -i`) unless the description accepts the trade-off.
- No interactive viewers (`less`, `more`, `vim`, `man`, `tldr`) or unbounded
  streamers (`docker stats` without `--no-stream`) — they hang the agent.
- Harmless isn't enough; the agent must *also* invoke it often. No `whoami`,
  `uptime`, `hostname`, `uname` filler.

### Deny rules

- Hard block. No prompt, survives `--auto`. User can't approve past it →
  over-matching is unfixable by them. Precise patterns only, never leading `*`.
- `*` spans `/`. `rm -rf /*` also matches `rm -rf /tmp/x` → anchor exactly.
- Disjoint from every shipped allow pattern (tested in
  `test/builtin-presets.test.ts`). Last-match-wins + `merge` appends → otherwise
  install order silently decides.
- Broad hand-written allows → tell the user to install the deny preset last.
- No `|` in a pattern. opencode tree-sitter-splits `&&`/`|`/`;` before matching,
  so `curl * | sh` can never match.
- Not compound-proof: env-var prefixes, `sh -c`, aliases slip through. Never call
  a deny preset a security boundary — guardrail only.

## Naming and placement

- `presets/<category>-*.conf`: `permissions-`, `privacy-`, `mcp-`, `lsp-`, `tui-`.
- One concern per module; two unrelated paths → split.
- `@path` deep enough that modules don't overlap — same path in `replace`
  collides.

## Code conventions

- TypeScript `strict: true`, `tsc` → `dist/`. Source in `bin/`, `src/`.
- Internal imports use `.js` extensions though source is `.ts` (NodeNext).
- Edit → `npm run build` → `node dist/bin/...`.
- Runtime deps are `chalk` + `ajv`. No more without justification.
- Atomic writes: `writeFile(tmp); rename(tmp, final)`. Never write in place.
- Paths via `node:path` `resolve`/`join`; never string-concat `/`.
- User-facing errors prefixed `c.err('error: ')`. Exit 1 user error,
  2 parse/internal.

## Don't add

- `find`, `xargs`, `bash`, `sh`, `./<anything>` to permission allowlists.
- Auto-update / auto-fetch for modules. User opts in.
- Telemetry, or network calls beyond declared `@fetch` URLs.
- A second prompt UI library — `src/ui.ts` handles it.
- Backups under `~/.config/opencode/`; they belong in the cache dir.

## package.json — supply chain

No explicit human review → don't add:

- `optionalDependencies`, or a `dependencies` entry with a `git+`, `http(s):`,
  `file:`, or tarball specifier. The May 2026 TanStack worm shipped its
  payload via exactly this shape.
- `prepare`, `preinstall`, `postinstall`, or other install-time lifecycle
  scripts. Only `prepare`/`prepublishOnly` running `tsc` exist; don't broaden.
- Floating ranges (`^`, `~`, `*`, `latest`) in deps. Pin exact so
  `package-lock.json` is the only source of truth.
- New runtime dependencies at all — see Code conventions.

Third-party code in a preset (`plugin`, `mcp` command, `@fetch`) → pin exact
version, git tag, or SHA, recorded in `@pins`. Unpinned or `@latest` → justify
in `@description`. opencode caches by full spec string and never re-checks, so
an unpinned ref freezes at first resolve; changing the string triggers the
re-fetch.

New `@pins` → also add a lookup to `PIN_SOURCES` (`src/pin-sources.ts`). A test
fails without one, because Dependabot cannot see preset headers and
`.github/workflows/pins.yaml` is the only thing that would catch drift.
`npm run check-pins` runs it locally. Pin *ahead* of upstream = that source is
wrong, not good news — lombok is on git tags because Maven Central's index and
projectlombok.org's download page each reported a stale "latest".

`@fetch` → always `sha256=`, and version the dest filename; `fetchAsset` skips
an existing dest, so reusing the filename makes a bump a no-op. Verify the hash
against a second source before committing.

`npm publish` must pass `--provenance` — SLSA attestation, verifiable via
`npm audit signatures`.
