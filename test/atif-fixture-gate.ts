import { isDeepStrictEqual } from "node:util";

export type FixtureMeasurement = { status: "known"; value: unknown; unit: string } | { status: "unavailable"; reason: string };
export type FixtureGate = { status: "pass" | "fail"; reason: string };
export type FixtureSignature = { id: string; name: string; failed: boolean | null };

/** Identity remains strict; a missing result status can satisfy only an explicitly declared loss policy. */
export function compareFixtureSignatures(native: readonly FixtureSignature[], imported: readonly FixtureSignature[],
  allowedLossReasons: readonly string[] = []): { gate: FixtureGate; statuses: Array<{ id: string; gate: FixtureGate }> } {
  const keyed = (rows: readonly FixtureSignature[]) => new Map(rows.map((row) => [row.id, row]));
  const a = keyed(native), b = keyed(imported);
  if (a.size !== native.length || b.size !== imported.length || a.size !== b.size
    || native.some((row) => !row.id || b.get(row.id)?.name !== row.name)) {
    return { gate: { status: "fail", reason: "OPERATION_IDENTITY_DIFFERENT" }, statuses: [] };
  }
  const measured = (failed: boolean | null): FixtureMeasurement => failed === null
    ? { status: "unavailable", reason: "TOOL_RESULT_STATUS_INCOMPLETE" } : { status: "known", value: failed, unit: "failure-status" };
  const statuses = native.map((row) => ({ id: row.id,
    gate: compareFixtureMeasurement(measured(row.failed), measured(b.get(row.id)!.failed), { allowedLossReasons }) }));
  return { gate: { status: statuses.some(({ gate }) => gate.status === "fail") ? "fail" : "pass",
    reason: statuses.some(({ gate }) => gate.status === "fail") ? "OPERATION_STATUS_DIFFERENT"
      : statuses.some(({ gate }) => gate.reason === "DECLARED_SOURCE_LOSS") ? "OPERATION_STATUS_DECLARED_LOSS" : "OPERATION_SIGNATURES_EQUAL" }, statuses };
}

/** Gate one fixture/measure. Loss and extra-evidence exceptions must be named explicitly. */
export function compareFixtureMeasurement(native: FixtureMeasurement, imported: FixtureMeasurement,
  policy: { allowedLossReasons?: readonly string[]; extraEvidenceReason?: string } = {}): FixtureGate {
  if (native.status === "known" && imported.status === "known") return isDeepStrictEqual(native, imported)
    ? { status: "pass", reason: "KNOWN_EQUAL" } : { status: "fail", reason: "KNOWN_DIFFERENT" };
  if (native.status === "unavailable" && imported.status === "unavailable") return { status: "pass", reason: "BOTH_UNAVAILABLE" };
  if (native.status === "known" && imported.status === "unavailable") return policy.allowedLossReasons?.includes(imported.reason)
    ? { status: "pass", reason: "DECLARED_SOURCE_LOSS" } : { status: "fail", reason: "UNDECLARED_SOURCE_LOSS" };
  return policy.extraEvidenceReason?.trim()
    ? { status: "pass", reason: "EXPLICIT_EXTRA_EVIDENCE" } : { status: "fail", reason: "UNSUPPORTED_AVAILABILITY_UPGRADE" };
}
