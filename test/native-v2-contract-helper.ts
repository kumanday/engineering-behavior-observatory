import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datasetV2Digest } from "../src/normalization-v2.js";
import { digestBytes, digestMetadata } from "../src/artifacts.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";
import { createRetainedBehaviorEvidenceV2 } from "../src/native-v2.js";

/** Exercise the production retained reader on the bundle an adapter's synthetic capture just wrote. */
export async function assertNativeV2RetainedBundle(root: string): Promise<void> {
  const manifest = readFileSync(join(root, "manifest.json"));
  const original = await createRetainedBehaviorEvidence(root), digest = digestMetadata(original.dataset).value;
  const projected = await createRetainedBehaviorEvidenceV2(root);
  assert.equal(datasetV2Digest(projected.dataset), datasetV2Digest(JSON.parse(JSON.stringify(projected.dataset))), "v2 derivations are durable JSON values");
  assert.equal(projected.dataset.schemaVersion, "ebo.normalized-dataset/v2");
  assert.equal(projected.dataset.origin.kind, "owned");
  assert.ok(projected.modelAliases?.length, "retained v2 readers preserve the manifest model identity");
  assert.equal(projected.dataset.origin.qualification, original.capture.qualification);
  if (original.dataset.adapter.harness === "factory-droid") {
    const prompt = projected.dataset.events.find(({ facts }) => facts.message?.role.status === "known" && facts.message.role.value === "user")!;
    assert.ok(prompt, "retained Factory captures include the owned prompt");
    const source = original.dataset.events.find(({ id }) => id === prompt.id)!;
    assert.equal(source.scope.kind, "session");
    assert.equal(prompt.facts.message!.identity.status, "known");
    if (source.scope.kind === "session" && prompt.facts.message!.identity.status === "known") assert.equal(prompt.facts.message!.identity.value.scope, `session:${source.scope.id}`);
  }
  assert.equal(projected.dataset.nativeRecords.length, projected.dataset.recordCoverage.length);
  for (const reference of projected.dataset.contentReferences) {
    const resolution = await projected.resolver.resolve(reference.reference);
    assert.ok(resolution && typeof resolution === "object" && resolution.digest === reference.digest);
    const value = projected.resolver.read(reference.reference);
    if (value !== undefined) assert.equal(reference.digest, `sha256:${digestMetadata(value).value}`);
  }
  assert.equal(digestMetadata(original.dataset).value, digest);
  assert.deepEqual(readFileSync(join(root, "manifest.json")), manifest);
  await assertUnfamiliarRuntimeReadback(root, original.dataset.events.length);

}

/** Same valid captured format with a consistent unfamiliar runtime declaration, independent of installed runtimes. */
async function assertUnfamiliarRuntimeReadback(root: string, eventCount: number): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-retained-version-"));
  try {
    const copy = join(temporary, "bundle"); cpSync(root, copy, { recursive: true });
    const path = join(copy, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
    const old = manifest.run.harness.version as string, replacement = "9000.1.0";
    const change = (text: string) => text.replaceAll(old, replacement);
    for (const artifact of manifest.evidence) {
      // Drift changes native observations and declarations. Frozen runtime
      // provenance keeps its independent bytes and internal digests.
      if (!/json/u.test(artifact.mediaType) || artifact.source === "ebo-runtime") continue;
      const target = join(copy, artifact.relativePath), bytes = Buffer.from(change(readFileSync(target, "utf8")));
      writeFileSync(target, bytes); artifact.digest = `sha256:${digestBytes(bytes).value}`; artifact.sizeBytes = bytes.length;
    }
    // Changing source bytes intentionally requires fresh artifact digests; capture identities and native shapes stay intact.
    const changed = JSON.parse(change(JSON.stringify(manifest)));
    writeFileSync(path, JSON.stringify(changed));
    const evidence = await createRetainedBehaviorEvidence(copy);
    assert.equal(evidence.dataset.events.length, eventCount, `${manifest.run.harness.id}: unfamiliar versions preserve normalized events`);
    assert.ok(evidence.verification?.limitations.includes("HARNESS_VERSION_UNVERIFIED"), manifest.run.harness.id);
    const projected = await createRetainedBehaviorEvidenceV2(copy);
    assert.ok(projected.dataset.sources[0]!.limitations?.includes("HARNESS_VERSION_UNVERIFIED"));
    assert.ok(projected.dataset.events.length > 0);
    changed.run.harness.version = "9000.2.0"; writeFileSync(path, JSON.stringify(changed));
    const disagreement = await createRetainedBehaviorEvidence(copy);
    assert.equal(disagreement.dataset.events.length, eventCount, "version disagreement is evidence metadata, not a format failure");
    assert.ok(disagreement.verification?.limitations.includes("HARNESS_VERSION_UNVERIFIED"));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
