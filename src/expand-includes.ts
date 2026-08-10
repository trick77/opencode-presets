// Expand @include bundles into the flat list of leaf modules to apply.
//
// A bundle contributes nothing itself — it has no @path and no body (enforced
// in parse-conf.ts) — so expansion returns only leaves. Declaration order is
// preserved, which matters for permission rules: opencode evaluates them
// last-match-wins and `merge` appends new keys at the end, so a bundle that
// lists its deny modules last is what keeps them winning.
//
// A leaf reached more than once (listed twice, or via two bundles) is applied
// once, at its first position.

import { basename } from 'node:path';
import { parseConf } from './parse-conf.js';
import type { ConfMeta } from './parse-conf.js';

export class IncludeCycleError extends Error {}

// Resolves an @include value, relative to the file that declared it, to an
// absolute conf path. Supplied by the caller so the CLI's search-path lookup
// stays in bin/.
export type IncludeResolver = (ref: string, fromFile: string) => Promise<string>;

// Called once per bundle encountered. A bundle is expanded away before anything
// else sees it, so its own @description would otherwise never reach the user —
// and that description is where a bundle says what it is and is not.
export type BundleVisitor = (meta: ConfMeta) => void;

export async function expandIncludes(
  confPaths: string[],
  resolveRef: IncludeResolver,
  onBundle?: BundleVisitor,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const chain: string[] = [];

  async function visit(confPath: string): Promise<void> {
    if (chain.includes(confPath)) {
      const loop = [...chain.slice(chain.indexOf(confPath)), confPath].map(p => basename(p, '.conf'));
      throw new IncludeCycleError(`@include cycle: ${loop.join(' → ')}`);
    }

    const { meta } = await parseConf(confPath);

    if (meta.includes.length === 0) {
      if (!seen.has(confPath)) {
        seen.add(confPath);
        out.push(confPath);
      }
      return;
    }

    onBundle?.(meta);
    chain.push(confPath);
    for (const ref of meta.includes) {
      await visit(await resolveRef(ref, confPath));
    }
    chain.pop();
  }

  for (const confPath of confPaths) await visit(confPath);
  return out;
}
