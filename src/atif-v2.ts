import { readFileSync } from "node:fs";
import { digestBytes } from "./artifacts.js";
import { readAtifImportAdmission, readImportedBehaviorEvidence } from "./atif-import.js";
import { selectAtifProducerProfile, type AtifProducerFingerprint } from "./atif-profiles.js";
import { readEvidencePointer } from "./evidence-pointers.js";
import { createSourceEvidenceResolverV2, type RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { validateNormalizedDatasetV2, type NormalizedDatasetV2, type UniformEventV2 } from "./normalization-v2.js";
import { normalizePiAtif } from "./atif-pi.js";
import type { AtifReadResult } from "./atif-reader.js";
import { buildOperationsV2, contextFact, digestValue, known, messageFact, object, unreported, type EventProjection } from "./projection-v2.js";

/** Only registered producer semantics enter the typed lane; raw admission remains independently usable. */
export async function projectPiAtifV2(input: {
  read: AtifReadResult; producer: AtifProducerFingerprint; runId: string; attemptId: string;
  manifestDigest: `sha256:${string}`; artifactId?: string;
}): Promise<RetainedBehaviorEvidenceV2> {
  const selection = selectAtifProducerProfile(input.producer);
  if (selection.status !== "supported") throw new Error("ATIF v2 requires a registered producer profile.");
  const evidence = await normalizePiAtif(input), document = input.read.document!;
  const sourceId = `atif:${selection.profile.id}`;
  const resolver = createSourceEvidenceResolverV2(evidence.capture);
  const projections: EventProjection[] = [], events: UniformEventV2[] = [];
  for (const original of evidence.dataset.events) {
    const locator = original.source.nativeReference.recordLocator;
    const stepPointer = /^(.*\/steps\/\d+)(?:\/.*)?$/u.exec(locator)?.[1];
    if (!stepPointer) throw new Error("ATIF v2 event has no admitted source step.");
    const selectedStep = readEvidencePointer(document, stepPointer);
    if (!selectedStep.found) throw new Error("Missing admitted ATIF step.");
    const step = object(selectedStep.value);
    const documentPointer = stepPointer.slice(0, stepPointer.lastIndexOf("/steps/"));
    const scope = `document:${documentPointer}`;
    const selectedRecord = readEvidencePointer(document, locator);
    if (!selectedRecord.found) throw new Error("Missing admitted ATIF record.");
    const record = object(selectedRecord.value);
    const projected: EventProjection = { facts: {}, clock: unreported };
    if (original.family === "message") {
      projected.facts.message = messageFact(step.source === "agent" ? "assistant" : step.source, undefined, "canonical",
        known({ id: stepPointer, scope, identityClass: "converter-assigned" }));
    }
    if (original.family === "context") projected.facts.context = contextFact(original.attributes.contextManagementType === "compaction" ? "compaction" : "summarization");
    if (original.family === "tool") {
      const isCall = original.phase === "before";
      const callId = isCall ? record.tool_call_id : record.source_call_id;
      if (typeof callId !== "string") throw new Error("ATIF v2 tool identity is absent from the admitted record.");
      projected.operation = { nativeId: callId, scope, endpoint: isCall ? "call" : "result", canonical: true,
        toolName: typeof original.attributes.toolName === "string" ? original.attributes.toolName : undefined,
        // The pinned converter can replace missing values with empty arguments and false status.
        ...(isCall && Object.keys(object(record.arguments)).length ? { inputDigest: digestValue(record.arguments) } : {}),
        failure: !isCall && object(record.extra).is_error === true ? known(true) : unreported,
        issuingInference: step.llm_call_count === 1 ? known({ id: stepPointer, scope, identityClass: "declared-single-inference" }) : unreported };
    }
    const { nativeTime: _time, source: _source, ...rest } = structuredClone(original);
    events.push({ ...rest, schemaVersion: "ebo.uniform-event/v2", source: { sourceId, nativeType: original.source.nativeType, nativeReference: original.source.nativeReference },
      clock: projected.clock, facts: projected.facts }); projections.push(projected);
  }
  for (const step of evidence.projection.agentSteps) {
    const selected = readEvidencePointer(document, step.pointer); if (!selected.found) throw new Error("Missing ATIF inference observation.");
    const value = object(selected.value), documentPointer = step.pointer.slice(0, step.pointer.lastIndexOf("/steps/"));
    const facts = { inference: { llmCallCount: step.llmCallCount === null ? unreported : known(step.llmCallCount), nativeRequestId: unreported } };
    events.push({ schemaVersion: "ebo.uniform-event/v2", id: `${step.pointer}/declared-inference`, runId: input.runId, attemptId: input.attemptId,
      source: { sourceId, nativeType: "atif:step", nativeReference: { artifactId: input.artifactId ?? "atif-trajectory", recordLocator: step.pointer } },
      family: "runtime", phase: "instant", nativeOrder: { status: "known", domain: `${input.artifactId ?? "atif-trajectory"}:${documentPointer}`, value: Number(value.step_id) },
      clock: unreported, actor: { kind: "harness" }, scope: { kind: "session", id: `document:${documentPointer}` },
      relations: { parent: unreported, known: [] }, attributes: {}, content: unreported, facts });
    projections.push({ clock: unreported, facts });
  }
  const operations = buildOperationsV2(events, projections);
  const implementationDigest = digestValue(["atif-v2.js", "atif-pi.js", "atif-profiles.js", "projection-v2.js", "normalization-v2.js", "evidence-pointers.js", "../../schemas/normalization.v2.json"]
    .map((path) => ({ path, digest: digestBytes(readFileSync(new URL(path, import.meta.url))).value })));
  const nativeRecords = await Promise.all(evidence.capture.records.map(async ({ reference }) => {
    const resolved = await resolver.resolve(reference); if (!resolved || resolved === true) throw new Error("Unresolved ATIF v2 record.");
    return { reference, nativeType: "atif:retained-record", digest: resolved.digest };
  }));
  const content = new Map<string, NormalizedDatasetV2["contentReferences"][number]>();
  for (const event of events) if (event.content.status === "known") for (const ref of event.content.value) {
    const resolved = await resolver.resolve(ref.nativeReference); if (!resolved || resolved === true) throw new Error("Unresolved ATIF v2 content.");
    content.set(JSON.stringify(ref.nativeReference), { reference: ref.nativeReference, digest: resolved.digest });
  }
  const eventIds = new Map<string, string[]>();
  for (const event of events) { const key = JSON.stringify(event.source.nativeReference); eventIds.set(key, [...eventIds.get(key) ?? [], event.id]); }
  const dataset: NormalizedDatasetV2 = { schemaVersion: "ebo.normalized-dataset/v2", runId: input.runId, attemptId: input.attemptId,
    normalizer: { id: "ebo.pi-atif-v2", version: "2.0.0", implementationDigest },
    origin: { kind: "imported", qualification: "imported", manifestDigest: input.manifestDigest },
    sources: [{ id: sourceId, format: { kind: "atif", version: input.producer.formatVersion },
      reader: { id: "ebo.pi-atif-v2", version: "2.0.0", implementationDigest }, producerProfile: known({ id: selection.profile.id, version: selection.profile.version, digest: selection.profileDigest }),
      executedHarness: { id: "pi", version: input.producer.agent.version === null || input.producer.agent.version === "unknown" ? unreported : known(input.producer.agent.version) }, authority: "third-party" }],
    events, operations, measurements: Object.entries(evidence.mapping.measures).map(([id, measure]) => ({ id: `source-${id}`,
      scope: { kind: "recorded-document", id: "selected-trajectory-including-delegated-children" },
      unit: measure.status === "known" ? measure.unit : id.includes("token") ? "tokens" : "source-declared-units",
      value: id === "tool-error-count" && measure.status === "known" && operations.some(({ failure }) => failure.status !== "known")
        ? measure.value > 0 ? { status: "lower-bound", value: measure.value, reason: "CONVERTER_ZERO_FILL_POSSIBLE" } : { status: "unknown", reason: "CONVERTER_ZERO_FILL_POSSIBLE" }
        : measure.status === "known" ? known(measure.value) : { status: "unknown", reason: measure.reason },
      coverage: id === "tool-error-count" && measure.status === "known" && operations.some(({ failure }) => failure.status !== "known")
        ? measure.value > 0 ? "partial" : "unavailable" : measure.status === "known" ? "exact" : "unavailable", sourceEventIds: events.map(({ id }) => id) })),
    nativeRecords, contentReferences: [...content.values()], recordCoverage: nativeRecords.map(({ reference }) => {
      const ids = eventIds.get(JSON.stringify(reference)) ?? [];
      return { reference, disposition: ids.length ? "mapped" : "retained-only", eventIds: ids,
        reason: ids.length ? unreported : known("RETAINED_ATIF_CONTEXT_OR_METADATA") };
    }) };
  await validateNormalizedDatasetV2(dataset, resolver);
  const { dataset: _dataset, coverage: _coverage, resolver: _resolver, ...retained } = evidence;
  return { ...retained, dataset, resolver };
}

/** Retained imports reopen with the pinned receipt and no Python runtime. */
export async function readImportedBehaviorEvidenceV2(bundleRoot: string): Promise<RetainedBehaviorEvidenceV2> {
  const { manifest, read } = readAtifImportAdmission(bundleRoot);
  const projected = await projectPiAtifV2({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: digestValue(manifest) });
  // The established reader owns the declared and source-derived blinding aliases.
  const original = await readImportedBehaviorEvidence(bundleRoot);
  return { ...projected, modelAliases: original.modelAliases };
}
