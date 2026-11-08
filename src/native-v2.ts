import { nativeModelAliasesV2 } from "./native-model-aliases-v2.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digestBytes, digestMetadata } from "./artifacts.js";
import { createPointerEvidenceResolver } from "./evidence-pointers.js";
import { createRetainedBehaviorEvidence, type RetainedBehaviorEvidence } from "./retained-evidence.js";
import { readBoundedFile } from "./scheduler.js";
import { validateNormalizedDataset } from "./normalization-integrity.js";
import { buildOperationsV2, digestValue, object, unreported, type NativeProjectionProfile, type ProjectionPopulation } from "./projection-v2.js";
import { validateNormalizedDatasetV2, type NormalizedDatasetV2, type UniformEventV2 } from "./normalization-v2.js";
import type { CapturedNativeRecord, NativeEvidenceReference, NativeEvidenceResolver } from "./uniform-events.js";
import { claudeV2Profile } from "./v2-profiles/claude.js";
import { piV2Profile } from "./v2-profiles/pi.js";
import { codexV2Profile } from "./v2-profiles/codex.js";
import { factoryV2Profile } from "./v2-profiles/factory.js";
import { cursorV2Profile } from "./v2-profiles/cursor.js";
import { devinV2Profile } from "./v2-profiles/devin.js";
import { openHandsV2Profile } from "./v2-profiles/openhands.js";
import { deepSeekV2Profile } from "./v2-profiles/deepseek.js";
type Hash = `sha256:${string}`;
const profiles = [claudeV2Profile, piV2Profile, codexV2Profile, factoryV2Profile, cursorV2Profile, devinV2Profile, openHandsV2Profile, deepSeekV2Profile];
export type SourceEvidenceResolverV2 = NativeEvidenceResolver & { read(reference: NativeEvidenceReference): unknown };
export type RetainedBehaviorEvidenceV2 = Omit<RetainedBehaviorEvidence, "dataset" | "coverage" | "resolver"> & {
  dataset: NormalizedDatasetV2;
  resolver: SourceEvidenceResolverV2;
};
const referenceKey = (reference: NativeEvidenceReference) => JSON.stringify([reference.artifactId, reference.recordLocator]);
export function listNativeV2Profiles(): readonly { id: string; version: string; harness: string }[] {
  return profiles.map(({ id, version, harness }) => ({ id, version, harness }));
}

/** Canonical pointed-value digests for both native JSONL and document pointers. */
export function createSourceEvidenceResolverV2(input: { runId: string; attemptId: string; records: readonly CapturedNativeRecord<unknown>[];
  fallback?: NativeEvidenceResolver }): SourceEvidenceResolverV2 {
  const convert = (reference: NativeEvidenceReference): NativeEvidenceReference | undefined => {
    const line = /^line:([1-9][0-9]*)(#(?:\/.*)?)?$/u.exec(reference.recordLocator);
    if (line) return { artifactId: JSON.stringify(["line", reference.artifactId, line[1]]), recordLocator: line[2] ?? "#" };
    if (reference.recordLocator === "#" || reference.recordLocator.startsWith("#/")) return {
      artifactId: JSON.stringify(["document", reference.artifactId]), recordLocator: reference.recordLocator,
    };
    return undefined;
  };
  const artifacts = new Set(input.records.map(({ reference }) => reference.artifactId));
  const resolutions = new Map(input.records.map(({ reference, record }) => [referenceKey(reference), {
    runId: input.runId, attemptId: input.attemptId, digest: digestValue(record),
  }]));
  const pointer = createPointerEvidenceResolver({ runId: input.runId, attemptId: input.attemptId,
    records: input.records.map(({ reference, record }) => {
      const converted = convert(reference); if (!converted) throw new Error("Invalid v2 native record locator.");
      return { reference: converted, record };
    }) });
  return {
    read(reference) { const converted = convert(reference); return converted ? pointer.read(converted)?.value : undefined; },
    async resolve(reference) {
      const key = referenceKey(reference), cached = resolutions.get(key);
      if (cached) return { ...cached };
      const converted = convert(reference), result = converted ? pointer.read(converted) : undefined;
      if (result) {
        const resolution = { runId: input.runId, attemptId: input.attemptId, digest: result.pointedDigest };
        resolutions.set(key, resolution); return { ...resolution };
      }
      if (artifacts.has(reference.artifactId) || !input.fallback) return false;
      const fallback = await input.fallback.resolve(reference);
      return fallback && typeof fallback === "object" && fallback.runId === input.runId && fallback.attemptId === input.attemptId ? fallback : false;
    },
  };
}

/** An independent derivation over qualified source records. Original v1 dataset and manifests remain untouched. */
export async function projectNativeEvidenceV2(evidence: RetainedBehaviorEvidence, binding: { manifestDigest: Hash; harnessVersion: string; modelAliases?: readonly string[] }): Promise<RetainedBehaviorEvidenceV2> {
  if (evidence.capture.qualification === "imported" || evidence.dataset.origin?.kind === "imported") throw new Error("Native v2 projection requires owned qualified evidence; imported documents use the ATIF core reader.");
  await validateNormalizedDataset(evidence.dataset, evidence.resolver);
  if (evidence.capture.runId !== evidence.dataset.runId || evidence.capture.attemptId !== evidence.dataset.attemptId) throw new Error("V2 capture and dataset identities differ.");
  const harness = evidence.dataset.adapter.harness === "agent-sdk" ? "claude-agent-sdk" : evidence.dataset.adapter.harness;
  const profile = profiles.find((profile) => profile.harness === harness);
  if (!profile) throw new Error("Unsupported native v2 source profile.");
  const records = new Map<string, CapturedNativeRecord<unknown>>();
  const sourceRecords: CapturedNativeRecord<unknown>[] = [];
  for (const captured of evidence.capture.records) {
    const raw = object(captured.record), record = harness === "claude-agent-sdk" ? raw.document : captured.record;
    const sourceRecord = { reference: captured.reference, record };
    records.set(referenceKey(captured.reference), sourceRecord);
    if (harness !== "claude-agent-sdk" || raw.kind === "session" || raw.kind === "hook") sourceRecords.push(sourceRecord);
  }
  if (evidence.outcomeCapture.qualification !== "imported") for (const captured of evidence.outcomeCapture.records) {
    const candidate = { reference: captured.reference, record: captured.record.document };
    const existing = records.get(referenceKey(candidate.reference));
    if (existing && existing.record !== candidate.record && digestValue(existing.record) !== digestValue(candidate.record)) throw new Error("V2 native and outcome records conflict.");
    if (!existing) records.set(referenceKey(candidate.reference), candidate);
  }
  const population: ProjectionPopulation = { runId: evidence.dataset.runId, attemptId: evidence.dataset.attemptId,
    records: [...records.values()], events: evidence.dataset.events, capture: evidence.capture };
  const rawRecords = sourceRecords.map(({ record }) => object(record));
  const context = (event: ProjectionPopulation["events"][number]) => {
    const captured = records.get(referenceKey(event.source.nativeReference));
    if (!captured) throw new Error("V2 event has no retained source record.");
    return { event, record: object(captured.record), records: rawRecords };
  };
  const original = [...population.events, ...profile.additional?.({ ...population, records: sourceRecords }) ?? []];
  const expanded = original.flatMap((event) => [event, ...profile.expand?.(context(event)) ?? []]);
  const projections = expanded.map((event) => profile.project(context(event)));
  const sourceId = `native:${harness}`;
  const events: UniformEventV2[] = expanded.map((event, index) => {
    const { nativeTime: _nativeTime, source: _source, ...rest } = structuredClone(event), projected = projections[index]!;
    return { ...rest, schemaVersion: "ebo.uniform-event/v2", source: { sourceId, nativeType: event.source.nativeType, nativeReference: event.source.nativeReference },
      clock: projected.clock, facts: projected.facts, family: projected.family ?? event.family, phase: projected.phase ?? event.phase,
      nativeOrder: projected.nativeOrder ?? event.nativeOrder, content: projected.content ?? event.content };
  });
  // Optional resource reports with no admitted dimensions carry no resource fact.
  for (const event of events) if (event.facts.resource === undefined) delete event.facts.resource;
  const operations = buildOperationsV2(events, projections);
  const implementationDigest = implementation(profile);
  const sourceTypes = new Map(evidence.dataset.nativeRecords.map((record) => [referenceKey(record.reference), record.nativeType]));
  const resolver = createSourceEvidenceResolverV2({ ...population, fallback: evidence.resolver });
  const nativeRecords: NormalizedDatasetV2["nativeRecords"] = [];
  for (const { reference } of population.records) {
    const resolved = await resolver.resolve(reference);
    if (!resolved || resolved === true) throw new Error("V2 native record cannot be digest-bound.");
    nativeRecords.push({ reference, nativeType: sourceTypes.get(referenceKey(reference)) ?? "retained-outcome-record", digest: resolved.digest });
  }
  const contentReferences = new Map<string, NormalizedDatasetV2["contentReferences"][number]>();
  for (const event of events) if (event.content.status === "known") for (const content of event.content.value) {
    const resolved = await resolver.resolve(content.nativeReference);
    if (!resolved || resolved === true) throw new Error("V2 content reference cannot be digest-bound.");
    contentReferences.set(referenceKey(content.nativeReference), { reference: content.nativeReference, digest: resolved.digest });
  }
  const mapped = new Map<string, string[]>();
  for (const event of events) { const key = referenceKey(event.source.nativeReference); mapped.set(key, [...mapped.get(key) ?? [], event.id]); }
  const unmapped = new Map(evidence.dataset.unmapped.map((record) => [referenceKey(record.reference), record.reason]));
  const sourceLimitations = [...new Set([...(evidence.dataset.capabilityProfile.limitations ?? []).filter(code => !["HARNESS_VERSION_UNVERIFIED", "HARNESS_CAPTURE_UNVERIFIED", "HARNESS_VERIFICATION_CONFLICT"].includes(code)), ...(evidence.verification?.limitations ?? [])])];
  const dataset: NormalizedDatasetV2 = { schemaVersion: "ebo.normalized-dataset/v2", runId: population.runId, attemptId: population.attemptId,
    normalizer: { id: profile.id, version: profile.version, implementationDigest },
    origin: { kind: "owned", qualification: evidence.capture.qualification, manifestDigest: binding.manifestDigest },
    sources: [{ id: sourceId, format: { kind: "native", version: "ebo.run-bundle/v1" }, reader: { id: profile.id, version: profile.version, implementationDigest },
      producerProfile: { status: "known", value: { id: profile.id, version: profile.version, digest: digestValue({ id: profile.id, version: profile.version, harness, implementationDigest }) } },
      executedHarness: { id: harness, version: evidence.dataset.capabilityProfile.limitations?.includes("HARNESS_VERSION_CONFLICT") ? { status: "unknown", reason: "HARNESS_VERSION_CONFLICT" } : { status: "known", value: binding.harnessVersion } }, authority: "owned-capture", ...(sourceLimitations.length ? { limitations: sourceLimitations } : {}) }],
    events, operations, measurements: [], nativeRecords, contentReferences: [...contentReferences.values()],
    recordCoverage: nativeRecords.map(({ reference }) => {
      const key = referenceKey(reference), eventIds = mapped.get(key) ?? [], reason = unmapped.get(key);
      return { reference, disposition: eventIds.length ? "mapped" : reason ? "unmapped" : "retained-only", eventIds,
        reason: eventIds.length ? unreported : { status: "known", value: reason ?? "RETAINED_SOURCE_WITHOUT_BEHAVIORAL_PROJECTION" } };
    }) };
  await validateNormalizedDatasetV2(dataset, resolver);
  const { dataset: _dataset, resolver: _resolver, coverage: _coverage, ...retained } = evidence;
  return { ...retained, dataset, resolver, modelAliases: nativeModelAliasesV2(evidence, sourceRecords, harness, binding.modelAliases) };
}

export async function createRetainedBehaviorEvidenceV2(bundleRoot: string): Promise<RetainedBehaviorEvidenceV2> {
  const bytes = readBoundedFile(join(bundleRoot, "manifest.json"), "Retained v2 manifest");
  const manifest = JSON.parse(bytes.toString("utf8")) as { schemaVersion?: string; run?: { harness?: { version?: string }; model?: { id?: string } } };
  if (["ebo.import-manifest/v1", "ebo.import-manifest/v2"].includes(manifest.schemaVersion ?? "")) return (await import("./atif-v2.js")).readImportedBehaviorEvidenceV2(bundleRoot);
  const evidence = await createRetainedBehaviorEvidence(bundleRoot);
  if (!manifest.run?.harness?.version) throw new Error("Native v2 manifest has no executed harness version.");
  return projectNativeEvidenceV2(evidence, { manifestDigest: `sha256:${digestBytes(bytes).value}`, harnessVersion: manifest.run.harness.version, modelAliases: manifest.run.model?.id ? [manifest.run.model.id] : [] });
}
function implementation(profile: NativeProjectionProfile): Hash {
  return `sha256:${digestMetadata(["native-v2.js", "native-model-aliases-v2.js", "projection-v2.js", "normalization-v2.js", "evidence-pointers.js", profile.module,
    "../../schemas/normalization.v2.json"].map((path) => ({ path, digest: digestBytes(readFileSync(new URL(path, import.meta.url))).value }))).value}`;
}
