import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalizeMetadata } from "./artifacts.js";
import { validateRetainedBehaviorAssertion, type BehaviorAssertion } from "./behavior-assertions.js";
import { withRetainedEvidenceReuse } from "./retained-evidence.js";
import { createRetainedStructuralObservationSet, type StructuralObservationSet } from "./structural-observations.js";
import { validationWorkers } from "./workers.js";

/** One attempt's derived documents, checked together against its retained evidence. */
export type BundleValidationJob = { bundleRoot: string; observationSets: StructuralObservationSet[]; assertions: BehaviorAssertion[] };

/**
 * Checks one bundle's observation sets (each must equal the set rebuilt from the retained evidence) and card results
 * (each must validate against it). The bundle's evidence is built once for all of them.
 */
export async function validateBundle(job: BundleValidationJob): Promise<void> {
  await withRetainedEvidenceReuse(async () => {
    for (const document of job.observationSets) {
      const rebuilt = await createRetainedStructuralObservationSet(job.bundleRoot);
      if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(document)) throw new Error(`Structural observation set for attempt "${document.attemptId}" is stale.`);
    }
    for (const document of job.assertions) await validateRetainedBehaviorAssertion(job.bundleRoot, document);
  });
}

export { validationWorkers } from "./workers.js";

/** Below this many bundles a worker pool costs more to start than it saves. */
const PARALLEL_BUNDLES = 64;

/**
 * Validates every job, in worker processes when there are many (processes, not threads: workspace checks change the
 * working directory). Each bundle's checks are independent; when any fail, the error is the one the first failing
 * job in input order raises, as a serial pass would report.
 */
export async function validateBundles(jobs: readonly BundleValidationJob[], workers = validationWorkers(), minimum = PARALLEL_BUNDLES): Promise<void> {
  if (workers <= 1 || jobs.length < minimum) {
    for (const job of jobs) await validateBundle(job);
    return;
  }
  const failures = new Map<number, string>();
  let next = 0;
  const script = fileURLToPath(new URL("./bundle-validation-worker.js", import.meta.url));
  const pool: ChildProcess[] = Array.from({ length: Math.min(workers, jobs.length) }, () => fork(script, [], { stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced" }));
  try {
    await Promise.all(pool.map((worker) => new Promise<void>((accept, reject) => {
      const send = () => {
        // Once a job has failed, later jobs cannot change the reported error; stop handing them out.
        if (next >= jobs.length || (failures.size && Math.min(...failures.keys()) < next)) { accept(); return; }
        const index = next++;
        worker.once("message", (reply: { index: number; error?: string }) => {
          if (reply.error !== undefined) failures.set(reply.index, reply.error);
          send();
        });
        worker.send({ index, job: jobs[index] });
      };
      worker.once("error", reject);
      worker.once("exit", (code) => { if (next <= jobs.length && code !== 0 && code !== null) reject(new Error(`A validation worker exited with ${String(code)}.`)); });
      send();
    })));
  } finally {
    for (const worker of pool) worker.kill();
  }
  if (failures.size) throw new Error(failures.get(Math.min(...failures.keys()))!);
}
