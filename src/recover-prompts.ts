// Recover the answers a previous install gave to a preset's prompts by
// matching its body template against what that install left in the config.
//
// Every version bump re-runs the prompts, and re-typing a URL and a token that
// already sit in opencode.json is the whole cost of an upgrade. The recovered
// value becomes what Enter keeps; typing still replaces it.
//
// Matching is structural: a template string holding `{{prompt:x}}` captures
// whatever stands at the same spot in the config. `append` bodies are matched
// per entry against the existing entry with the same identity (package name or
// versioned cache path) — the one the install is about to supersede. Anything
// ambiguous — two different values for one prompt, a prompted `@path` — yields
// nothing rather than a guess.

import type { MergeMode } from './merge.js';
import { getAtPath, identity } from './merge.js';

type Json = unknown;
type JsonObject = Record<string, unknown>;

const PLACEHOLDER = /\{\{prompt:([a-zA-Z_][a-zA-Z0-9_-]*)\}\}/g;

export function recoverPromptValues(
  root: Json,
  path: string,
  template: Json,
  mode: MergeMode,
  cacheDir?: string
): Record<string, string> {
  // The path decides where to look; a prompted one cannot be resolved
  // without the answer we are trying to recover.
  if (/\{\{prompt:/.test(path)) return {};
  const existing = getAtPath(root, path);
  if (existing === undefined) return {};

  const found = new Map<string, string | null>();
  if (mode === 'append') {
    if (!Array.isArray(template) || !Array.isArray(existing)) return {};
    for (const t of template) {
      const id = identity(t, cacheDir);
      if (id === null) continue;
      const e = existing.find(v => identity(v, cacheDir) === id);
      if (e !== undefined) capture(t, e, found);
    }
  } else {
    capture(template, existing, found);
  }

  const out: Record<string, string> = {};
  for (const [name, value] of found) {
    if (value !== null && value !== '') out[name] = value;
  }
  return out;
}

function capture(t: Json, e: Json, found: Map<string, string | null>): void {
  if (typeof t === 'string') {
    if (typeof e === 'string') captureString(t, e, found);
    return;
  }
  if (Array.isArray(t)) {
    if (!Array.isArray(e) || e.length !== t.length) return;
    t.forEach((v, i) => capture(v, e[i], found));
    return;
  }
  if (isPlainObject(t)) {
    if (!isPlainObject(e)) return;
    for (const [k, v] of Object.entries(t)) {
      // A prompted key names the very value we lack; skip it.
      if (/\{\{prompt:/.test(k)) continue;
      if (k in e) capture(v, e[k], found);
    }
  }
}

function captureString(t: string, e: string, found: Map<string, string | null>): void {
  const names: string[] = [];
  let pattern = '';
  let last = 0;
  for (const m of t.matchAll(PLACEHOLDER)) {
    // `{{prompt:a}}{{prompt:b}}` has no literal to split on.
    if (names.length > 0 && m.index === last) return;
    pattern += escapeRegExp(t.slice(last, m.index)) + '([\\s\\S]*?)';
    names.push(m[1]);
    last = m.index! + m[0].length;
  }
  if (names.length === 0) return;
  pattern += escapeRegExp(t.slice(last));
  const match = new RegExp('^' + pattern + '$').exec(e);
  if (!match) return;
  names.forEach((name, i) => {
    const v = match[i + 1];
    // Two spots disagreeing on one prompt: the config was hand-edited and
    // neither value is the answer. null poisons the name for good.
    if (found.has(name) && found.get(name) !== v) found.set(name, null);
    else if (!found.has(name)) found.set(name, v);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
