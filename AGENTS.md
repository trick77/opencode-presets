# Agent guidance for opencode-presets

## Testing — never touch the real config

Always point the CLI at a temp target/cache. Never run install/remove/reset
against the user's actual `~/.config/opencode/opencode.json` or
`~/.config/opencode/tui.json`.

```sh
rm -rf /tmp/oc-test && mkdir -p /tmp/oc-test/cache /tmp/oc-test/cfg
export OPENCODE_CONFIG=/tmp/oc-test/cfg/opencode.json
export OPENCODE_TUI_CONFIG=/tmp/oc-test/cfg/tui.json
export OPENCODE_PRESETS_CACHE=/tmp/oc-test/cache
npm run build && node dist/bin/opencode-presets.js install ./presets/<name>.conf
```

For non-interactive runs prefer `--set NAME=VALUE` (or `--set-env
NAME=ENV_VAR` for secrets) over piping answers via `printf`/`yes`.
The interactive readline path still works — the CLI uses one shared
session with a buffered queue — but `--set` is sturdier in scripts.

## Conf module format — required headers

Every `presets/*.conf` must start with these directives (order doesn't
matter):

- `@name`, `@description`, `@author`, `@version`, `@path` — required.
- `@target` — `config` (default, writes `opencode.json`) | `tui` (writes `tui.json`).
- `@mode` — `replace` (default) | `merge` | `merge-overwrite` | `append`.
- `@fetch: URL -> dest [sha256=hex]` — repeatable.
- `@prompt: name | type | help | default` — repeatable; type ∈
  `text`/`secret`. Help and default are optional. Default is
  forbidden when type is `secret`. When the user enters an empty
  line, the default is used.

Body is JSONC. After parsing it must be valid JSON of the shape the
leaf at `@path` expects (object/array/scalar all allowed for `replace`;
must be an object for `merge`/`merge-overwrite`; must be an array for
`append`).

Substitutions inside body and inside `@path`: `{{cache}}`,
`{{prompt:<name>}}`.

## Merge semantics — preserve `merge` as additive

`merge` mode MUST NOT overwrite existing keys. Existing values always
win; only missing keys are added. This is the contract users rely on
to keep their hand-edits and other modules' rules intact.

If you need overwrite semantics for something, use `merge-overwrite`
explicitly and call it out in the module's `@description`. Do not
"helpfully" change `merge` to deep-merge-overwrite.

## Backups — skip on no-op

A backup must be written before every actual write to a target config file,
and skipped when the apply is a byte-equal no-op. Don't introduce
backups for `--help`, `list`, or declined prompts.

Backup path format is millisecond-precision UTC and lives under
`<cache>/backups/`. Don't add auto-pruning.

## Removal of dynamic-path modules

If a module's `@path` contains `{{prompt:…}}`, the `remove` flow
cannot resolve it (we don't re-collect prompts at remove time).
Reject it with a message pointing the user at
`opencode-presets reset <resolved-path>`. Don't try to be clever and
re-prompt — secrets in particular must never be asked again.

## Permission rule curation

opencode's pattern matcher is whole-line glob with `*` matching any
chars. When adding entries to `permission.bash`:

- Wildcards must not let a destructive subcommand or flag through.
  `git branch *` would expose `git branch -D`; use `git branch --list *`
  instead. `find *` exposes `-delete`/`-exec`; skip blanket.
- Avoid commands prone to in-place file mutation via flags
  (`sed -i`, `gawk -i inplace`, Mike Farah's `yq -i`) unless the
  module's description explicitly accepts the trade-off.
- Avoid interactive viewers (`less`, `more`, `vim`, `man`, `tldr`)
  and unbounded streamers (`docker stats` without `--no-stream`) —
  they hang the agent.
- "Harmless" requires *also* "agent actually invokes this often".
  No `whoami`, `uptime`, `hostname`, `uname` filler.

## File naming and placement

- New modules go in `presets/` with a category prefix:
  `permissions-*`, `mcp-*`, `lsp-*`, `tui-*`, etc.
- One concern per module. If a module would touch two unrelated
  paths, split it.
- Choose `@path` deep enough that two unrelated modules don't overlap.
  Two modules writing to the same path in `replace` mode collide.

## Code conventions

- TypeScript with `strict: true`, compiled by `tsc` to `dist/`. Source in `bin/` and `src/`.
- Internal imports use `.js` extensions even though source is `.ts` (NodeNext convention; tsc emits the `.js` files at the matching paths).
- Edits → `npm run build` → `node dist/bin/...` (or `npm link` once for global use).
- One runtime dep: `chalk`. Don't add more without justification.
- Atomic writes: `writeFile(tmp); rename(tmp, final)`. Never write the
  target in place.
- All paths use `node:path`'s `resolve`/`join`; never string-concat
  with `/`.
- Errors that reach the user: prefix with `c.err('error: ')`. Use
  exit codes 1 (user error) / 2 (parse/internal).

## What not to add

- `find`, `xargs`, `bash`, `sh`, `./<anything>` to permission allowlists.
- Auto-update / auto-fetch behaviour for modules. The user opts in.
- Telemetry, network calls beyond declared `@fetch` URLs.
- A second prompt UI library. The current `src/ui.ts` handles it.
- Backups under `~/.config/opencode/`; they belong in the cache dir.

## package.json — supply-chain hygiene

Do NOT add any of the following without an explicit human review:

- An `optionalDependencies` block, or a `dependencies` entry using a
  `git+`, `http(s):`, `file:`, or tarball specifier. The May 2026
  TanStack worm shipped its payload via exactly this shape.
- A `prepare`, `preinstall`, `postinstall`, or other install-time
  lifecycle script. This package's only lifecycle scripts are
  `prepare`/`prepublishOnly` running `tsc`; don't broaden them.
- Floating version ranges (`^`, `~`, `*`, `latest`) in `dependencies`
  or `devDependencies`. Pin exact versions so `package-lock.json` is
  the only source of truth.
- New runtime dependencies in general — see "Code conventions" above.

The `npm publish` step must pass `--provenance` so the published
tarball carries SLSA build attestation verifiable via
`npm audit signatures`.
