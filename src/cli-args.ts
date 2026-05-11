// CLI argument parsing for `install`. Pure functions; tested in
// test/cli-args.test.ts. Errors are thrown so callers can decide how
// to surface them (the bin entry prints + exits).
import process from 'node:process';

export interface SetValue {
  scope?: string;     // optional <preset-name>. prefix from --set foo.name=...
  name: string;
  value: string;
}

export interface InstallArgs {
  resets: string[];
  confPaths: string[];
  setValues: SetValue[];
}

// Prompt names mirror parse-conf's @prompt validation (letter or underscore start).
const PROMPT_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
// Preset scope and env-var names: alphanumeric, underscore, hyphen; must not start with `-`.
const SCOPE_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const ENV_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class CliArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgsError';
  }
}

// args is everything after `install` (so --reset, --set, --set-env, and conf paths).
// Forms accepted:
//   --reset <path>            --reset=<path>
//   --set <name>=<value>      --set=<name>=<value>
//   --set <preset>.<name>=<value>
//   --set-env <name>=<ENV>    --set-env=<name>=<ENV>
// Anything else is treated as a conf path/name.
export function parseInstallArgs(args: string[]): InstallArgs {
  const resets: string[] = [];
  const confPaths: string[] = [];
  const setValues: SetValue[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === '--reset') {
      const next = args[++i];
      if (next === undefined) throw new CliArgsError('--reset requires a path argument');
      resets.push(next);
      continue;
    }
    if (a.startsWith('--reset=')) {
      resets.push(a.slice('--reset='.length));
      continue;
    }

    if (a === '--set' || a === '--set-env') {
      const next = args[++i];
      if (next === undefined) throw new CliArgsError(`${a} requires a NAME=VALUE argument`);
      setValues.push(parseSetSpec(next, a === '--set-env'));
      continue;
    }
    if (a.startsWith('--set=')) {
      setValues.push(parseSetSpec(a.slice('--set='.length), false));
      continue;
    }
    if (a.startsWith('--set-env=')) {
      setValues.push(parseSetSpec(a.slice('--set-env='.length), true));
      continue;
    }

    confPaths.push(a);
  }

  return { resets, confPaths, setValues };
}

function parseSetSpec(spec: string, fromEnv: boolean): SetValue {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    throw new CliArgsError(
      `${fromEnv ? '--set-env' : '--set'} expects NAME=${fromEnv ? 'ENV_VAR' : 'VALUE'}, got "${spec}"`
    );
  }
  const lhs = spec.slice(0, eq);
  const rhs = spec.slice(eq + 1);

  let scope: string | undefined;
  let name = lhs;
  const dot = lhs.indexOf('.');
  if (dot >= 0) {
    scope = lhs.slice(0, dot);
    name = lhs.slice(dot + 1);
    if (!SCOPE_RE.test(scope)) throw new CliArgsError(`invalid preset scope "${scope}"`);
  }
  if (!PROMPT_NAME_RE.test(name)) throw new CliArgsError(`invalid prompt name "${name}"`);

  if (fromEnv) {
    if (!ENV_NAME_RE.test(rhs)) {
      throw new CliArgsError(`--set-env value must be an env var name, got "${rhs}"`);
    }
    const resolved = process.env[rhs];
    if (resolved === undefined) {
      throw new CliArgsError(`--set-env: environment variable "${rhs}" is not set`);
    }
    if (resolved === '') {
      throw new CliArgsError(`--set-env: environment variable "${rhs}" is empty`);
    }
    return { scope, name, value: resolved };
  }
  return { scope, name, value: rhs };
}
