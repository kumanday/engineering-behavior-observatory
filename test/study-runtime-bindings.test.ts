import assert from "node:assert/strict";
import test from "node:test";
import {readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {bundleFixture} from "./scheduler-fixture-helper.js";
import {compileRunQueue, readRunQueue, writeRunQueue} from "../src/scheduler.js";
import {assertQueueRuntimeBinding, bindStudyRuntimeQueue, queueRunId} from "../src/study-runtime-bindings.js";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {runRuntimeCommandLine} from "../src/runtime-cli.js";
import {fakeSdkRuntimeOptions} from "./runtime-fixture-helper.js";

test("a versioned study freeze and queue bind the runtime lock while legacy queue bytes stay readable", async () => {
  const {root, experiment} = bundleFixture(), options = fakeSdkRuntimeOptions("9.9.9");
  try {
    experiment.harnessSet = {"cursor-sdk": experiment.harnessSet["harness-a"]!};
    const queue = compileRunQueue(experiment, {bundleRoot: root, freezeLocators: {"task-a": "freezes/task-a.json"}}), source = join(root, "queue-v1.json"), destination = join(root, "queue-v3.json");
    writeRunQueue(source, queue);
    const before = await readFile(source);
    const lock = await freezeStudyRuntimes(root, {studyId: "bound-study", roles: ["cursor-sdk"]}, options), output: string[] = [];
    assert.equal(await runRuntimeCommandLine(["bind-queue", root, source, destination], (text) => output.push(text), options), 0, output.join(""));
    const document = JSON.parse(await readFile(destination, "utf8"));
    assert.equal(document.schemaVersion, "ebo.run-queue/v3");
    assert.equal(document.studyFreeze.schemaVersion, "ebo.study-freeze/v1");
    assert.equal(document.studyFreeze.runtimeLockDigest, lock.digest);
    assert.deepEqual(readRunQueue(destination, undefined, {bundleRoot: root}), queue);
    assert.deepEqual(readRunQueue(source, undefined, {bundleRoot: root}), queue);
    assert.deepEqual(await readFile(source), before);
    const again = join(root, "queue-v3-again.json");
    assert.equal(await runRuntimeCommandLine(["bind-queue", root, source, again], () => {}, options), 0);
    assert.deepEqual(JSON.parse(await readFile(again, "utf8")), document);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("retained bound queues read in another study while execution rejects a different lock", async () => {
  const {runCursorSdkQueueEntry} = await import("../src/cursor-sdk-runner.js");
  const {withStudyRuntime} = await import("../src/runtime-context.js");
  const {root, experiment} = bundleFixture(), options = fakeSdkRuntimeOptions("9.9.9");
  try {
    experiment.harnessSet = {"cursor-sdk": experiment.harnessSet["harness-a"]!};
    const queue = compileRunQueue(experiment, {bundleRoot: root, freezeLocators: {"task-a": "freezes/task-a.json"}}), source = join(root, "queue.json"), destination = join(root, "bound.json");
    writeRunQueue(source, queue);
    await freezeStudyRuntimes(root, {studyId: "first-study", roles: ["cursor-sdk"]}, options);
    assert.equal(await runRuntimeCommandLine(["bind-queue", root, source, destination], () => {}, options), 0);
    const other = join(root, "other-study"), otherOptions = fakeSdkRuntimeOptions("9.9.8");
    await freezeStudyRuntimes(other, {studyId: "other-study", roles: ["cursor-sdk"]}, otherOptions);
    const first = readRunQueue(destination, undefined, {bundleRoot: root}), second = await bindStudyRuntimeQueue(other, queue);
    assert.notEqual(queueRunId(first, queue.entries[0]!.runId), queueRunId(second.queue, queue.entries[0]!.runId));
    await withStudyRuntime({studyRoot: other, role: "cursor-sdk", options: otherOptions}, async () => {
      assert.deepEqual(readRunQueue(destination, undefined, {bundleRoot: root}), queue);
      await assert.rejects(runCursorSdkQueueEntry({bundleRoot: root, queuePath: destination, runId: queue.entries[0]!.runId, outputRoot: join(root, "runs")}), /RUNTIME_QUEUE_LOCK_MISMATCH/);
    });
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a bound queue rejects content or freeze changes before returning executable entries", async () => {
  const {writeFile} = await import("node:fs/promises");
  const {root, experiment} = bundleFixture(), options = fakeSdkRuntimeOptions("9.9.9");
  try {
    experiment.harnessSet = {"cursor-sdk": experiment.harnessSet["harness-a"]!};
    const queue = compileRunQueue(experiment, {bundleRoot: root, freezeLocators: {"task-a": "freezes/task-a.json"}}), source = join(root, "queue.json"), destination = join(root, "bound.json");
    writeRunQueue(source, queue); await freezeStudyRuntimes(root, {studyId: "integrity-study", roles: ["cursor-sdk"]}, options);
    assert.equal(await runRuntimeCommandLine(["bind-queue", root, source, destination], () => {}, options), 0);
    const original = JSON.parse(await readFile(destination, "utf8"));
    for (const target of ["queue", "freeze"] as const) {
      const changed = structuredClone(original);
      if (target === "queue") changed.queue.seed = "different"; else changed.studyFreeze.runtimeLockDigest = `sha256:${"a".repeat(64)}`;
      await writeFile(destination, JSON.stringify(changed));
      assert.throws(() => readRunQueue(destination, undefined, {bundleRoot: root}), /RUNTIME_QUEUE_INTEGRITY/);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test("binding one source object to two studies leaves each returned binding independent", async () => {
  const {root, experiment} = bundleFixture(), options = fakeSdkRuntimeOptions("9.9.9");
  try {
    experiment.harnessSet = {"cursor-sdk": experiment.harnessSet["harness-a"]!};
    const queue = compileRunQueue(experiment, {bundleRoot: root, freezeLocators: {"task-a": "freezes/task-a.json"}});
    const first = await freezeStudyRuntimes(root, {studyId: "first", roles: ["cursor-sdk"]}, options);
    const boundA = await bindStudyRuntimeQueue(root, queue), runA = queueRunId(boundA.queue, queue.entries[0]!.runId);
    const other = join(root, "second");
    await freezeStudyRuntimes(other, {studyId: "second", roles: ["cursor-sdk"]}, options);
    const boundB = await bindStudyRuntimeQueue(other, queue);
    assert.equal(queueRunId(boundA.queue, queue.entries[0]!.runId), runA);
    assert.doesNotThrow(() => assertQueueRuntimeBinding(boundA.queue, first.digest));
    assert.notEqual(queueRunId(boundB.queue, queue.entries[0]!.runId), runA);
    assert.equal(queueRunId(queue, queue.entries[0]!.runId), queue.entries[0]!.runId);
  } finally {await rm(root, {recursive: true, force: true});}
});
