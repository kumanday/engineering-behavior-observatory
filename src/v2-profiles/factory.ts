import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resources, resultFailure, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
export const factoryV2Profile: NativeProjectionProfile = {
  id: "ebo.factory-native-v2", version: "2.0.0", harness: "factory-droid", module: "v2-profiles/factory.js",
  project(context) {
    const { event, record } = context, frame = object(record.payload), params = object(frame.params), notification = object(params.notification);
    const session = text(params.sessionId), scope = session ? `session:${session}` : `unresolved-document:${event.source.nativeReference.artifactId}`;
    const type = text(notification.type) ?? text(frame.method), facts: EventFactsV2 = {};
    const messageId = frame.method === "droid.add_user_message" ? text(params.messageId)
      : type === "assistant_text_delta" ? text(notification.messageId) : text(object(notification.message).id);
    if (event.family === "message") facts.message = messageFact(frame.method === "droid.add_user_message" ? "user" : "assistant",
      type === "create_message" || frame.method === "droid.add_user_message", type === "assistant_text_delta" ? "fragment" : "canonical",
      messageId ? known({ id: messageId, scope, identityClass: "source-native" }) : unreported);
    if (event.family === "context") facts.context = contextFact(type === "session_compacted" ? "compaction" : "other");
    const usage = object(notification.tokenUsage);
    const values = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadInputTokens: usage.cacheReadTokens,
      cacheCreationInputTokens: usage.cacheCreationTokens, reasoningTokens: usage.thinkingTokens, factoryCredits: usage.factoryCredits };
    if (type === "agent_turn_completed" && event.family === "runtime") facts.resource = resources(values, "child-inclusive", "cumulative-final",
      session && text(notification.turnId) ? known(`${scope}/turn:${text(notification.turnId)!}`) : unreported);
    if (type === "session_token_usage_changed") facts.resource = resources(values, "session", "cumulative-snapshot", session ? known(scope) : unreported);
    const clock = recordedClock(context, record.observedAt, "receipt", "ebo-factory-recorder");
    if (event.family !== "tool" && event.family !== "delegation") return { facts, clock };
    const tool = object(notification.toolUse), call = type === "tool_call";
    const content = event.family !== "tool" ? undefined : call && tool.input !== undefined ? pointedContent(context, "/payload/params/notification/toolUse/input", "tool-input")
      : !call && notification.content !== undefined ? pointedContent(context, "/payload/params/notification/content", "tool-result") : undefined;
    return { facts, clock, ...(content ? { content } : {}), operation: { nativeId: event.family === "delegation" ? text(notification.childSessionId) : text(tool.id) ?? text(notification.toolUseId),
      scope, endpoint: event.family === "delegation" ? "observation" : call ? "call" : "result", canonical: true,
      toolName: text(tool.name), ...(tool.input === undefined ? {} : { inputDigest: digestValue(tool.input) }),
      failure: call ? unreported : resultFailure(notification.isError) }, ...(event.family === "delegation" ? { phase: "instant" as const } : {}) };
  },
};
