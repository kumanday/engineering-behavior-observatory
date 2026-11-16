import type { UniformEvent } from "./uniform-events.js";

/** Frozen 1.x interpretation policies. Typed v2 consumers use Operation and EventFactsV2. */
export function v1OperationAlias(event: UniformEvent, policy: "structural" | "rating" | "atlas"): string | undefined {
  const keys = policy === "structural" ? ["toolUseId", "toolCallId", "actionId", "callId", "itemId"]
    : policy === "rating" ? ["toolUseId", "toolCallId", "callId", "itemId"] : ["toolCallId", "callId", ...(event.family === "tool" ? ["itemId"] : [])];
  for (const key of keys) {
    const value = event.attributes[key];
    if (typeof value === "string" && (policy === "atlas" ? true : value !== "")) return value;
  }
  return undefined;
}
export function v1MessageRole(event: UniformEvent): string | undefined {
  const a = event.attributes, type = [a.eventType, a.itemType, a.method].find((v): v is string => typeof v === "string") ?? event.source.nativeType;
  const role = typeof a.role === "string" ? a.role : undefined;
  switch (event.source.harness) {
    case "factory-droid": return type === "droid.add_user_message" ? "user" : type === "create_message" ? "assistant" : undefined;
    case "codex-app-server": return type === "agentMessage" ? "agent" : type === "userMessage" ? "user" : undefined;
    case "deepseek-harness": return type === "assistant/message" ? "assistant" : type === "user/message" ? "user" : undefined;
    case "pi-sdk": return event.source.nativeType === "history:message" && (role === "user" || role === "assistant") ? role : undefined;
    case "claude-agent-sdk":
      if (type === "assistant" && event.actor.kind === "model") return "assistant";
      if (type === "user" && event.actor.kind === "harness") return "harness";
      return type === "UserPromptSubmit" ? "user" : undefined;
    case "devin-cli": return a.sessionUpdate === "agent_message_chunk" ? "assistant" : a.sessionUpdate === "user_message_chunk" || type === "session/prompt" ? "user" : undefined;
    default:
      if (event.phase === "before" || event.phase === "during" || /chunk|delta|start/u.test(type)) return undefined;
      return role === "user" || role === "assistant" || role === "agent" ? role : event.actor.kind === "user" ? "user" : event.actor.kind === "model" || event.actor.kind === "agent" ? "assistant" : undefined;
  }
}
