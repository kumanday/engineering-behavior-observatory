import assert from "node:assert/strict";
import test from "node:test";
import { validateArtifact } from "../src/artifacts.js";

/** Names and numbers that EBO 2.0 no longer reads: earlier shapes and names given to a different kind of document. */
const RETIRED = [
  "ebo.behavior-assertion/v1", "ebo.semantic-judge-request/v1", "ebo.semantic-judge-input/v1", "ebo.semantic-judgment/v3",
  "ebo.judge-prepare-spec/v1", "ebo.aggregation-report/v1", "ebo.review-sample-criteria/v1", "ebo.review-sample/v1",
  "ebo.review-packet/v1", "ebo.calibration-summary/v1", "ebo.atlas-view/v1", "ebo.atlas-bundle/v1", "ebo.atlas-bundle-request/v1",
  "ebo.import-manifest/v1", "ebo.study-runtime-lock/v1", "ebo.runtime-launch/v1", "run-manifest/v1",
  "ebo.experiment/v1", "ebo.experiment/v2", "ebo.run-queue/v1", "ebo.run-queue/v2", "ebo.run-queue/v3",
  "ebo.normalized-dataset/v2", "ebo.uniform-event/v2",
  "ebo.semantic-judge-answer/v2", "ebo.semantic-judgment/v2", "ebo.occurrence/v2", "ebo.occurrence-ledger/v2",
  "ebo.occurrence-rating-input/v2", "ebo.occurrence-rating/v2", "ebo.structural-observation/v2", "ebo.structural-observation-set/v2",
];

test("a file with a retired format name or number fails as an unsupported version", () => {
  for (const schemaVersion of RETIRED) {
    assert.deepEqual(validateArtifact("retired", { schemaVersion }).map(({ field, message }) => [field, message]),
      [["/schemaVersion", "Unsupported schema version."]], schemaVersion);
  }
});
