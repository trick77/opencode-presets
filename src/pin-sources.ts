// Where the current version of each @pins artifact can be looked up.
//
// @pins live in preset headers — a comment format no dependency bot can parse —
// so Dependabot covers package.json and nothing else. Without this map a pinned
// artifact can sit years behind and no CI run would notice. The lookup itself
// is in scripts/check-pins.mjs; this file stays pure so tests can cover the
// parts that actually broke without touching the network.

export type PinSource =
  | { kind: 'npm'; pkg: string }
  | { kind: 'github-release'; repo: string }
  | { kind: 'github-tags'; repo: string };

export const PIN_SOURCES: Record<string, PinSource> = {
  '@playwright/mcp': { kind: 'npm', pkg: '@playwright/mcp' },
  'opencode-plugin-dcg': { kind: 'npm', pkg: 'opencode-plugin-dcg' },
  'opencode-plugin-litellm-pricing': { kind: 'npm', pkg: 'opencode-plugin-litellm-pricing' },
  'superpowers': { kind: 'github-release', repo: 'obra/superpowers' },
  // Tags, not releases: the repo tags every version and publishes no GitHub
  // release, so the release endpoint would report nothing at all.
  'planify': { kind: 'github-tags', repo: 'trick77/planify' },
  // Tags, not the two obvious sources, both of which are wrong for lombok:
  // Maven Central's search index reported 1.18.38 as latest while 1.18.46 was
  // downloadable, and projectlombok.org/all-versions only linked jars up to
  // 1.18.44 — which made the correct pin look *ahead* of upstream. The repo has
  // no GitHub releases, but it does tag every version.
  'lombok': { kind: 'github-tags', repo: 'projectlombok/lombok' },
};

export class UnknownPinError extends Error {}

export function pinSourceFor(name: string): PinSource {
  const source = PIN_SOURCES[name];
  if (!source) {
    throw new UnknownPinError(
      `no version source registered for @pins "${name}" — add one to src/pin-sources.ts ` +
      'so the drift check can see it',
    );
  }
  return source;
}

// Newest plain version tag, or null when none of them look like versions.
//
// GitHub returns tags in no documented order, so picking the first would be a
// coin flip. Anything that is not exactly `1.2.3` / `v1.2.3` — release
// candidates, edge builds, dated tags — is dropped rather than ranked.
export function latestSemverTag(tagNames: string[]): string | null {
  const versions = tagNames
    .map(t => t.replace(/^v/, ''))
    .filter(t => /^\d+\.\d+\.\d+$/.test(t))
    .sort(compareVersions);
  return versions.at(-1) ?? null;
}

// Compare two dotted numeric versions. Only used to rank candidates from one
// source; a non-numeric segment sorts as 0, which suits the shapes here.
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
