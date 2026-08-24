import { readFile } from 'node:fs/promises';
import type { MergeMode } from './merge.js';

export interface FetchDirective {
  url: string;
  dest: string;
  sha256: string | null;
}

export type PromptType = 'text' | 'secret' | 'dir';
export type ConfTarget = 'config' | 'tui';

export interface PromptDirective {
  name: string;
  type: PromptType;
  help: string;
  default?: string;
  // What to do when the answer fails its check — the literal command that makes
  // it pass, e.g. the git clone that creates the directory being asked for.
  // Only a `dir` prompt can fail a check, so only there does this earn its keep.
  setup?: string;
}

// An executable this preset needs on PATH, plus how to get it.
export interface RequiresBinDirective {
  bin: string;
  // The command that installs it. Printed verbatim when the check fails —
  // "install it first" without the command sends the user hunting for a
  // description that this error already replaced on screen.
  setup?: string;
}

// A third-party artifact this preset installs at an exact version.
export interface PinDirective {
  name: string;
  version: string;
}

export interface ConfMeta {
  name: string;
  description: string;
  author: string;
  version: string;
  target: ConfTarget;
  path: string;
  mode: MergeMode;
  fetch: FetchDirective[];
  prompts: PromptDirective[];
  pins: PinDirective[];
  // Executables this preset needs on PATH to be worth installing. Checked at
  // install time and refused when missing: a preset whose binary is absent
  // installs cleanly and then does nothing, which reads as protection you do
  // not have. Names only, never paths.
  requiresBin: RequiresBinDirective[];
  // Names or paths of other presets this one pulls in. A preset with any
  // @include is a bundle: a pure list, with no @path and no body of its own,
  // so it can never apply anything itself. See expand-includes.ts.
  includes: string[];
}

export interface ParsedConf {
  meta: ConfMeta;
  body: unknown;
}

const REQUIRED: (keyof ConfMeta)[] = ['name', 'description', 'author', 'version', 'path'];

export async function parseConf(filePath: string): Promise<ParsedConf> {
  const raw = await readFile(filePath, 'utf8');
  return parseConfString(raw, filePath);
}

export function parseConfString(raw: string, filePath = '<inline>'): ParsedConf {
  const lines = raw.split(/\r?\n/);

  const meta: ConfMeta = {
    name: '',
    description: '',
    author: '',
    version: '',
    target: 'config',
    path: '',
    mode: 'replace',
    fetch: [],
    prompts: [],
    pins: [],
    requiresBin: [],
    includes: [],
  };

  let i = 0;
  let lastKey: string | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('//')) break;

    const stripped = line.replace(/^\/\/\s?/, '');

    // Hyphens allowed so multi-word keys read as one: @requires-bin.
    const m = stripped.match(/^@([\w-]+):\s*(.*)$/);
    if (m) {
      const key = m[1];
      const value = m[2].trim();
      lastKey = key;
      switch (key) {
        case 'name':
        case 'description':
        case 'author':
        case 'version':
        case 'path':
          meta[key] = value;
          break;
        case 'target':
          if (value !== 'config' && value !== 'tui') {
            throw parseError(filePath, i + 1, `@target must be "config" or "tui", got "${value}"`);
          }
          meta.target = value;
          break;
        case 'mode':
          if (value !== 'replace' && value !== 'merge' && value !== 'merge-overwrite' && value !== 'append') {
            throw parseError(filePath, i + 1, `@mode must be "replace", "merge", "merge-overwrite", or "append", got "${value}"`);
          }
          meta.mode = value;
          break;
        case 'fetch':
          meta.fetch.push(parseFetch(value, filePath));
          break;
        case 'prompt':
          meta.prompts.push(parsePrompt(value, filePath));
          break;
        case 'pins':
          meta.pins.push(parsePin(value, filePath));
          break;
        case 'requires-bin':
          meta.requiresBin.push(parseRequiresBin(value, filePath, i + 1));
          break;
        case 'include':
          if (!value) throw parseError(filePath, i + 1, '@include needs a preset name or path');
          meta.includes.push(value);
          break;
        default:
          throw parseError(filePath, i + 1, `unknown header key @${key}`);
      }
    } else if (lastKey === 'description') {
      const cont = stripped.trim();
      if (cont.length > 0) meta.description += ' ' + cont;
    } else if (lastKey === 'requires-bin') {
      // A setup hint may take several lines: one tool has more than one way in
      // (a package manager on one platform, a source build on another), and
      // formatSetup already prints a hint line by line. Joined with a newline
      // rather than a space so each line stays a command the user can paste.
      const cont = stripped.trim();
      if (cont.length > 0) {
        const req = meta.requiresBin[meta.requiresBin.length - 1];
        req.setup = req.setup ? req.setup + '\n' + cont : cont;
      }
    }
  }

  while (i < lines.length && lines[i].trim() === '') i++;

  const bodyText = lines.slice(i).join('\n').trim();

  // A bundle is a pure list. Refusing @path and a body here is what keeps one
  // from ever reaching an applier: with an empty @path, applyAtPath would treat
  // the whole config as the leaf and replace it wholesale.
  if (meta.includes.length > 0) {
    if (meta.path) {
      throw parseError(filePath, 1, '@include presets are bundles: they must not set @path, only list other presets');
    }
    if (bodyText) {
      throw parseError(filePath, i + 1, '@include presets are bundles: they must not have a body, only list other presets');
    }
    // A bundle never reaches an applier, so these would be silently dropped.
    // Rejecting them beats letting an author think they took effect.
    for (const [key, present] of [
      ['fetch', meta.fetch.length], ['prompt', meta.prompts.length], ['pins', meta.pins.length],
      ['requires-bin', meta.requiresBin.length],
    ] as const) {
      if (present) {
        throw parseError(filePath, 1, `@include presets must not set @${key} — put it on the preset that uses it`);
      }
    }
    for (const k of REQUIRED) {
      if (k === 'path') continue;
      if (!meta[k]) throw parseError(filePath, 1, `missing required header @${k}`);
    }
    return { meta, body: null };
  }

  if (!bodyText) {
    throw parseError(filePath, i + 1, 'preset has no body');
  }

  let body: unknown;
  try {
    body = JSON.parse(stripJsonComments(bodyText));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw parseError(filePath, i + 1, `body is not valid JSON: ${msg}`);
  }

  for (const k of REQUIRED) {
    if (!meta[k]) throw parseError(filePath, 1, `missing required header @${k}`);
  }

  if ((meta.mode === 'merge' || meta.mode === 'merge-overwrite') &&
      (body === null || typeof body !== 'object' || Array.isArray(body))) {
    throw parseError(filePath, 1, `@mode: ${meta.mode} requires the body to be a JSON object`);
  }

  if (meta.mode === 'append' && !Array.isArray(body)) {
    throw parseError(filePath, 1, '@mode: append requires the body to be a JSON array');
  }

  return { meta, body };
}

// Index of the nth occurrence of `needle`, or -1 if there are fewer than n.
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

function parsePrompt(value: string, filePath: string): PromptDirective {
  // Only the first four separators are structural. Everything after the fourth
  // is the setup hint, taken verbatim: it is a shell command and may well
  // contain pipes — `curl -fsSL https://…/install.sh | bash` is how one of
  // these tools is installed. Sliced rather than split-and-rejoined, because a
  // rejoin normalises the spacing around every pipe it passes, and a pipe
  // inside quotes (`--grep 'fix|feat'`) is a different pattern with spaces
  // around it. This string is printed for the user to paste.
  const fourth = nthIndexOf(value, '|', 4);
  const structural = fourth === -1 ? value : value.slice(0, fourth);
  const parts = structural.split('|').map(s => s.trim());
  if (fourth !== -1) parts.push(value.slice(fourth + 1).trim());
  if (parts.length < 2) {
    throw parseError(filePath, 0, `@prompt must be "name | type | help | default | setup" (help, default and setup optional), got "${value}"`);
  }
  const [name, type, help = '', rawDef, setup] = parts;
  // An empty default field means "no default", not "default to the empty
  // string": an empty answer with an empty default fails the same emptiness
  // check anyway, and the field has to stay skippable so a prompt with no
  // default can still carry a setup hint after it.
  const def = rawDef ? rawDef : undefined;
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw parseError(filePath, 0, `@prompt name must be alphanumeric/underscore/hyphen, got "${name}"`);
  }
  if (type !== 'text' && type !== 'secret' && type !== 'dir') {
    throw parseError(filePath, 0, `@prompt type must be "text", "secret", or "dir", got "${type}"`);
  }
  if (def !== undefined && type === 'secret') {
    throw parseError(filePath, 0, `@prompt default value is not allowed for type "secret" (got "${value}")`);
  }
  const p: PromptDirective = { name, type, help };
  if (def !== undefined) p.default = def;
  if (setup) p.setup = setup;
  return p;
}

function parseRequiresBin(value: string, filePath: string, line: number): RequiresBinDirective {
  // First `|` only: the install command on the right is free-form and may well
  // contain a pipe of its own.
  const sep = value.indexOf('|');
  const bin = (sep === -1 ? value : value.slice(0, sep)).trim();
  const setup = sep === -1 ? '' : value.slice(sep + 1).trim();
  if (!bin) throw parseError(filePath, line, '@requires-bin needs an executable name');
  // A name, resolved against PATH — not a path. Accepting "/opt/x/bin/dcg"
  // here would make the check pass on one machine and fail on the next.
  if (bin.includes('/') || bin.includes('\\') || /\s/.test(bin)) {
    throw parseError(filePath, line, `@requires-bin must be an executable name on PATH, not a path, got "${bin}"`);
  }
  return setup ? { bin, setup } : { bin };
}

function parsePin(value: string, filePath: string): PinDirective {
  const parts = value.split(/\s+/).filter(s => s.length > 0);
  if (parts.length !== 2) {
    throw parseError(filePath, 0, `@pins must be "name version", got "${value}"`);
  }
  const [name, version] = parts;
  return { name, version };
}

function parseFetch(value: string, filePath: string): FetchDirective {
  const arrowIdx = value.indexOf('->');
  if (arrowIdx === -1) {
    throw parseError(filePath, 0, `@fetch must be "URL -> dest [sha256=hex]", got "${value}"`);
  }
  const url = value.slice(0, arrowIdx).trim();
  const rest = value.slice(arrowIdx + 2).trim();

  let dest = rest;
  let sha256: string | null = null;

  const shaMatch = rest.match(/\s+sha256=([0-9a-fA-F]+)\s*$/);
  if (shaMatch && shaMatch.index !== undefined) {
    dest = rest.slice(0, shaMatch.index).trim();
    sha256 = shaMatch[1].toLowerCase();
  }

  if (!url || !dest) {
    throw parseError(filePath, 0, `@fetch missing url or dest in "${value}"`);
  }
  return { url, dest, sha256 };
}

function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function parseError(filePath: string, line: number, msg: string): Error {
  return new Error(`${filePath}:${line}: ${msg}`);
}
