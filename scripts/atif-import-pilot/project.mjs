/** Offline projection experiment. It does not create a run manifest or admit imports. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { digestMetadata, assertNoDuplicateJsonKeys } from "../../dist/src/artifacts.js";
import { validateNormalizedDataset } from "../../dist/src/normalization-integrity.js";
import { UNIFORM_EVENT_FAMILIES } from "../../dist/src/uniform-events.js";
import { createStructuralObservationSet, createRetainedStructuralObservationSet, toolOperations } from "../../dist/src/structural-observations.js";
import { deriveUnits } from "../../dist/src/atlas-units.js";
import { extractOccurrences } from "../../dist/src/occurrences.js";
import { redactSecrets } from "../../dist/src/redaction.js";
import { createRetainedBehaviorEvidence } from "../../dist/src/retained-evidence.js";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (value) => `sha256:${digestMetadata(value).value}`;
const unavailable = (reason) => ({ status: "unknown", reason });
const available = { status: "available" };

export function pointerValue(document, locator) {
  if (!locator.startsWith("#")) return undefined;
  let current = document;
  for (const part of locator.slice(1).split("/").slice(1)) {
    const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export async function projectPi(document, attemptId = "pilot-attempt") {
  const runId = "atif-pilot";
  const harness = "atif:harbor/pi";
  const artifactId = "retained-atif";
  const records = new Map();
  const contents = new Map();
  const events = [];
  const unsupported = { status: "unsupported", reason: "Not established by this pilot profile." };
  const nativeReference = (recordLocator) => ({ artifactId, recordLocator });
  function content(locator, role) {
    const reference = nativeReference(locator);
    contents.set(locator, { reference, digest: digest(pointerValue(document, locator)) });
    return { nativeReference: reference, role };
  }
  function event(step, index, suffix, family, phase, attributes, refs = [], actor = "harness", operation) {
    const locator = index === null ? "#" : `#/steps/${index}`;
    const record = index === null ? document : step;
    const type = index === null ? "atif:root" : `atif:${step.source}`;
    records.set(locator, { reference: nativeReference(locator), nativeType: type, digest: digest(record) });
    events.push({ schemaVersion: "ebo.uniform-event/v1", id: `${index ?? "root"}-${suffix}`, runId, attemptId,
      source: { harness, nativeType: type, nativeReference: nativeReference(locator) },
      nativeOrder: index === null ? unsupported : { status: "known", value: step.step_id, domain: "atif:root-document" },
      // A step's timestamp is not a tool-start or tool-result timestamp.
      nativeTime: unavailable("PER_OPERATION_CLOCK_NOT_RECORDED"), actor: { kind: actor }, family, phase,
      scope: operation ? { kind: "operation", id: operation } : { kind: "session", id: "root-document" },
      relations: { parent: unsupported, known: [] }, attributes,
      content: { status: "known", value: refs } });
  }
  for (const [index, step] of document.steps.entries()) {
    if (step.is_copied_context || step.extra?.added_by === "hlb") continue;
    const base = `#/steps/${index}`;
    if (typeof step.message === "string" && step.message.length) {
      event(step, index, "message", "message", "after", { role: step.source === "agent" ? "assistant" : step.source },
        [content(`${base}/message`, "message")], step.source === "agent" ? "agent" : step.source === "user" ? "user" : "system");
    }
    for (const [position, call] of (step.tool_calls ?? []).entries()) {
      event(step, index, `call-${position}`, "tool", "before", { toolCallId: call.tool_call_id, toolName: call.function_name,
        inputDigest: digest(call.arguments), sessionId: "root-document" },
      [content(`${base}/tool_calls/${position}/arguments`, "tool-input")], "agent", call.tool_call_id);
    }
    for (const [position, result] of (step.observation?.results ?? []).entries()) {
      if (!result.source_call_id) continue;
      const call = (step.tool_calls ?? []).find((candidate) => candidate.tool_call_id === result.source_call_id);
      if (!call) continue;
      event(step, index, `result-${position}`, "tool", "after", { toolCallId: result.source_call_id, toolName: call.function_name,
        sessionId: "root-document", ...(typeof result.extra?.is_error === "boolean" ? { isError: result.extra.is_error } : {}) },
      result.content === undefined ? [] : [content(`${base}/observation/results/${position}/content`, "tool-result")], "tool", result.source_call_id);
    }
  }
  const metrics = document.final_metrics;
  if (metrics && typeof metrics.total_prompt_tokens === "number" && typeof metrics.total_cached_tokens === "number") {
    const cacheWrite = metrics.extra?.cache_write_tokens;
    const nativeTotal = metrics.extra?.pi_total_tokens;
    const hasWrites = typeof cacheWrite === "number";
    const attrs = { resourceSemantics: "cumulative-final", promptIncludesCacheRead: true, promptIncludesCacheWrite: true,
      ...(hasWrites ? { inputTokens: metrics.total_prompt_tokens - metrics.total_cached_tokens - cacheWrite, cacheCreationInputTokens: cacheWrite } : {}),
      cacheReadInputTokens: metrics.total_cached_tokens,
      ...(typeof metrics.total_completion_tokens === "number" ? { outputTokens: metrics.total_completion_tokens } : {}),
      ...(typeof nativeTotal === "number" ? { totalTokens: nativeTotal } : {}) };
    event(null, null, "usage", "runtime", "instant", attrs, [content("#/final_metrics", "usage")]);
  }
  // Retain every unprojected source step explicitly, including copied/gap records.
  for (const [index, step] of document.steps.entries()) {
    const locator = `#/steps/${index}`;
    if (!records.has(locator)) records.set(locator, { reference: nativeReference(locator), nativeType: `atif:${step.source}`, digest: digest(step) });
  }
  const used = new Set(events.map((value) => value.source.nativeReference.recordLocator));
  const profile = { schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "atif-pi-pilot", harness,
    nativeTypes: [...new Set([...records.values()].map((value) => value.nativeType))],
    families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family,
      ["message", "tool"].includes(family) ? available : family === "runtime" ? { status: "partial", detail: "Only producer-declared final usage is projected." } : { status: "unsupported" }])),
    evidence: { nativeOrder: { status: "partial" }, nativeTime: { status: "partial" }, parentage: { status: "unsupported" }, content: available } };
  const dataset = { schemaVersion: "ebo.normalized-dataset/v1", runId, attemptId,
    adapter: { id: profile.adapterId, version: "pilot-1", harness }, capabilityProfile: profile,
    nativeRecords: [...records.values()], contentReferences: [...contents.values()], events,
    unmapped: [...records.entries()].filter(([locator]) => !used.has(locator)).map(([, value]) => ({ reference: value.reference, reason: "RETAINED_WITHOUT_ANALYTICAL_PROJECTION" })) };
  const resolver = { resolve(reference) {
    const value = pointerValue(document, reference.recordLocator);
    return reference.artifactId !== artifactId || value === undefined ? false : { runId, attemptId, digest: digest(value) };
  } };
  const coverage = await validateNormalizedDataset(dataset, resolver);
  const observations = createStructuralObservationSet(dataset, coverage);
  const units = deriveUnits({ attemptId, events, occurrences: [], resolveContent: (reference) => pointerValue(document, reference.recordLocator) });
  return { dataset, observations, units, coverage };
}

export function orderingProbe() {
  const make = (id, order, time, phase, error = false) => ({ schemaVersion: "ebo.uniform-event/v1", id, runId: "r", attemptId: "a",
    source: { harness: "probe", nativeType: "tool", nativeReference: { artifactId: "probe", recordLocator: id } },
    nativeOrder: { status: "known", value: order, domain: "session" }, nativeTime: time ? { status: "known", value: time } : unavailable("no timestamp"),
    actor: { kind: "tool" }, family: "tool", phase, scope: { kind: "session", id: "s" }, relations: { parent: unavailable("unknown"), known: [] },
    attributes: { toolName: "bash", ...(error ? { isError: true } : {}) }, content: { status: "known", value: [] } });
  const first = [make("call-a", 1, "2026-11-07T00:00:01Z", "before"), make("result-a", 2, null, "after", true)];
  const next = [make("call-b", 3, "2026-11-07T00:00:03Z", "before"), make("result-b", 4, "2026-11-07T00:00:04Z", "after")];
  const result = extractOccurrences({ attemptId: "a", events: [...first, ...next],
    operations: [{ id: "a", events: first, toolName: "bash", failed: true }, { id: "b", events: next, toolName: "bash", failed: false }],
    toolCapability: available, delegationCapability: { status: "unsupported" }, isCompaction: () => false });
  const response = result.occurrences.find((value) => value.type === "failure-response");
  return { expectedResponseEventId: "call-b", observedResponseEventId: response?.attributes.responseEventId ?? null,
    defectReproduced: response?.attributes.responseEventId !== "call-b", ruleVersion: response?.rule.version };
}

async function main(sample) {
  const inspection = read(join(sample, "inspection.json"));
  const acquisition = read(join(sample, "acquisition.json"));
  const findings = { productionEligible: false, reason: "PILOT_ONLY_IMPORT_ADMISSION_NOT_IMPLEMENTED", projections: {}, pairs: [],
    orderingProbe: orderingProbe(), secretScan: { artifactsScanned: 0, findings: 0 }, modelCalls: 0 };
  for (const artifact of acquisition.artifacts) {
    const source = readFileSync(join(sample, artifact.localPath), "utf8");
    findings.secretScan.findings += redactSecrets(source).redacted;
    findings.secretScan.artifactsScanned += 1;
  }
  const candidates = [{ key: "public-pi", path: join(sample, "sources/pi/agent/trajectory.json") },
    ...inspection.pairs.map((pair, index) => ({ key: `paired-${index}`, path: join(sample, `paired/pair-${index}/a/trajectory.json`), pair }))];
  for (const candidate of candidates) {
    const text = readFileSync(candidate.path, "utf8");
    assertNoDuplicateJsonKeys(text);
    const document = JSON.parse(text);
    const projected = await projectPi(document, candidate.key);
    const measures = Object.fromEntries(projected.observations.observations.map((value) => [value.extractor.id, value.value]));
    findings.projections[candidate.key] = { schemaValidation: "pass", eventCount: projected.dataset.events.length,
      sourceRecordCount: projected.dataset.nativeRecords.length, atlasUnitCount: projected.units.units.length,
      recordedToolOperations: toolOperations(projected.dataset.events).length,
      sourceDeclaredInputTokens: measures["input-token-count"], sourceDeclaredOutputTokens: measures["output-token-count"],
      declaredInferenceCount: document.steps.filter((step) => step.source === "agent" && !step.is_copied_context).reduce((sum, step) => sum + (step.llm_call_count ?? 0), 0),
      sourceNativeRequestCount: "unavailable: no native request identities synthesized",
      fullAttemptMeasuresEligible: false };
    if (candidate.pair) {
      try {
        const native = await createRetainedStructuralObservationSet(candidate.pair.bundleRoot);
        const nativeEvidence = await createRetainedBehaviorEvidence(candidate.pair.bundleRoot);
        const nativeMeasures = Object.fromEntries(native.observations.map((value) => [value.extractor.id, value.value]));
        const comparisons = ["tool-operation-count", "tool-error-count", "input-token-count", "output-token-count", "cache-read-input-token-count"].map((measure) => ({ measure,
          native: nativeMeasures[measure], atif: measures[measure], pass: JSON.stringify(nativeMeasures[measure]) === JSON.stringify(measures[measure]) }));
        const signature = (operation) => ({ id: operation.events.map((event) => event.attributes.toolCallId ?? event.attributes.toolUseId).find((value) => typeof value === "string")
            ?? operation.events.find((event) => event.scope.kind === "operation")?.scope.id,
          name: operation.toolName, failed: operation.failed });
        const signatures = (events) => toolOperations(events).map(signature).sort((left, right) => String(left.id).localeCompare(String(right.id)));
        const operationSignatureAgreement = JSON.stringify(signatures(nativeEvidence.dataset.events)) === JSON.stringify(signatures(projected.dataset.events));
        findings.pairs.push({ key: candidate.key, nativeLoad: "pass", comparisons, operationSignatureAgreement,
          nativeRequestCount: nativeMeasures["model-request-count"], declaredInferenceCount: findings.projections[candidate.key].declaredInferenceCount });
      } catch (error) {
        findings.pairs.push({ key: candidate.key, nativeLoad: "rejected", reason: String(error.message).slice(0, 400),
          importMustNotUpgradeQualification: true });
      }
    }
    const output = join(sample, "projection", candidate.key);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "dataset.json"), JSON.stringify(projected.dataset, null, 2) + "\n");
  }
  writeFileSync(join(sample, "projection-results.json"), JSON.stringify(findings, null, 2) + "\n");
  console.log(JSON.stringify({ projections: Object.keys(findings.projections), pairs: findings.pairs.map(({ key, nativeLoad, comparisons }) => ({ key, nativeLoad, matched: comparisons?.filter((value) => value.pass).length, tested: comparisons?.length })), orderingProbe: findings.orderingProbe, secretScan: findings.secretScan }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(resolve(process.argv[2]));
