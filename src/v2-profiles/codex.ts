import { contextFact, digestValue, known, mergeContent, messageFact, object, pointedContent, recordedClock, resources, resultFailure, supplementalEvent, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
const toolKinds = new Set(["commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch"]);
export const codexV2Profile: NativeProjectionProfile = {
  id: "ebo.codex-native-v2", version: "2.0.0", harness: "codex-app-server", module: "v2-profiles/codex.js",
  additional(population) {
    const owned = object(population.capture);
    if (!text(owned.threadId) || !text(owned.turnId)) return [];
    return population.records.flatMap((captured) => {
      const record = object(captured.record), payload = object(record.payload), item = object(payload.item);
      if (record.source !== "codex-app-server" || record.kind !== "notification" || record.method !== "item/started"
          || payload.threadId !== owned.threadId || payload.turnId !== owned.turnId || !(toolKinds.has(String(item.type)) || item.type === "collabAgentToolCall")) return [];
      return [supplementalEvent(population, captured, { harness: "codex-app-server", id: `codex-v2:${String(record.sequence)}:item-started`, nativeType: "item/started",
        family: item.type === "collabAgentToolCall" ? "delegation" : "tool", phase: "before", contentPointer: "/payload/item",
        nativeOrder: Number.isSafeInteger(record.sequence) ? { status: "known", value: Number(record.sequence), domain: "codex-app-server-stdio" } : unreported })];
    });
  },
  project(context) {
    const { event, record } = context, payload = object(record.payload), item = object(payload.item), method = text(record.method);
    const scope = `thread:${text(payload.threadId) ?? `unresolved:${event.source.nativeReference.artifactId}`}/turn:${text(payload.turnId) ?? text(object(payload.turn).id) ?? "unreported"}`;
    const facts: EventFactsV2 = {};
    if (event.family === "message") facts.message = messageFact(item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : undefined, method === "item/completed", "canonical",
      text(item.id) ? known({ id: text(item.id)!, scope, identityClass: "source-native" }) : unreported);
    if (event.family === "context") facts.context = contextFact(method === "thread/compacted" ? "compaction" : "other");
    if (method === "thread/tokenUsage/updated") {
      const increment = event.id.endsWith(":request");
      const usage = object(object(payload.tokenUsage)[increment ? "last" : "total"]);
      facts.resource = resources({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
        cacheReadInputTokens: usage.cachedInputTokens, cacheCreationInputTokens: usage.cacheWriteInputTokens,
        reasoningTokens: usage.reasoningOutputTokens }, increment ? "step" : "session", increment ? "increment" : "cumulative-snapshot",
        !increment && text(payload.threadId) ? known(`thread:${text(payload.threadId)!}`) : unreported);
    }
    const timestamp = method === "item/completed" ? payload.completedAtMs ?? item.completedAtMs : method === "item/started" ? payload.startedAtMs ?? item.startedAtMs : undefined;
    const clock = timestamp === undefined ? recordedClock(context, record.observedAt, "receipt", "ebo-codex-recorder")
      : recordedClock(context, timestamp, "producer-observation", `codex-lifecycle/${scope}`);
    const nativeOrder = event.nativeOrder.status === "known" ? { ...event.nativeOrder, domain: `${event.nativeOrder.domain}/${scope}` } : event.nativeOrder;
    if (event.family !== "tool" && event.family !== "delegation") return { facts, clock, nativeOrder,
      ...(event.family === "permission" && text(payload.itemId) ? { association: { nativeId: text(payload.itemId)!, scope, kind: "tool" as const } } : {}) };
    const endpoint = method === "item/started" ? "call" : "result";
    const input = item.command ?? item.arguments ?? item.query;
    const failure = item.status === "failed" || item.status === "declined" || item.error !== null && item.error !== undefined ? known(true)
      : resultFailure(item.type === "dynamicToolCall" && typeof item.success === "boolean" ? !item.success : item.isError, item.exitCode);
    const inputKey = item.command !== undefined ? "command" : item.arguments !== undefined ? "arguments" : item.query !== undefined ? "query" : undefined;
    const outputKey = item.aggregatedOutput !== undefined ? "aggregatedOutput" : item.result !== undefined ? "result" : item.type === "dynamicToolCall" && item.contentItems !== undefined ? "contentItems" : undefined;
    const content = mergeContent(inputKey ? pointedContent(context, `/payload/item/${inputKey}`, "tool-input") : undefined,
      endpoint === "result" && outputKey ? pointedContent(context, `/payload/item/${outputKey}`, "tool-result") : undefined);
    return { facts, clock, nativeOrder, ...(content ? { content } : {}), operation: { nativeId: text(item.id), scope, endpoint, canonical: true,
      toolName: text(item.tool) ?? text(item.name) ?? (item.type === "commandExecution" ? "shell" : text(item.type)),
      ...(input === undefined ? {} : { inputDigest: digestValue(input) }), failure: endpoint === "result" ? failure : unreported } };
  },
};
