// Preconditions a preset depends on outside the config file itself: a
// directory a prompt points at, an executable a preset drives.
//
// Both are checked before anything is written, and a failure refuses the
// install. The alternative — writing the entry anyway — is worse than not
// installing: opencode ignores a skills path that does not exist without a
// word, and a command guard whose binary is missing sits in the config looking
// like protection it is not providing.

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface DirCheck {
  ok: boolean;
  /** The absolute, ~-expanded path — what should be written to the config. */
  path: string;
  /** Populated only when ok is false. */
  reason?: string;
}

// Resolve and validate a `@prompt ... | dir` answer.
//
// A leading `~/` is expanded here because prompt answers do not pass through a
// shell: typed at the prompt, or handed over as `--set p=~/x`, the tilde
// arrives literally and would otherwise fail every time.
export async function checkDir(value: string): Promise<DirCheck> {
  let path = value.trim();
  if (path === '~' || path.startsWith('~/')) {
    path = join(homedir(), path.slice(1));
  }
  if (!isAbsolute(path)) {
    return { ok: false, path, reason: `must be an absolute path, got "${value}"` };
  }
  path = resolve(path);

  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, path, reason: `${path} does not exist` };
  }
  if (!info.isDirectory()) {
    return { ok: false, path, reason: `${path} is not a directory` };
  }
  return { ok: true, path };
}

// Resolve an executable name against PATH.
//
// Done by hand rather than by shelling out to `which`: this CLI spawns no
// processes anywhere, and a precondition check is the last place to start —
// it runs against a name that came out of a preset file.
export async function findOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const dirs = (env.PATH ?? '').split(delimiter).filter(d => d.length > 0);
  // Windows marks executability by extension, not by a mode bit.
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(e => e.length > 0)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable — keep looking.
      }
    }
  }
  return null;
}
