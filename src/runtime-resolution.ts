import * as pep440 from "@renovatebot/pep440";
import { createRequire } from "node:module";

const semver = createRequire(import.meta.url)("semver") as {
  valid(version: string): string | null; prerelease(version: string): unknown[] | null;
  rcompare(a: string, b: string): number;
};
export type RuntimeSource = "npm" | "pypi" | "github" | "vendor" | "oci";
export type RuntimeRelease = {
  version: string;
  publishedAt: string;
  source: RuntimeSource;
  locator: string;
  integrity: string;
  deprecated?: string;
  yanked?: boolean;
  unpublished?: boolean;
  malicious?: boolean;
  prerelease?: boolean;
  draft?: boolean;
  /** Stable OCI build flavors are separate from release channels. */
  flavor?: string;
  proofs?: { kind: string; locator: string }[];
  metadata?: Record<string, unknown>;
};
export type RuntimePolicy = { minReleaseAgeMs?: number; allowPrerelease?: boolean; override?: string };
export type RuntimeSelection = {
  release: RuntimeRelease;
  policy: { minReleaseAgeMs: number; allowPrerelease: boolean; override: string | null };
  selectedAt: string; cutoff: string;
  excluded: { version: string; reason: string }[];
  warnings: string[];
};
export class RuntimePolicyError extends Error {
  constructor(public readonly code: string, message: string, public readonly receipt?: unknown) { super(`${code}: ${message}`); this.name = "RuntimePolicyError"; }
}
export function selectRuntimeRelease(releases: readonly RuntimeRelease[], options: RuntimePolicy & { now: string }): RuntimeSelection {
  const clock = Date.parse(options.now), age = options.minReleaseAgeMs ?? 86_400_000;
  if (!Number.isFinite(clock) || !Number.isFinite(age) || age < 0) throw new RuntimePolicyError("RUNTIME_POLICY_INVALID", "Clock and nonnegative minReleaseAgeMs are required.");
  const cutoff = clock - age, excluded: RuntimeSelection["excluded"] = [];
  const candidates = releases.filter((release) => {
    let reason: string | undefined;
    if (!(release.source === "pypi" ? pep440.valid(release.version) : semver.valid(release.version))) reason = "invalid-version";
    else if (options.override && release.version !== options.override) reason = "not-override";
    else if (!Number.isFinite(Date.parse(release.publishedAt))) reason = "missing-publish-time";
    else if (Date.parse(release.publishedAt) > cutoff) reason = "release-too-new";
    else if (release.malicious) reason = "malicious";
    else if (release.yanked) reason = "yanked";
    else if (release.unpublished) reason = "unpublished";
    else if (release.draft) reason = "draft";
    else if ((release.prerelease || isPrerelease(release)) && !options.allowPrerelease) reason = "prerelease";
    else if (release.deprecated && !options.override) reason = "deprecated";
    else if (!release.locator || !release.integrity) reason = "missing-integrity";
    if (reason) { excluded.push({ version: release.version, reason }); return false; }
    return true;
  }).sort((a, b) => a.source === "pypi" && b.source === "pypi" ? pep440.rcompare(a.version, b.version) : semver.rcompare(a.version, b.version));
  if (!candidates[0]) throw new RuntimePolicyError("RUNTIME_NO_ELIGIBLE_RELEASE", JSON.stringify({ override: options.override ?? null, excluded }));
  const release = structuredClone(candidates[0]);
  return { release, policy: { minReleaseAgeMs: age, allowPrerelease: options.allowPrerelease ?? false, override: options.override ?? null },
    selectedAt: new Date(clock).toISOString(), cutoff: new Date(cutoff).toISOString(), excluded,
    warnings: release.deprecated ? [`RUNTIME_DEPRECATED: ${release.deprecated}`] : [] };
}

function isPrerelease(release: RuntimeRelease): boolean {
  if (release.source !== "pypi") return semver.prerelease(release.version) !== null;
  const parsed = pep440.parse(release.version);
  return Boolean(parsed?.pre || parsed?.dev);
}

export function isExactRuntimeVersion(value: unknown): value is string {
  return typeof value === "string" && semver.valid(value) === value;
}
