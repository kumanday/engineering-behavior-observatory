import {createHash} from "node:crypto";
import {dirname, basename, join} from "node:path";
import {pathToFileURL} from "node:url";
import {writeFile} from "node:fs/promises";
import {assertNoDuplicateJsonKeys, digestMetadata} from "./artifacts.js";
import {isSafeArtifactRelativePath} from "./contracts.js";
import {readBoundedFile} from "./scheduler.js";
import {RuntimePolicyError, type RuntimeRelease} from "./runtime-resolution.js";
import type {RuntimeSecurityComponent} from "./runtime-security.js";
import type {RuntimeArtifact} from "./runtime-artifacts.js";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/u;
export const MAX_LOCAL_PYTHON_WHEEL_BYTES = 64 * 1024 * 1024;
const invalid = (message: string): never => {throw new RuntimePolicyError("RUNTIME_LOCAL_WHEEL_INVALID", message);};
export type WheelBuildProvenance = {schemaVersion: "ebo.python-wheel-build/v1"; name: string; version: string;
  wheel: {filename: string; sha256: string}; source: {url: string; sha256: string; publishedAt: string};
  patches?: {url: string; commit: string; sha256: string; publishedAt: string; status: string}[];
  upstreamWheel?: {url: string; sha256: string; publishedAt: string};
  builtAt: string; target: {python: string; platform: string; abi: string}; recipe: {sha256: string; [key: string]: unknown};
  buildTools: {name: string; version: string; [key: string]: unknown}[]; tests: {name: string; status: "passed"; exitCode: 0; sha256: string; [key: string]: unknown}[];
  securityComponents: RuntimeSecurityComponent[]; [key: string]: unknown};
export type RetainedLocalWheel = {bytesBase64: string; provenance: WheelBuildProvenance; provenanceDigest: string};
export type LocalWheelAdmission = RetainedLocalWheel & {name: string; version: string; filename: string; sha256: string; localUrl: string};

/** Explicit operator admission only. Resolution and installation never build source. */
export async function admitLocalPythonWheels(manifestPath: string | undefined, staging?: string): Promise<LocalWheelAdmission[]> {
  if (!manifestPath) return [];
  const bytes = readBoundedFile(manifestPath, "Local wheel manifest", undefined, 1024 * 1024);
  const json = (bytes: Uint8Array): any => {const text = new TextDecoder("utf8", {fatal: true}).decode(bytes); assertNoDuplicateJsonKeys(text); return JSON.parse(text);};
  const manifest = json(bytes);
  if (manifest.schemaVersion !== "ebo.local-python-wheels/v1" || !Array.isArray(manifest.wheels) || !manifest.wheels.length || manifest.wheels.length > 16) invalid("Expected an explicit local wheel manifest with 1–16 artifacts.");
  const admissions: LocalWheelAdmission[] = []; let total = 0;
  for (const entry of manifest.wheels) {
    if (!isSafeArtifactRelativePath(entry.wheel) || !isSafeArtifactRelativePath(entry.provenance) || !hashPattern.test(entry.sha256) || !hashPattern.test(entry.provenanceSha256)) invalid("Wheel and provenance require relative paths and SHA-256 digests.");
    const wheel = readBoundedFile(join(dirname(manifestPath), entry.wheel), "Admitted local wheel", undefined, MAX_LOCAL_PYTHON_WHEEL_BYTES);
    const receipt = readBoundedFile(join(dirname(manifestPath), entry.provenance), "Wheel build provenance", undefined, 1024 * 1024);
    total += wheel.length; if (total > 128 * 1024 * 1024 || sha(wheel) !== entry.sha256 || sha(receipt) !== entry.provenanceSha256) invalid("Local wheel or provenance bytes differ from admission.");
    const provenance = json(receipt) as WheelBuildProvenance;
    const filename = basename(entry.wheel);
    if (provenance.schemaVersion !== "ebo.python-wheel-build/v1" || !/^[a-z0-9][a-z0-9_.-]*$/iu.test(provenance.name) || typeof provenance.version !== "string"
        || provenance.wheel?.filename !== filename || provenance.wheel?.sha256 !== entry.sha256 || !filename.endsWith(".whl")
        || !hashPattern.test(provenance.source?.sha256) || !provenance.source?.url?.startsWith("https://") || !Number.isFinite(Date.parse(provenance.source?.publishedAt))
        || !Number.isFinite(Date.parse(provenance.builtAt)) || !provenance.target?.python || !provenance.target?.platform || !provenance.target?.abi || !hashPattern.test(provenance.recipe?.sha256)
        || !Array.isArray(provenance.buildTools) || !provenance.buildTools.length || provenance.buildTools.some(tool => !tool.name || !tool.version)
        || !Array.isArray(provenance.tests) || !provenance.tests.length || provenance.tests.some(test => test.status !== "passed" || test.exitCode !== 0 || !hashPattern.test(test.sha256))
        || !Array.isArray(provenance.securityComponents) || !provenance.securityComponents.length || provenance.securityComponents.some(component => !component.id || !component.name || !component.version || !(component.ecosystem || component.purl))) invalid("Build provenance lacks the source, target, recipe, tools or passing checks.");
    for (const tool of provenance.buildTools) if (!provenance.securityComponents.some(component => component.ecosystem === "PyPI" && component.name.toLowerCase().replace(/[-_.]+/gu, "-") === tool.name.toLowerCase().replace(/[-_.]+/gu, "-") && component.version === tool.version)) invalid("Every pinned Python build tool must be included in launch security checks.");
    if (provenance.patches !== undefined && (!Array.isArray(provenance.patches) || provenance.patches.length > 16
        || provenance.patches.some(patch => !patch.url?.startsWith("https://") || !/^[a-f0-9]{40}$/u.test(patch.commit)
          || !hashPattern.test(patch.sha256) || !Number.isFinite(Date.parse(patch.publishedAt)) || !patch.status))) invalid("Source patches require an exact commit, hash, publication time and upstream status.");
    if (provenance.upstreamWheel && (!provenance.upstreamWheel.url?.startsWith("https://") || !hashPattern.test(provenance.upstreamWheel.sha256)
        || !Number.isFinite(Date.parse(provenance.upstreamWheel.publishedAt)))) invalid("An upstream binary wheel requires its URL, hash and publication time.");
    const libyaml = provenance.libyaml as {version?: string} | undefined;
    if (libyaml && (!libyaml.version || !provenance.securityComponents.some(component => component.purl === "pkg:github/yaml/libyaml" && component.version === libyaml.version))) invalid("The declared LibYAML build input must be included in launch security checks.");
    const name = provenance.name.toLowerCase().replace(/[-_.]+/gu, "-");
    if (admissions.some(wheel => wheel.name === name)) invalid("Admit one exact wheel per distribution.");
    const path = staging ? join(staging, filename) : join(dirname(manifestPath), entry.wheel); if (staging) await writeFile(path, wheel, {flag: "wx", mode: 0o600});
    admissions.push({name, version: provenance.version, filename, sha256: entry.sha256, bytesBase64: wheel.toString("base64"), provenance,
      provenanceDigest: `sha256:${digestMetadata(provenance).value}`, localUrl: pathToFileURL(path).href});
  }
  return admissions;
}

/** Upstream identity supplies withdrawal checks and source age; the built wheel has its own hash. */
export function localWheelRelease(admission: LocalWheelAdmission, release: RuntimeRelease): RuntimeRelease {
  const file = (release.metadata?.files as any[] | undefined)?.find(file => file.url === admission.provenance.source.url);
  if (!file || file.packagetype !== "sdist" || file.digests?.sha256 !== admission.provenance.source.sha256
      || file.upload_time_iso_8601 !== admission.provenance.source.publishedAt) invalid("Wheel source differs from the upstream released sdist.");
  const binary = admission.provenance.upstreamWheel;
  const binaryFile = binary && (release.metadata?.files as any[] | undefined)?.find(file => file.url === binary.url);
  if (binary && (!binaryFile || binaryFile.packagetype !== "bdist_wheel" || binaryFile.digests?.sha256 !== binary.sha256
      || binaryFile.upload_time_iso_8601 !== binary.publishedAt)) invalid("Repackaged binary input differs from the upstream wheel.");
  const publishedAt = [admission.provenance.source.publishedAt, ...(binary ? [binary.publishedAt] : []), ...(admission.provenance.patches ?? []).map(patch => patch.publishedAt)]
    .reduce((latest, date) => Date.parse(date) > Date.parse(latest) ? date : latest);
  return {...release, publishedAt, locator: `ebo-wheel:sha256:${admission.sha256}`, integrity: `sha256-${Buffer.from(admission.sha256, "hex").toString("base64")}`, yanked: Boolean(file.yanked || binaryFile?.yanked),
    metadata: {localWheel: {source: admission.provenance.source, ...(binary ? {upstreamWheel: binary} : {}), patches: admission.provenance.patches ?? [], builtAt: admission.provenance.builtAt, filename: admission.filename, provenanceDigest: admission.provenanceDigest}}};
}
export function retainedLocalWheel(admission: LocalWheelAdmission): RetainedLocalWheel {
  return {bytesBase64: admission.bytesBase64, provenance: admission.provenance, provenanceDigest: admission.provenanceDigest};
}
export function localWheelSecurity(artifacts: readonly RuntimeArtifact[]): RuntimeSecurityComponent[] {
  return artifacts.flatMap(artifact => artifact.localWheel?.provenance.securityComponents ?? []);
}

export function localWheelInputDigest(wheels: readonly Pick<LocalWheelAdmission, "filename" | "sha256" | "provenanceDigest">[]): `sha256:${string}` {
  const values = wheels.map(wheel => ({filename: wheel.filename, sha256: wheel.sha256, provenanceDigest: wheel.provenanceDigest}));
  return `sha256:${digestMetadata([...new Map(values.map(value => [JSON.stringify(value), value])).values()].sort((a, b) => a.filename.localeCompare(b.filename))).value}`;
}
