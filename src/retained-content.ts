import { createPointerEvidenceResolver } from "./evidence-pointers.js";
import type { RetainedBehaviorEvidence } from "./retained-evidence.js";
import type { NativeEvidenceReference } from "./uniform-events.js";

/** Native content for one reference: the record (Agent SDK: its document), then the locator's JSON pointer. */
export function retainedContentResolver(evidence: RetainedBehaviorEvidence) {
  if (evidence.capture.qualification === "imported") {
    const pointer = createPointerEvidenceResolver(evidence.capture);
    return (reference: NativeEvidenceReference): { status: "resolved"; value: unknown } | { status: "missing-record" } => {
      const result = pointer.read(reference);
      return result === undefined ? { status: "missing-record" } : { status: "resolved", value: result.value };
    };
  }
  const agentSdk = evidence.dataset.adapter.harness === "claude-agent-sdk";
  const records = new Map(evidence.capture.records.map(({ reference, record }) =>
    [`${reference.artifactId}\0${reference.recordLocator}`, agentSdk ? (record as { document: unknown }).document : record]));
  return (reference: NativeEvidenceReference): { status: "resolved"; value: unknown } | { status: "missing-record" | "bad-pointer" } => {
    const marker = reference.recordLocator.indexOf("#");
    const base = marker === -1 ? reference.recordLocator : reference.recordLocator.slice(0, marker);
    const key = `${reference.artifactId}\0${base === "" ? "#" : base}`;
    if (!records.has(key)) return { status: "missing-record" };
    const tokens = (marker === -1 ? "" : reference.recordLocator.slice(marker + 1)).split("/").slice(1).map((t) => t.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    const value = ownPointer(records.get(key), tokens);
    return value === undefined ? { status: "bad-pointer" } : { status: "resolved", value };
  };
}

/** A JSON pointer over own properties only: a segment such as __proto__ never reaches an inherited object. */
export function ownPointer(value: unknown, tokens: readonly string[]): unknown {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens;
  return value !== null && typeof value === "object" && Object.hasOwn(value, token!) ? ownPointer((value as Record<string, unknown>)[token!], rest) : undefined;
}
