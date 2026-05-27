import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';

const SCHEMA_URL = 'https://opencode.ai/config.json';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  // True when the schema itself was unavailable (offline + no cache).
  // Caller decides whether to abort or warn.
  skipped?: boolean;
}

type ValidatorFn = ((v: unknown) => boolean) & { errors?: unknown[] | null };
const _validators = new Map<string, ValidatorFn>();

// Validate `config` against opencode's JSON schema. Lazily fetches and
// caches the schema on first call. On network failure with no cache,
// returns { ok: true, skipped: true, errors: [] } so the caller can
// surface a non-blocking warning rather than aborting offline use.
export async function validateAgainstSchema(
  config: unknown,
  cacheDir: string,
  schemaUrl = SCHEMA_URL
): Promise<ValidationResult> {
  let schema: unknown;
  try {
    schema = await loadSchema(cacheDir, schemaUrl);
  } catch (e) {
    return {
      ok: true,
      skipped: true,
      errors: [
        `schema unavailable (${e instanceof Error ? e.message : String(e)}); ` +
        'validation skipped',
      ],
    };
  }

  let validator = _validators.get(schemaUrl);
  if (!validator) {
    const ajv = new Ajv2020({
      strict: false,        // schema uses non-standard `ref` / `allowComments` keywords
      allErrors: true,
      allowUnionTypes: true,
      loadSchema: async (uri: string) => {
        const r = await fetch(uri);
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching schema ${uri}`);
        return r.json();
      },
    });
    try {
      validator = (await ajv.compileAsync(schema as object)) as ValidatorFn;
      _validators.set(schemaUrl, validator);
    } catch (e) {
      // Schema compile failed (e.g. unresolved $ref offline). Surface as
      // a non-blocking skip rather than aborting the user's apply.
      return {
        ok: true,
        skipped: true,
        errors: [`schema compilation failed (${e instanceof Error ? e.message : String(e)}); validation skipped`],
      };
    }
  }

  const valid = validator(config);
  if (valid) return { ok: true, errors: [] };

  const errors = (validator.errors ?? []).map(formatError);
  return { ok: false, errors };
}

function formatError(err: unknown): string {
  const e = err as { instancePath?: string; message?: string; params?: Record<string, unknown> };
  const path = e.instancePath || '<root>';
  const msg = e.message || 'unknown error';
  // Some Ajv errors carry useful params (e.g., additionalProperties names).
  const extra = e.params && Object.keys(e.params).length > 0
    ? ' ' + JSON.stringify(e.params)
    : '';
  return `${path}: ${msg}${extra}`;
}

async function loadSchema(cacheDir: string, schemaUrl: string): Promise<unknown> {
  const cachePath = `${cacheDir}/${schemaCacheName(schemaUrl)}`;
  if (await fileExists(cachePath)) {
    try {
      const raw = await readFile(cachePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      // fall through to refetch
    }
  }
  // Fetch and cache.
  const res = await fetch(schemaUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${schemaUrl}`);
  const text = await res.text();
  // Parse to validate before caching.
  const parsed = JSON.parse(text);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, text, 'utf8');
  return parsed;
}

function schemaCacheName(schemaUrl: string): string {
  if (schemaUrl.endsWith('/tui.json')) return 'tui-schema.json';
  return 'schema.json';
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

// Allow callers to force a fresh fetch on next validate (e.g. after a
// hypothetical `opencode-presets schema refresh` command).
export function resetValidatorCache(): void {
  _validators.clear();
}
