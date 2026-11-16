import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes, digestMetadata } from "../src/artifacts.js";
import { createPointerEvidenceResolver, readEvidencePointer } from "../src/evidence-pointers.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset } from "../src/normalization-integrity.js";
import { UNIFORM_EVENT_FAMILIES, type AdapterCapabilityProfile, type UniformEvent } from "../src/uniform-events.js";

const reference = (recordLocator: string, artifactId = "trajectory") => ({ artifactId, recordLocator });
const document = { steps: [{ tool_calls: [{ arguments: { "a/b": { "~name": "synthetic" } } }] }],
  subagent_trajectories: [{ steps: [{ observation: { results: [{ content: "synthetic result" }] } }] }] };

test("longest retained pointer binds nested call content to its own canonical value", async () => {
  const call = document.steps[0]!.tool_calls[0]!;
  const resolver = createPointerEvidenceResolver({ runId: "run", attemptId: "attempt", records: [
    { reference: reference("#"), record: document }, { reference: reference("#/steps/0/tool_calls/0"), record: call },
  ] });
  const target = reference("#/steps/0/tool_calls/0/arguments/a~1b/~0name");
  const result = resolver.read(target)!;
  assert.equal(result.value, "synthetic");
  assert.equal(result.containingReference.recordLocator, "#/steps/0/tool_calls/0");
  assert.equal(result.containingDigest, `sha256:${digestMetadata(call).value}`);
  assert.equal(result.pointedDigest, `sha256:${digestMetadata("synthetic").value}`);
  assert.notEqual(result.pointedDigest, `sha256:${digestBytes(Buffer.from(JSON.stringify(document, null, 2))).value}`);
  assert.deepEqual(await resolver.resolve(target), { runId: "run", attemptId: "attempt", digest: result.pointedDigest });
});

test("nested subagent result pointers resolve independently and reject siblings and foreign artifacts", async () => {
  const locator = "#/subagent_trajectories/0/steps/0/observation/results/0";
  const resolver = createPointerEvidenceResolver({ runId: "run", attemptId: "attempt", records: [
    { reference: reference(locator), record: { content: "synthetic result" } },
  ] });
  assert.equal(resolver.read(reference(`${locator}/content`))!.value, "synthetic result");
  assert.equal(await resolver.resolve(reference(locator.replace("results/0", "results/00"))), false);
  assert.equal(await resolver.resolve(reference(locator.replace("results/0", "results/01"))), false);
  assert.equal(await resolver.resolve(reference(locator.replace("results/0", "results/1"))), false);
  assert.equal(await resolver.resolve(reference(`${locator}/content`, "other-artifact")), false);
  assert.equal(await resolver.resolve(reference(`${locator}/constructor/prototype`)), false);
  assert.equal(await resolver.resolve(reference(`${locator}/~2`)), false);
});

test("conflicting nested records and duplicate references fail before citation readback", () => {
  assert.throws(() => createPointerEvidenceResolver({ runId: "r", attemptId: "a", records: [
    { reference: reference("#/steps/0"), record: { changed: true } }, { reference: reference("#"), record: document },
  ] }), /conflicts/u);
  assert.throws(() => createPointerEvidenceResolver({ runId: "r", attemptId: "a", records: [
    { reference: reference("#"), record: document }, { reference: reference("#"), record: document },
  ] }), /duplicate/u);
  assert.throws(() => createPointerEvidenceResolver({ runId: "r", attemptId: "a", records: [
    { reference: reference("line:1"), record: document },
  ] }), /JSON-pointer/u);
});

test("pointer reads preserve null and literal percent keys without accessing prototypes or accessors", () => {
  let accessed = false;
  const source = { empty: null, "a%2Fb": 1, get accessor() { accessed = true; return "hidden"; } };
  assert.deepEqual(readEvidencePointer(source, "#/empty"), { found: true, value: null });
  assert.deepEqual(readEvidencePointer(source, "#/a%2Fb"), { found: true, value: 1 });
  assert.deepEqual(readEvidencePointer(source, "#/accessor"), { found: false });
  assert.deepEqual(readEvidencePointer(source, "#/toString"), { found: false });
  assert.equal(accessed, false);
});

test("array holes, inherited indices and accessor indices do not resolve", () => {
  assert.deepEqual(readEvidencePointer(Array(1), "#/0"), { found: false });
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, { 0: "inherited" });
  assert.deepEqual(readEvidencePointer(inherited, "#/0"), { found: false });
  let calls = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { calls += 1; return "computed"; } });
  assert.deepEqual(readEvidencePointer(accessor, "#/0"), { found: false });
  assert.equal(calls, 0);
});

test("retained records reject getters before cloning and do not materialize computed evidence", () => {
  let calls = 0;
  const record = { nested: { get content() { calls += 1; return "computed"; } } };
  assert.throws(() => createPointerEvidenceResolver({ runId: "r", attemptId: "a", records: [{ reference: reference("#"), record }] }), /accessors/u);
  assert.equal(calls, 0);
  const sparse = Array(1);
  assert.throws(() => createPointerEvidenceResolver({ runId: "r", attemptId: "a", records: [{ reference: reference("#"), record: sparse }] }), /dense arrays/u);
});

test("dataset construction and validation share opt-in pointed digests while legacy records keep their hashes", async () => {
  const capture = { runId: "r", attemptId: "a", qualification: "qualified" as const,
    records: [{ reference: reference("#"), record: { text: "synthetic content" } }] };
  const resolver = createPointerEvidenceResolver(capture);
  const capabilityProfile: AdapterCapabilityProfile = {
    schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "pointer-fixture/v1", harness: "pointer-fixture", nativeTypes: ["document"],
    families: { ...Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, { status: "unsupported" }])) as AdapterCapabilityProfile["families"], message: { status: "available" } },
    evidence: { nativeOrder: { status: "available" }, nativeTime: { status: "unsupported" }, parentage: { status: "unsupported" }, content: { status: "available" } },
  };
  const event: UniformEvent = { schemaVersion: "ebo.uniform-event/v1", id: "message", runId: "r", attemptId: "a",
    source: { harness: "pointer-fixture", nativeType: "document", nativeReference: reference("#") },
    nativeOrder: { status: "known", domain: "document", value: 1 }, nativeTime: { status: "unsupported", reason: "No clock" },
    actor: { kind: "user" }, family: "message", phase: "instant", scope: { kind: "attempt", id: "a" },
    relations: { parent: { status: "unsupported", reason: "No parent" }, known: [] }, attributes: {},
    content: { status: "known", value: [{ nativeReference: reference("#/text") }] } };
  const input = { capture, normalization: { events: [event], unmapped: [] }, capabilityProfile,
    adapterVersion: "fixture", nativeType: () => "document", contentDigest: (ref: { artifactId: string; recordLocator: string }) => resolver.read(ref)?.pointedDigest };
  const dataset = describeNormalizedDataset({ ...input, contentDigestPolicy: "canonical-json-pointers/v1" });
  assert.equal(dataset.contentReferences[0]!.digest, `sha256:${digestMetadata("synthetic content").value}`);
  assert.equal((await validateNormalizedDataset(dataset, resolver)).records.mapped, 1);
  const legacy = describeNormalizedDataset(input);
  assert.equal(legacy.contentReferences[0]!.digest, `sha256:${digestMetadata(capture.records[0]!.record).value}`);
  assert.equal((await validateNormalizedDataset(legacy, createCapturedNativeEvidenceResolver(capture))).records.mapped, 1);
  assert.throws(() => describeNormalizedDataset({ ...input, contentDigestPolicy: "canonical-json-pointers/v1", contentDigest: () => undefined }), /trusted digest/u);
});
