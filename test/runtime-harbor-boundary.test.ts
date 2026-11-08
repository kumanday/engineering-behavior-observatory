import assert from "node:assert/strict";
import test from "node:test";
import {runOfficialHarborTrial} from "../src/harbor/official-trial.js";
import {runHarborBackedQueueEntry} from "../src/harbor/runner.js";
import {serveSmolEnvironments} from "../src/harbor/smol.js";
import {runHarborWorker} from "../src/harbor/worker.js";

test("Harbor and Smol execution require the study lock before inspecting execution inputs", async () => {
  await assert.rejects(runOfficialHarborTrial({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(runHarborBackedQueueEntry({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(serveSmolEnvironments("/missing", "/missing"), /RUNTIME_STUDY_LOCK_REQUIRED|ENOENT.*runtimes/);
  await assert.rejects(runHarborWorker({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});
