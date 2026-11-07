import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resources, resultFailure, text, unreported,
  type NativeProjectionProfile, type ProjectionContext, type OperationContribution } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
import type { UniformEvent } from "../uniform-events.js";

type PiIndex = { byId: Map<string, Record<string, unknown>>; issuers: Map<string, string[]>; messages: Map<string, string[]>; sessionId?: string };
const indexes = new WeakMap<readonly Record<string, unknown>[], PiIndex>();
function messageKey(message: Record<string, unknown>): string | undefined {
  if (text(message.responseId)) return JSON.stringify([message.role, "response", message.responseId]);
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? JSON.stringify([message.role, "timestamp", message.timestamp]) : undefined;
}
function index(records: readonly Record<string, unknown>[]): PiIndex {
  let value = indexes.get(records); if (value) return value;
  value = { byId: new Map(), issuers: new Map(), messages: new Map(), sessionId: records.flatMap((record) => record.type === "session" ? text(record.id) ?? [] : text(record.sessionId) ?? []).at(0) };
  for (const record of records) {
    const id = text(record.id); if (id) value.byId.set(id, record);
    const message = object(record.message);
    const key = messageKey(message);
    if (record.type === "message" && id && key) value.messages.set(key, [...value.messages.get(key) ?? [], id]);
    if (record.type !== "message" || message.role !== "assistant" || !id || !Array.isArray(message.content)) continue;
    for (const block of message.content) { const tool = object(block), callId = text(tool.id);
      if (tool.type === "toolCall" && callId) value.issuers.set(callId, [...value.issuers.get(callId) ?? [], id]);
    }
  }
  indexes.set(records, value); return value;
}
function issuer(context: ProjectionContext, callId: string | undefined): string | undefined {
  if (!callId) return undefined;
  const lookup = index(context.records), candidates = lookup.issuers.get(callId) ?? [];
  if (candidates.length === 1) return candidates[0];
  const visited = new Set<string>(); let id = text(context.record.id) ?? text(context.record.parentId);
  while (id && !visited.has(id)) { if (candidates.includes(id)) return id; visited.add(id); id = text(lookup.byId.get(id)?.parentId); }
  return undefined;
}
const role = (value: unknown) => value === "toolResult" || value === "bashExecution" ? "tool" : value;
function expand(context: ProjectionContext): UniformEvent[] {
  const { event, record } = context, message = object(record.message);
  if (event.family !== "message" || record.type !== "message") return [];
  const make = (suffix: string, phase: UniformEvent["phase"], pointer: string): UniformEvent => ({ ...structuredClone(event), id: `${event.id}:${suffix}`,
    family: "tool", phase, content: { status: "known", value: [{ nativeReference: { ...event.source.nativeReference,
      recordLocator: `${event.source.nativeReference.recordLocator}#${pointer}` }, role: phase === "before" ? "tool-input" : "tool-result" }] } });
  if (message.role === "assistant" && Array.isArray(message.content)) return message.content.flatMap((block, position) => object(block).type === "toolCall"
    ? [make(`tool:${position}`, "before", `/message/content/${position}`)] : []);
  return message.role === "toolResult" ? [make("tool-result", "after", "/message")] : [];
}
export const piV2Profile: NativeProjectionProfile = {
  id: "ebo.pi-native-v2", version: "2.0.0", harness: "pi-sdk", module: "v2-profiles/pi.js", expand,
  project(context) {
    const { event, record } = context, envelope = record.schemaVersion === "ebo.pi-native-record/v1";
    const payload = envelope ? object(record.payload) : record, message = object(envelope ? payload.message : record.message);
    const lookup = index(context.records), session = text(record.sessionId) ?? lookup.sessionId;
    const scope = session ? `session:${session}` : `document:${event.source.nativeReference.artifactId}`;
    const type = envelope ? text(record.nativeType) : text(record.type);
    const facts: EventFactsV2 = {};
    let operation: OperationContribution | undefined;
    if (event.family === "message") {
      const history = !envelope && record.type === "message";
      const matches = history ? [] : lookup.messages.get(messageKey(message) ?? "") ?? [];
      const matchingId = matches.length === 1 && text(record.sessionId) === lookup.sessionId ? matches[0] : undefined;
      const identity = history ? text(record.id) : matchingId;
      facts.message = messageFact(role(message.role), history || type === "message_end" ? true : false,
        history ? "canonical" : matchingId && type === "message_end" ? "duplicate" : "fragment",
        identity ? known({ id: identity, scope, identityClass: "source-native" }) : unreported);
      if (message.role === "assistant" && history) facts.inference = { llmCallCount: known(1), nativeRequestId: unreported };
    }
    if (event.family === "tool") {
      const position = /:tool:(\d+)$/u.exec(event.id)?.[1];
      const block = position !== undefined && Array.isArray(message.content) ? object(message.content[Number(position)]) : {};
      const callId = text(block.id) ?? text(message.toolCallId) ?? text(payload.toolCallId);
      const issuingId = issuer(context, callId);
      const endpoint = event.phase === "before" ? "call" : event.phase === "after" ? "result" : "observation";
      const input = Object.hasOwn(block, "arguments") ? block.arguments : payload.args;
      const ambiguous = callId !== undefined && (lookup.issuers.get(callId)?.length ?? 0) > 1;
      operation = { nativeId: callId, scope: issuingId ? `${scope}/issuing-message:${issuingId}` : ambiguous ? `${scope}/unresolved:${event.id}` : `${scope}/${envelope ? "stream" : "unmatched-history"}`,
        endpoint, canonical: !envelope, toolName: text(block.name) ?? text(message.toolName) ?? text(payload.toolName),
        ...(input === undefined ? {} : { inputDigest: digestValue(input) }),
        failure: endpoint === "result" ? resultFailure(envelope ? payload.isError : message.isError) : unreported,
        issuingInference: issuingId ? known({ id: issuingId, scope, identityClass: "declared-single-inference" }) : unreported };
    }
    if (event.family === "model-request") {
      operation = { scope, nativeId: event.id, identityClass: "ebo-derived", endpoint: "call" };
      facts.inference = { llmCallCount: unreported, nativeRequestId: unreported };
    }
    if (event.family === "context") facts.context = contextFact(type === "branch_summary" ? "summarization"
      : ["compaction", "compaction_start", "compaction_end", "session_before_compact", "session_compact", "session_compact_failed"].includes(type ?? "") ? "compaction" : "other");
    if (event.family === "runtime" && event.id.includes("usage-")) {
      const usage = object(message.usage ?? record.usage);
      facts.resource = resources({ inputTokens: usage.input, outputTokens: usage.output, cacheReadInputTokens: usage.cacheRead,
        cacheCreationInputTokens: usage.cacheWrite, totalTokens: usage.totalTokens, totalCostUsd: object(usage.cost).total }, "step", "increment");
    }
    const origin = envelope ? message.timestamp : record.timestamp ?? message.timestamp;
    const clock = origin !== undefined ? recordedClock(context, origin, "producer-observation", `${scope}/pi-native`)
      : recordedClock(context, record.receivedAt, "receipt", `${scope}/ebo-recorder`);
    const position = /:tool:(\d+)$/u.exec(event.id)?.[1];
    const content = event.family !== "tool" ? undefined : envelope
      ? operation?.endpoint === "call" && payload.args !== undefined ? pointedContent(context, "/payload/args", "tool-input")
        : operation?.endpoint === "result" && payload.result !== undefined ? pointedContent(context, "/payload/result", "tool-result") : undefined
      : position !== undefined && Array.isArray(message.content) && object(message.content[Number(position)]).arguments !== undefined ? pointedContent(context, `/message/content/${position}/arguments`, "tool-input")
        : message.role === "toolResult" && message.content !== undefined ? pointedContent(context, "/message/content", "tool-result") : undefined;
    return { facts, clock, ...(operation ? { operation } : {}), ...(content ? { content } : {}) };
  },
};
