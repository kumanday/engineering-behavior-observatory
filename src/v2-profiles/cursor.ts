import { digestValue, known, mergeContent, messageFact, object, pointedContent, recordedClock, resources, resultFailure, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
export const cursorV2Profile: NativeProjectionProfile = {
  id: "ebo.cursor-native-v2", version: "2.0.0", harness: "cursor-sdk", module: "v2-profiles/cursor.js",
  project(context) {
    const { event, record } = context, payload = object(record.payload), message = object(payload.message), result = object(message.result);
    const scope = `agent:${text(record.agentId) ?? "unreported"}/session:${text(record.sessionId) ?? "unreported"}/run:${text(record.runId) ?? `document:${event.source.nativeReference.artifactId}`}`;
    const facts: EventFactsV2 = {};
    if (event.family === "message") facts.message = messageFact(message.type, message.type === "assistant" ? false : undefined, message.type === "assistant" ? "fragment" : "unknown");
    if (message.type === "usage") {
      const usage = object(message.usage);
      facts.resource = resources({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
        cacheReadInputTokens: usage.cacheReadTokens, cacheCreationInputTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens }, "step", "increment");
    }
    const clock = recordedClock(context, record.receivedAt, "receipt", "ebo-cursor-recorder");
    const nativeOrder = { status: "unknown", reason: "CURSOR_COLLECTOR_SEQUENCE_IS_PRESENTATION_ORDER" } as const;
    if (event.family !== "tool") return { facts, clock, nativeOrder };
    const failed = message.status === "error" || result.status === "error";
    const complete = failed || message.status === "completed" || result.status === "success";
    const endpoint = complete ? "result" : message.status === "running" ? "call" : "observation";
    const content = mergeContent(message.args !== undefined ? pointedContent(context, "/payload/message/args", "tool-input") : undefined,
      complete && message.result !== undefined ? pointedContent(context, "/payload/message/result", "tool-result") : undefined);
    return { facts, clock, nativeOrder, ...(content ? { content } : {}), phase: complete ? "after" : endpoint === "call" ? "before" : "during",
      operation: { nativeId: text(message.call_id), scope, endpoint, canonical: true, toolName: text(message.name),
        ...(message.args === undefined ? {} : { inputDigest: digestValue(message.args) }),
        failure: complete ? failed ? known(true) : result.status === "success" ? resultFailure(false, object(result.value).exitCode) : resultFailure(undefined) : unreported } };
  },
};
