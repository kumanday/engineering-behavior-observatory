import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { digestMetadata } from "../src/artifacts.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";
import { createRetainedBehaviorEvidenceV2 } from "../src/native-v2.js";

/** Exercise the production retained reader on the bundle an adapter's synthetic capture just wrote. */
export async function assertNativeV2RetainedBundle(root: string): Promise<void> {
  const manifest = readFileSync(join(root, "manifest.json"));
  const original = await createRetainedBehaviorEvidence(root), digest = digestMetadata(original.dataset).value;
  const projected = await createRetainedBehaviorEvidenceV2(root);
  assert.equal(projected.dataset.schemaVersion, "ebo.normalized-dataset/v2");
  assert.equal(projected.dataset.origin.kind, "owned");
  assert.equal(projected.dataset.origin.qualification, original.capture.qualification);
  assert.equal(projected.dataset.nativeRecords.length, projected.dataset.recordCoverage.length);
  for (const reference of projected.dataset.contentReferences) {
    const resolution = await projected.resolver.resolve(reference.reference);
    assert.ok(resolution && typeof resolution === "object" && resolution.digest === reference.digest);
    const value = projected.resolver.read(reference.reference);
    if (value !== undefined) assert.equal(reference.digest, `sha256:${digestMetadata(value).value}`);
  }
  assert.equal(digestMetadata(original.dataset).value, digest);
  assert.deepEqual(readFileSync(join(root, "manifest.json")), manifest);
}
