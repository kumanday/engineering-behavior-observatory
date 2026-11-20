import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAtifImportSchema, readAtifImportAdmission } from "./atif-import.js";
import { messageRole } from "./event-aliases.js";
import { isSecretFieldName, redactSecrets } from "./redaction.js";
import { retainedContentResolver } from "./retained-content.js";
import { createRetainedBehaviorEvidence, type RetainedBehaviorEvidence } from "./retained-evidence.js";
import { toolOperations } from "./structural-observations.js";
import type { UniformEvent } from "./uniform-events.js";

/**
 * The step excerpt a decision model reads: every recorded step of one attempt, each field cut to a length that keeps
 * the whole trace near a fixed character budget. Steps are never dropped; long fields keep their start and end around
 * an `[excerpt gap]` marker. Secrets, home directories and the evaluated model's names are removed before cutting.
 */
export const STEP_EXCERPT_VERSION = "1.0.0";
export const STEP_EXCERPT_BUDGET_CHARS = 37_000;
const MIN_FIELD_CHARS = 30, MAX_FIELD_CHARS = 430, EDGE_FIELD_CHARS = 3600, FALLBACK_FIELD_CHARS = 320, MAX_TRACE_CHARS = 380_000;
const LEADING_STEPS = 10, TRAILING_STEPS = 5, TOOL_NAME_CHARS = 110;
const GAP = " [excerpt gap] ";
const MODEL_PLACEHOLDER = "[evaluated-model]";

export type StepExcerptRow = {
  id: string;
  role: string;
  copied: boolean;
  message: string;
  calls: Array<{ id: string; tool: string; arguments: string }>;
  results: Array<{ id: string; call: string | null; content: string }>;
};
export type StepExcerpt = {
  /** The state sent to the decision model. */
  trace: { recordedSteps: number; excerpted: true; rows: StepExcerptRow[] };
  /** `-atif` renders an ATIF import's own steps; `-events` renders a native capture's messages and tool operations. */
  rendering: { id: "ebo-step-excerpt-atif" | "ebo-step-excerpt-events"; version: string };
  fieldChars: { min: number; max: number };
  budgetChars: number;
};

type Step = { role: string; copied: boolean; message: unknown; calls: Array<{ key?: string; tool: unknown; arguments: unknown }>; results: Array<{ call?: string; content: unknown }> };

/** Render one retained bundle (a native capture or an ATIF import) as a step excerpt. */
export async function renderStepExcerpt(bundleRoot: string, evidence?: RetainedBehaviorEvidence): Promise<StepExcerpt> {
  const retained = evidence ?? await createRetainedBehaviorEvidence(bundleRoot);
  const manifest = JSON.parse(readFileSync(join(bundleRoot, "manifest.json"), "utf8")) as { schemaVersion?: unknown; run?: { model?: { id?: unknown } } };
  const imported = isAtifImportSchema(manifest.schemaVersion);
  const aliases = [...new Set([...(imported ? [] : [manifest.run?.model?.id]), ...retained.modelAliases ?? []]
    .filter((value): value is string => typeof value === "string" && value.trim() !== ""))];
  const steps = imported ? atifSteps(readAtifImportAdmission(bundleRoot).read.document) : eventSteps(retained);
  return excerpt(steps, aliases, imported ? "ebo-step-excerpt-atif" : "ebo-step-excerpt-events");
}

/** Cut every field of every step to the per-field limit, the first and last steps with a wider one. */
export function excerpt(steps: readonly Step[], aliases: readonly string[], renderingId: StepExcerpt["rendering"]["id"]): StepExcerpt {
  const blind = aliasPattern(aliases);
  const limit = Math.min(MAX_FIELD_CHARS, Math.max(MIN_FIELD_CHARS, Math.floor(STEP_EXCERPT_BUDGET_CHARS / Math.max(1, steps.length * 3))));
  const edge = Math.min(EDGE_FIELD_CHARS, limit * 3);
  const isEdge = (index: number) => index < LEADING_STEPS || index >= steps.length - TRAILING_STEPS;
  let rows = renderRows(steps, (index) => (isEdge(index) ? edge : limit), blind);
  let used = steps.map((_, index) => (isEdge(index) ? edge : limit));
  if (JSON.stringify(rows).length > MAX_TRACE_CHARS) {
    const narrow = Math.min(FALLBACK_FIELD_CHARS, limit);
    rows = renderRows(steps, () => narrow, blind);
    used = steps.map(() => narrow);
  }
  return {
    trace: { recordedSteps: steps.length, excerpted: true, rows },
    rendering: { id: renderingId, version: STEP_EXCERPT_VERSION },
    fieldChars: used.length ? { min: Math.min(...used), max: Math.max(...used) } : { min: limit, max: limit },
    budgetChars: STEP_EXCERPT_BUDGET_CHARS,
  };
}

function renderRows(steps: readonly Step[], limitOf: (index: number) => number, blind: RegExp | undefined): StepExcerptRow[] {
  const callAnchors = new Map<string, string | null>();
  steps.forEach((step, i) => step.calls.forEach((call, j) => {
    if (call.key !== undefined) callAnchors.set(call.key, callAnchors.has(call.key) ? null : `s${i + 1}c${j + 1}`);
  }));
  return steps.map((step, i) => {
    const anchor = `s${i + 1}`, limit = limitOf(i);
    return {
      id: anchor, role: step.role, copied: step.copied, message: safe(step.message, limit, blind),
      calls: step.calls.map((call, j) => ({ id: `${anchor}c${j + 1}`, tool: safe(call.tool, TOOL_NAME_CHARS, blind), arguments: safe(call.arguments, limit, blind) })),
      results: step.results.map((result, j) => ({ id: `${anchor}r${j + 1}`, call: result.call === undefined ? null : callAnchors.get(result.call) ?? null, content: safe(result.content, limit, blind) })),
    };
  });
}

/** Redacted, blinded text of a value, cut to `limit` characters around a gap marker. */
function safe(value: unknown, limit: number, blind: RegExp | undefined): string {
  if (value === undefined || value === null) return "";
  const clean = (item: unknown, depth: number): unknown => {
    if (depth > 8) return "[nested value clipped]";
    if (Array.isArray(item)) return item.slice(0, 30).map((entry) => clean(entry, depth + 1));
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 40)
        .map(([key, entry]) => [key, isSecretFieldName(key) ? "[redacted]" : clean(entry, depth + 1)]));
    }
    if (typeof item !== "string") return item;
    let text = redactSecrets(item).text.replace(/\/(Users|home)\/[A-Za-z0-9_.-]+/gu, "/$1/[user]");
    if (blind !== undefined) text = text.replace(blind, MODEL_PLACEHOLDER);
    return text;
  };
  const cleaned = clean(value, 0);
  const text = typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned) ?? "";
  if (text.length <= limit) return text;
  const side = Math.max(1, Math.floor(limit / 4));
  return text.slice(0, 3 * side) + GAP + text.slice(-side);
}

function aliasPattern(aliases: readonly string[]): RegExp | undefined {
  if (aliases.length === 0) return undefined;
  return new RegExp([...aliases].sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
}

const object = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An ATIF document's own steps, in document order. */
function atifSteps(document: unknown): Step[] {
  return array(object(document).steps).map((value) => {
    const step = object(value);
    return {
      role: typeof step.source === "string" ? step.source : "unknown",
      copied: step.is_copied_context === true,
      message: step.message,
      calls: array(step.tool_calls).map((call) => {
        const record = object(call);
        return { ...(typeof record.tool_call_id === "string" && record.tool_call_id !== "" ? { key: record.tool_call_id } : {}), tool: record.function_name, arguments: record.arguments };
      }),
      results: array(object(step.observation).results).map((result) => {
        const record = object(result);
        return { ...(typeof record.source_call_id === "string" ? { call: record.source_call_id } : {}), content: record.content };
      }),
    };
  });
}

/**
 * A native capture's steps: each message the normalized dataset identifies starts a step, and each tool operation
 * joins the step of the model turn that issued it. An operation before any model message starts its own step.
 */
function eventSteps(evidence: RetainedBehaviorEvidence): Step[] {
  const resolve = retainedContentResolver(evidence);
  const read = (event: UniformEvent, input: boolean): unknown[] => (event.content.status === "known" ? event.content.value : [])
    .filter(({ role }) => (role === undefined ? (event.phase !== "after") === input : input ? role === "tool-input" : role === "tool-result" || role === "tool-error"))
    .map(({ nativeReference }) => resolve(nativeReference))
    .flatMap((result) => (result.status === "resolved" ? [result.value] : []));
  const operations = toolOperations(evidence.dataset.events);
  const operationOf = new Map(operations.flatMap((operation) => operation.events.map((event) => [event.id, operation] as const)));
  const placed = new Set<string>();
  const steps: Step[] = [];
  let current: Step | undefined;
  for (const event of evidence.dataset.events) {
    const operation = operationOf.get(event.id);
    if (operation !== undefined) {
      if (placed.has(operation.id)) continue;
      placed.add(operation.id);
      if (current === undefined || !["assistant", "agent"].includes(current.role)) {
        current = { role: "assistant", copied: false, message: "", calls: [], results: [] };
        steps.push(current);
      }
      const input = operation.events.flatMap((member) => read(member, true));
      const output = operation.events.flatMap((member) => read(member, false));
      current.calls.push({ key: operation.id, tool: operation.toolName ?? "unknown", arguments: input.length === 1 ? input[0] : input });
      if (operation.events.some(({ phase }) => phase === "after")) current.results.push({ call: operation.id, content: output.length === 1 ? output[0] : output });
      continue;
    }
    const role = event.family === "message" ? messageRole(event) : undefined;
    if (role === undefined) continue;
    const text = (event.content.status === "known" ? event.content.value : [])
      .map(({ nativeReference }) => resolve(nativeReference)).flatMap((result) => (result.status === "resolved" ? [result.value] : []));
    current = { role, copied: false, message: text.length === 1 ? text[0] : text, calls: [], results: [] };
    steps.push(current);
  }
  return steps;
}
