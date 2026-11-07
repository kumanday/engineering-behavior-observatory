import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resources, resultFailure, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
const exits = new WeakMap<readonly Record<string, unknown>[], Map<string, Array<{ sequence: number; value: Record<string, unknown> }>>>();
export const devinV2Profile: NativeProjectionProfile = {
  id: "ebo.devin-native-v2", version: "2.0.0", harness: "devin-cli", module: "v2-profiles/devin.js",
  project(context) {
    const { event, record } = context, payload = object(record.payload), update = object(payload.update), meta = object(update._meta);
    const session = text(payload.sessionId), scope = session ? `session:${session}` : `document:${event.source.nativeReference.artifactId}`;
    const type = text(update.sessionUpdate), facts: EventFactsV2 = {};
    if (event.family === "message") facts.message = messageFact(type === "user_message_chunk" || record.method === "session/prompt" ? "user" : "assistant",
      record.method === "session/prompt", record.method === "session/prompt" ? "canonical" : "fragment");
    if (event.family === "context") facts.context = contextFact("other");
    if (type === "usage_update") facts.resource = resources({ inputTokens: meta["cognition.ai/inputTokens"], outputTokens: meta["cognition.ai/outputTokens"],
      cacheReadInputTokens: meta["cognition.ai/cachedReadTokens"] }, "step", "cumulative-snapshot");
    if (record.method === "_cognition.ai/agent_stopped") {
      const dimensions = object(payload.stats).responseDimensions, values: Record<string, unknown> = {};
      const names: Record<string, string> = { input_tokens: "inputTokens", output_tokens: "outputTokens", cached_input_tokens: "cacheReadInputTokens" };
      for (const value of Array.isArray(dimensions) ? dimensions : []) {
        const dimension = object(value), kind = object(dimension.kind), name = names[String(dimension.uid)];
        if (name && kind.type === "cumulativeMetric") values[name] = kind.value;
      }
      facts.resource = resources(values, "attempt", "cumulative-final");
    }
    const clock = recordedClock(context, record.observedAt, "receipt", "ebo-devin-recorder");
    if (event.family !== "tool") return { facts, clock,
      ...(event.family === "permission" && text(object(payload.toolCall).toolCallId) ? { association: { nativeId: text(object(payload.toolCall).toolCallId)!, scope, kind: "tool" as const } } : {}) };
    let lookup = exits.get(context.records);
    if (!lookup) {
      lookup = new Map();
      for (const candidate of context.records) {
        const params = object(candidate.payload), native = object(params.update), exit = object(object(native._meta).terminal_exit);
        if (!Object.keys(exit).length || !text(native.toolCallId) || !Number.isSafeInteger(candidate.sequence)) continue;
        const key = JSON.stringify([params.sessionId, native.toolCallId]), values = lookup.get(key) ?? [];
        values.push({ sequence: Number(candidate.sequence), value: exit }); lookup.set(key, values);
      }
      exits.set(context.records, lookup);
    }
    const prior = lookup.get(JSON.stringify([payload.sessionId, update.toolCallId]))?.filter(({ sequence }) => sequence <= Number(record.sequence))
      .reduce<{ sequence: number; value: Record<string, unknown> } | undefined>((last, current) => !last || current.sequence > last.sequence ? current : last, undefined);
    const exit = Object.keys(object(meta.terminal_exit)).length ? object(meta.terminal_exit) : prior?.value ?? {};
    const endpoint = type === "tool_call" ? "call" : "result";
    const failure = update.status === "failed" || meta["cognition.ai/canceled"] === true || typeof exit.signal === "string" ? known(true)
      : resultFailure(undefined, exit.exit_code);
    const outputKey = update.rawOutput !== undefined ? "rawOutput" : update.content !== undefined ? "content" : undefined;
    const content = endpoint === "call" && update.rawInput !== undefined ? pointedContent(context, "/payload/update/rawInput", "tool-input")
      : endpoint === "result" && outputKey ? pointedContent(context, `/payload/update/${outputKey}`, "tool-result") : undefined;
    return { facts, clock, ...(content ? { content } : {}), operation: { nativeId: text(update.toolCallId), scope, endpoint, canonical: true,
      toolName: text(meta["cognition.ai/inferenceToolName"]), ...(update.rawInput === undefined ? {} : { inputDigest: digestValue(update.rawInput) }),
      failure: endpoint === "result" ? failure : unreported } };
  },
};
