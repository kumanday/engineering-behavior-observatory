type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
export type LeaderboardFact = ObjectValue & { id: string; trial: string; task: string; harness: string; harness_version: string | null; run_id: string; benchmark: string;
  reused_from: string | null; reward: number | null; exception: string | null; agent_started: boolean; meter: ObjectValue | null };
/** Structural source validation; classification belongs to the independently pinned upstream policy. */
export function parseLeaderboardFact(value: unknown): LeaderboardFact | undefined {
  const fact = object(value);
  if (!["id", "trial", "task", "harness", "run_id", "benchmark"].every((key) => string(fact[key]))
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(String(fact.id))
      || !(fact.reused_from === null || string(fact.reused_from)) || !(fact.harness_version === null || string(fact.harness_version))
      || !(fact.reward === null || typeof fact.reward === "number" && Number.isFinite(fact.reward))
      || !(fact.exception === null || string(fact.exception)) || typeof fact.agent_started !== "boolean"
      || !(fact.meter === null || typeof fact.meter === "object" && !Array.isArray(fact.meter))) return undefined;
  if (fact.meter !== null) {
    const meter = object(fact.meter);
    if (!Number.isSafeInteger(meter.n_calls) || Number(meter.n_calls) < 0
        || !(meter.last_status === null || Number.isSafeInteger(meter.last_status) && Number(meter.last_status) >= 100 && Number(meter.last_status) <= 599)) return undefined;
  }
  return fact as LeaderboardFact;
}
