// Apply a value at a dotted JSON path.
//
// Modes:
//   'replace'         — value at path is replaced wholesale.
//   'merge'           — additive object merge: keys present in the target
//                       are PRESERVED (never overwritten). Only keys
//                       missing from the target are added. Idempotent.
//   'merge-overwrite' — object merge that DOES overwrite overlapping
//                       keys.

export type MergeMode = 'replace' | 'merge' | 'merge-overwrite';

export interface ApplyStats {
  mode: MergeMode;
  added: number;
  preserved: number;
  overwritten: number;
  replaced: boolean;
}

export interface RemoveStats {
  mode: MergeMode;
  removed: number;
  kept: number;
  missing: boolean;
}

type JsonObject = Record<string, unknown>;
type Json = unknown;

export function applyAtPath(
  root: Json,
  dottedPath: string,
  value: Json,
  mode: MergeMode = 'replace'
): { next: JsonObject; stats: ApplyStats } {
  const segments = parsePath(dottedPath);
  const next: JsonObject =
    root === undefined || root === null ? {} : (structuredClone(root) as JsonObject);

  if (segments.length === 0) {
    const { value: merged, stats } = combine(next, value, mode);
    return { next: merged as JsonObject, stats };
  }

  let cursor: JsonObject = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!isPlainObject(cursor[seg])) cursor[seg] = {};
    cursor = cursor[seg] as JsonObject;
  }
  const last = segments[segments.length - 1];

  const { value: combined, stats } = combine(cursor[last], value, mode);
  cursor[last] = combined;
  return { next, stats };
}

function combine(existing: Json, incoming: Json, mode: MergeMode): { value: Json; stats: ApplyStats } {
  const stats: ApplyStats = { mode, added: 0, preserved: 0, overwritten: 0, replaced: false };

  if (mode === 'merge' || mode === 'merge-overwrite') {
    if (!isPlainObject(incoming)) {
      throw new Error(`@mode: ${mode} requires the body to be a JSON object`);
    }
    const target: JsonObject = isPlainObject(existing) ? { ...(existing as JsonObject) } : {};
    for (const [k, v] of Object.entries(incoming)) {
      if (k in target) {
        if (mode === 'merge-overwrite' && !deepEqual(target[k], v)) {
          target[k] = v;
          stats.overwritten++;
        } else {
          stats.preserved++;
        }
      } else {
        target[k] = v;
        stats.added++;
      }
    }
    return { value: target, stats };
  }

  // replace
  stats.replaced = !deepEqual(existing, incoming);
  return { value: incoming, stats };
}

// Remove a value or selected keys at a dotted JSON path.
// For 'replace' mode: deletes the whole leaf at `path`.
// For merge modes: deletes each key from `body` at `path` only if the
// current value still matches `body[key]`. Empty parent objects pruned.
export function removeAtPath(
  root: Json,
  dottedPath: string,
  body: Json,
  mode: MergeMode = 'replace'
): { next: JsonObject; stats: RemoveStats } {
  const next: JsonObject =
    root === undefined || root === null ? {} : (structuredClone(root) as JsonObject);
  const segments = parsePath(dottedPath);
  const stats: RemoveStats = { mode, removed: 0, kept: 0, missing: false };

  if (segments.length === 0) return { next, stats };

  const parents: { obj: JsonObject; key: string }[] = [];
  let cursor: JsonObject = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!isPlainObject(cursor[seg])) {
      stats.missing = true;
      return { next, stats };
    }
    parents.push({ obj: cursor, key: seg });
    cursor = cursor[seg] as JsonObject;
  }
  const last = segments[segments.length - 1];

  if (!(last in cursor)) {
    stats.missing = true;
    return { next, stats };
  }

  if (mode === 'merge' || mode === 'merge-overwrite') {
    if (!isPlainObject(body)) {
      throw new Error(`remove in @mode: ${mode} requires the body to be a JSON object`);
    }
    const target = cursor[last];
    if (!isPlainObject(target)) {
      stats.missing = true;
      return { next, stats };
    }
    const targetObj = target as JsonObject;
    for (const k of Object.keys(body as JsonObject)) {
      if (!(k in targetObj)) continue;
      if (deepEqual(targetObj[k], (body as JsonObject)[k])) {
        delete targetObj[k];
        stats.removed++;
      } else {
        stats.kept++;
      }
    }
    if (Object.keys(targetObj).length === 0) {
      delete cursor[last];
      pruneEmpty(parents);
    }
  } else {
    delete cursor[last];
    stats.removed = 1;
    pruneEmpty(parents);
  }

  return { next, stats };
}

function pruneEmpty(parents: { obj: JsonObject; key: string }[]): void {
  for (let i = parents.length - 1; i >= 0; i--) {
    const { obj, key } = parents[i];
    const child = obj[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete obj[key];
    } else {
      break;
    }
  }
}

export function getAtPath(root: Json, dottedPath: string): Json {
  const segments = parsePath(dottedPath);
  let cursor: Json = root;
  for (const seg of segments) {
    if (cursor === undefined || cursor === null) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as JsonObject)[seg];
  }
  return cursor;
}

// Path parser supporting:
//   foo.bar.baz
//   foo["weird key"].bar
//   foo['weird key'].bar
function parsePath(path: string): string[] {
  const segments: string[] = [];
  let i = 0;
  let buf = '';
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      if (buf.length > 0) { segments.push(buf); buf = ''; }
      i++;
    } else if (c === '[') {
      if (buf.length > 0) { segments.push(buf); buf = ''; }
      const quote = path[i + 1];
      if (quote !== '"' && quote !== "'") {
        throw new Error(`malformed path at index ${i}: bracket must contain a quoted string`);
      }
      const end = path.indexOf(quote + ']', i + 2);
      if (end === -1) {
        throw new Error(`malformed path: unterminated bracket starting at index ${i}`);
      }
      segments.push(path.slice(i + 2, end));
      i = end + 2;
    } else {
      buf += c;
      i++;
    }
  }
  if (buf.length > 0) segments.push(buf);
  return segments;
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as JsonObject), kb = Object.keys(b as JsonObject);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual((a as JsonObject)[k], (b as JsonObject)[k]));
  }
  return false;
}

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
