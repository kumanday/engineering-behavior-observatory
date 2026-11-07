import { readEvidencePointer } from "../evidence-pointers.js";
import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resources, resultFailure, text, unreported,
  type NativeProjectionProfile, type ProjectionContext } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
type ScopeIndex = Map<string, Set<string>>;
const indexes = new WeakMap<readonly Record<string, unknown>[], ScopeIndex>();
function sessionScope(record: Record<string, unknown>, fallback: string): string {
  const message = object(record.message), payload = object(record.nativePayload);
  const session = text(record.sessionId) ?? text(message.session_id) ?? text(payload.session_id);
  const parent = text(message.parent_tool_use_id) ?? text(payload.parent_tool_use_id);
  return `${session ? `session:${session}` : `document:${fallback}`}${parent ? `/parent-tool:${parent}` : "/root"}`;
}
function index(context: ProjectionContext): ScopeIndex {
  let result = indexes.get(context.records); if (result) return result;
  result = new Map();
  for (const record of context.records) {
    const message = object(record.message), content = object(message.message).content;
    if (!Array.isArray(content)) continue;
    for (const value of content) {
      const block = object(value), id = text(block.type === "tool_use" ? block.id : block.type === "tool_result" ? block.tool_use_id : undefined);
      if (!id) continue;
      const scope = sessionScope(record, "unreported"); if (scope.startsWith("document:")) continue;
      const scopes = result.get(id) ?? new Set<string>(); scopes.add(scope); result.set(id, scopes);
    }
  }
  indexes.set(context.records, result); return result;
}
function toolBlock(context: ProjectionContext): Record<string, unknown> {
  if (context.event.content.status !== "known") return {};
  const reference = context.event.content.value.find(({ role }) => role === "tool-input" || role === "tool-result")?.nativeReference;
  const marker = reference?.recordLocator.indexOf("#");
  if (reference === undefined || marker === undefined || marker < 0) return {};
  const result = readEvidencePointer(context.record, reference.recordLocator.slice(marker));
  return result.found ? object(result.value) : {};
}
export const claudeV2Profile: NativeProjectionProfile = {
  id: "ebo.claude-native-v2", version: "2.0.0", harness: "claude-agent-sdk", module: "v2-profiles/claude.js",
  project(context) {
    const { event, record } = context, message = object(record.message), inner = object(message.message), payload = object(record.nativePayload);
    const hook = text(record.hook), type = text(record.nativeType) ?? event.source.nativeType, facts: EventFactsV2 = {};
    let scope = sessionScope(record, event.source.nativeReference.artifactId);
    if (event.family === "message") {
      const role = type === "assistant" ? "assistant" : type === "user" ? "user" : hook === "UserPromptSubmit" ? "user" : undefined;
      facts.message = messageFact(role, role === "user" ? true : typeof inner.stop_reason === "string" ? true : undefined,
        type === "assistant" || type === "user" || hook === "UserPromptSubmit" ? "canonical" : "fragment",
        text(inner.id) ?? text(message.uuid) ? known({ id: (text(inner.id) ?? text(message.uuid))!, scope, identityClass: "source-native" }) : unreported);
      if (role === "assistant") facts.inference = { llmCallCount: unreported, nativeRequestId: text(message.request_id) ? known(text(message.request_id)!) : unreported };
    }
    if (event.family === "context") facts.context = contextFact(hook === "PreCompact" || hook === "PostCompact" || message.subtype === "compact_boundary" ? "compaction" : "other");
    if (event.family === "runtime" && event.attributes.resourceSemantics === "increment") {
      const usage = object(inner.usage);
      facts.resource = resources({ inputTokens: usage.input_tokens, cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens }, "step", "increment",
        text(inner.id) ? known(`${scope}/message:${text(inner.id)!}`) : unreported);
    } else if (event.family === "runtime" && type === "result") {
      const models = Object.values(object(message.modelUsage)).map(object);
      const summed = (field: string) => models.length && models.every((model) => typeof model[field] === "number" && Number.isFinite(model[field]) && Number(model[field]) >= 0)
        ? models.reduce((sum, model) => sum + Number(model[field]), 0) : undefined;
      facts.resource = resources({ inputTokens: summed("inputTokens"), outputTokens: summed("outputTokens"),
        cacheReadInputTokens: summed("cacheReadInputTokens"), cacheCreationInputTokens: summed("cacheCreationInputTokens"),
        totalCostUsd: message.total_cost_usd }, "child-inclusive", "cumulative-final", known(`${scope}/attempt:${event.attemptId}`));
    }
    const clock = hook ? recordedClock(context, record.callbackAt, "producer-observation", "claude-hook-callback")
      : message.timestamp !== undefined ? recordedClock(context, message.timestamp, "producer-observation", "claude-native")
      : recordedClock(context, record.capturedAt, "receipt", "ebo-claude-recorder");
    if (hook === "PostToolBatch" || type === "tool_use_summary") return { facts, clock, family: "runtime" };
    if (!["tool", "model-request", "delegation"].includes(event.family)) {
      const nativeId = text(payload.tool_use_id) ?? text(record.toolUseId), scopes = nativeId ? index(context).get(nativeId) : undefined;
      return { facts, clock, ...(event.family === "permission" && nativeId && scopes?.size === 1
        ? { association: { nativeId, scope: [...scopes][0]!, kind: "tool" as const } } : {}) };
    }
    const block = toolBlock(context);
    const toolId = text(block.type === "tool_use" ? block.id : block.tool_use_id) ?? text(record.toolUseId) ?? text(payload.tool_use_id) ?? text(message.tool_use_id);
    if (hook && toolId) {
      const candidates = index(context).get(toolId);
      // Hook copies join only a uniquely established native tool scope.
      if (candidates?.size === 1) scope = [...candidates][0]!;
      else if (candidates && candidates.size > 1) scope = `${scope}/unresolved-hook:${event.id}`;
    }
    const terminalTask = event.family === "delegation" && message.subtype === "task_notification" && ["completed", "failed", "stopped"].includes(String(message.status));
    const phase = terminalTask ? "after" : event.phase;
    const endpoint = phase === "before" ? "call" : phase === "after" ? "result" : "observation";
    const nativeId = event.family === "tool" ? toolId : event.family === "delegation"
      ? text(payload.agent_id) ?? text(record.agentId) ?? text(payload.task_id) ?? text(message.task_id)
      : text(message.request_id);
    const issuing = text(inner.id);
    const input = block.input ?? payload.tool_input;
    let content;
    if (hook && endpoint === "call" && payload.tool_input !== undefined) content = pointedContent(context, "/nativePayload/tool_input", "tool-input");
    else if (hook && endpoint === "result" && payload.tool_response !== undefined) content = pointedContent(context, "/nativePayload/tool_response", "tool-result");
    else if (!hook && event.content.status === "known") {
      const base = event.content.value.find(({ role }) => role === "tool-input" || role === "tool-result");
      const suffix = block.type === "tool_use" && block.input !== undefined ? "/input" : block.type === "tool_result" && block.content !== undefined ? "/content" : undefined;
      if (base && suffix) content = known([{ ...base, nativeReference: { ...base.nativeReference, recordLocator: `${base.nativeReference.recordLocator}${suffix}` } }]);
    }
    return { facts, clock, phase, ...(content ? { content } : {}), operation: { nativeId, scope, endpoint, canonical: !hook,
      ...(hook && toolId && (index(context).get(toolId)?.size ?? 0) > 1 ? { scopeStatus: "record-local" as const } : {}),
      toolName: text(block.name) ?? text(payload.tool_name), ...(input === undefined ? {} : { inputDigest: digestValue(input) }),
      failure: endpoint !== "result" ? unreported : terminalTask ? message.status === "failed" ? known(true) : message.status === "completed" ? known(false) : unreported : hook === "PostToolUseFailure" ? known(true) : hook === "PostToolUse" ? known(false) : resultFailure(block.is_error),
      issuingInference: issuing ? known({ id: issuing, scope, identityClass: "model-output" }) : unreported } };
  },
};
