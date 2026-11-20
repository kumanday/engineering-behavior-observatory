import { availableParallelism } from "node:os";

/** Worker processes for per-attempt work: EBO_WORKERS when set, otherwise one fewer than the machine's cores, at most 16. */
export function validationWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const declared = Number.parseInt(env.EBO_WORKERS ?? "", 10);
  return Number.isSafeInteger(declared) && declared >= 1 ? declared : Math.max(1, Math.min(16, availableParallelism() - 1));
}
