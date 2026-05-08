import { readFile } from 'node:fs/promises';
import type { MergeMode } from './merge.js';

export interface FetchDirective {
  url: string;
  dest: string;
  sha256: string | null;
}

export type PromptType = 'text' | 'secret';

export interface PromptDirective {
  name: string;
  type: PromptType;
  help: string;
  default?: string;
}

export interface ConfMeta {
  name: string;
  description: string;
  author: string;
  version: string;
  path: string;
  mode: MergeMode;
  fetch: FetchDirective[];
  prompts: PromptDirective[];
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
    path: '',
    mode: 'replace',
    fetch: [],
    prompts: [],
  };

  let i = 0;
  let lastKey: string | null = null;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('//')) break;

    const stripped = line.replace(/^\/\/\s?/, '');

    const m = stripped.match(/^@(\w+):\s*(.*)$/);
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
        case 'mode':
          if (value !== 'replace' && value !== 'merge' && value !== 'merge-overwrite') {
            throw parseError(filePath, i + 1, `@mode must be "replace", "merge", or "merge-overwrite", got "${value}"`);
          }
          meta.mode = value;
          break;
        case 'fetch':
          meta.fetch.push(parseFetch(value, filePath));
          break;
        case 'prompt':
          meta.prompts.push(parsePrompt(value, filePath));
          break;
        default:
          throw parseError(filePath, i + 1, `unknown header key @${key}`);
      }
    } else if (lastKey === 'description') {
      const cont = stripped.trim();
      if (cont.length > 0) meta.description += ' ' + cont;
    }
  }

  while (i < lines.length && lines[i].trim() === '') i++;

  const bodyText = lines.slice(i).join('\n').trim();
  if (!bodyText) {
    throw parseError(filePath, i + 1, 'module has no body');
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

  return { meta, body };
}

function parsePrompt(value: string, filePath: string): PromptDirective {
  const parts = value.split('|').map(s => s.trim());
  if (parts.length < 2 || parts.length > 4) {
    throw parseError(filePath, 0, `@prompt must be "name | type | help | default" (help and default optional), got "${value}"`);
  }
  const [name, type, help = '', def] = parts;
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw parseError(filePath, 0, `@prompt name must be alphanumeric/underscore/hyphen, got "${name}"`);
  }
  if (type !== 'text' && type !== 'secret') {
    throw parseError(filePath, 0, `@prompt type must be "text" or "secret", got "${type}"`);
  }
  if (def !== undefined && type === 'secret') {
    throw parseError(filePath, 0, `@prompt default value is not allowed for type "secret" (got "${value}")`);
  }
  return def !== undefined ? { name, type, help, default: def } : { name, type, help };
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
