import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resources, resultFailure, subrecordLocator, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
const callNames = new WeakMap<readonly Record<string, unknown>[], Map<string, Set<string>>>();
function callKey(session: unknown, data: Record<string, unknown>, id: unknown): string {
  return JSON.stringify([session ?? null, data.turn ?? null, data.step ?? null, id ?? null]);
}
function originatingTool(records: readonly Record<string, unknown>[], session: unknown, data: Record<string, unknown>, id: unknown): string | undefined {
  let names = callNames.get(records);
  if (!names) {
    names = new Map();
    for (const record of records) {
      const payload = object(record.payload), event = object(payload.event), call = object(event.data), name = text(call.name);
      if (event.type !== "tool/call" || !name || !text(call.callId)) continue;
      const key = callKey(payload.sessionId ?? record.sessionId, call, call.callId), values = names.get(key) ?? new Set<string>();
      values.add(name); names.set(key, values);
    }
    callNames.set(records, names);
  }
  const values = names.get(callKey(session, data, id));
  return values?.size === 1 ? [...values][0] : undefined;
}
export const deepSeekV2Profile: NativeProjectionProfile = {
  id: "ebo.deepseek-native-v2", version: "2.0.0", harness: "deepseek-harness", module: "v2-profiles/deepseek.js",
  expand({ event, record }) {
    const native = object(object(record.payload).event), message = object(object(native.data).message);
    const parts = Array.isArray(message.content) ? message.content.map(object) : [];
    if (event.family !== "tool" || native.type !== "tool/result" || parts.filter((part) => part.type === "tool_result").length <= 1) return [];
    return parts.flatMap((part, index) => part.type !== "tool_result" ? [] : [{ ...structuredClone(event), id: `${event.id}:tool-part:${index}`,
      content: known([{ nativeReference: { ...event.source.nativeReference, recordLocator: subrecordLocator(event.source.nativeReference.recordLocator, `/payload/event/data/message/content/${index}`) }, role: "tool-result" }]) }]);
  },
  project(context) {
    const { event, record } = context, payload = object(record.payload), native = object(payload.event), data = object(native.data), message = native.type === "user/message" ? data : object(data.message);
    const type = text(native.type), session = text(payload.sessionId) ?? text(record.sessionId);
    const scope = event.family === "delegation" && text(payload.parentSessionId) ? `session:${text(payload.parentSessionId)!}`
      : session ? `session:${session}` : `document:${event.source.nativeReference.artifactId}`;
    const facts: EventFactsV2 = {};
    if (event.family === "message") facts.message = messageFact(type === "user/message" ? "user" : type === "assistant/message" ? "assistant" : undefined,
      (type === "user/message" || type === "assistant/message") && data.interrupted !== true, type === "user/message" || type === "assistant/message" ? "canonical" : "fragment",
      text(message.id) ? known({ id: text(message.id)!, scope, identityClass: "source-native" }) : unreported);
    if (event.family === "context") facts.context = contextFact(type?.startsWith("compaction/") ? "compaction" : "other");
    if (event.family === "runtime" && event.id.endsWith(":usage")) {
      const usage = object(data.usage);
      facts.resource = resources({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadTokens,
        cacheCreationInputTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens }, "step", "increment",
        session && Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step) ? known(`${scope}/turn:${String(data.turn)}/step:${String(data.step)}`) : unreported);
    }
    const clock = native.time !== undefined ? recordedClock(context, native.time, "producer-observation", `deepseek/${scope}`)
      : recordedClock(context, record.observedAt, "receipt", "ebo-deepseek-recorder");
    const nativeOrder = typeof native.seq === "number" && Number.isSafeInteger(native.seq) && native.seq >= 0
      ? { status: "known" as const, value: native.seq, domain: `deepseek/${scope}` } : unreported;
    if (!["tool", "model-request", "delegation"].includes(event.family)) return { facts, clock, nativeOrder };
    const parts = Array.isArray(message.content) ? message.content.map(object) : [];
    const partIndex = /:tool-part:(\d+)$/u.exec(event.id)?.[1];
    if (event.family === "tool" && type === "tool/result" && partIndex === undefined && parts.filter((part) => part.type === "tool_result").length > 1) return { facts, clock, nativeOrder, family: "runtime" };
    const firstClass = message.role === "tool" && text(message.toolCallId) !== undefined;
    const part = firstClass ? message : partIndex === undefined ? parts.find((value) => value.type === "tool_result") ?? {} : parts[Number(partIndex)] ?? {};
    const output = Array.isArray(part.content) ? part.content.flatMap((block) => text(object(block).text) ?? []).join("") : text(part.content);
    const toolId = text(part.toolCallId) ?? text(data.callId) ?? text(object(message.source).callId);
    const toolName = text(data.name) ?? originatingTool(context.records, payload.sessionId ?? record.sessionId, data, toolId);
    const killed = toolName === "bash" && output !== undefined && /\n\[killed by signal: [^\]\n]+\]\s*$/u.test(output);
    const exit = toolName !== "bash" || output === undefined ? null : /\n?\[exit code: (-?\d+)\]\s*$/u.exec(output);
    const phase = type === "tool/call" || record.method === "subagent.started" ? "before"
      : type === "tool/result" || record.method === "subagent.finished" ? "after" : event.phase;
    const endpoint = phase === "before" ? "call" : phase === "after" ? "result" : "observation";
    const nativeId = event.family === "tool" ? toolId
      : event.family === "delegation" ? text(payload.childSessionId) : text(data.requestId);
    if (event.family === "model-request") facts.inference = { llmCallCount: unreported, nativeRequestId: nativeId ? known(nativeId) : unreported };
    const hasStep = Number.isSafeInteger(data.turn) && Number(data.turn) >= 0 && Number.isSafeInteger(data.step) && Number(data.step) >= 0;
    const operationScope = event.family === "tool" || event.family === "model-request" && nativeId === undefined
      ? hasStep ? `${scope}/turn:${String(data.turn)}/step:${String(data.step)}` : `${scope}/unresolved-step:${event.id}` : scope;
    const recoveryUnknown = object(data.error).code === "TOOL_OUTCOME_UNKNOWN";
    const effectiveEndpoint = recoveryUnknown ? "observation" : endpoint;
    const selectedPart = partIndex === undefined ? parts.indexOf(part) : Number(partIndex);
    const content = type === "tool/call" && data.arguments !== undefined ? pointedContent(context, "/payload/event/data/arguments", "tool-input")
      : type === "tool/result" && firstClass && message.content !== undefined ? pointedContent(context, "/payload/event/data/message/content", "tool-result")
        : type === "tool/result" && selectedPart >= 0 && part.content !== undefined ? pointedContent(context, `/payload/event/data/message/content/${selectedPart}/content`, "tool-result") : undefined;
    return { facts, clock, nativeOrder, phase: recoveryUnknown ? "during" : phase, ...(content ? { content } : {}), operation: { nativeId: nativeId ?? (event.family === "model-request" && hasStep ? "request-observation" : undefined),
      ...(nativeId === undefined ? { identityClass: "ebo-derived" as const } : {}), scope: operationScope, endpoint: effectiveEndpoint, canonical: true,
      ...((event.family === "tool" || event.family === "model-request" && nativeId === undefined) && !hasStep ? { scopeStatus: "record-local" as const } : {}),
      issuingInference: event.family === "tool" && hasStep ? known({ id: `turn:${String(data.turn)}/step:${String(data.step)}`, scope, identityClass: "model-output" }) : unreported,
      toolName, ...(data.arguments === undefined ? {} : { inputDigest: digestValue(data.arguments) }),
      failure: effectiveEndpoint !== "result" ? unreported : event.family === "delegation"
        ? payload.status === "ok" ? known(false) : payload.status === "error" ? known(true) : unreported
        : resultFailure(killed ? true : part.isError, exit ? Number(exit[1]) : undefined) } };
  },
};
