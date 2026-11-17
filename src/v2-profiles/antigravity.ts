import { digestValue, known, mergeContent, messageFact, object, pointedContent, recordedClock, resources, text, unreported, type NativeProjectionProfile } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";

/** Stream step identities join observations; they do not identify model inferences. */
export const antigravityV2Profile: NativeProjectionProfile = {
  id: "ebo.antigravity-native-v2", version: "2.0.0", harness: "antigravity-cli", module: "v2-profiles/antigravity.js",
  expand({ event, record, records }) {
    const step = object(object(record.payload).step_update), info = object(step.tool_info);
    // A DONE snapshot can carry both an invocation and its result without an ACTIVE receipt.
    if (event.family !== "tool" || event.phase !== "after" || info.parameters === undefined
      || records.some(r => { const s = object(object(r.payload).step_update); return s.conversation_id === step.conversation_id && s.step_index === step.step_index && s.state === "ACTIVE"; })) return [];
    return [{ ...event, id: `${event.id}:call`, phase: "before" }];
  },
  project(context) {
    const { event, record } = context, payload = object(record.payload), step = object(payload.step_update), info = object(step.tool_info);
    const session = text(step.conversation_id) ?? text(object(payload.result).conversation_id);
    const scope = session ? `session:${session}` : `document:${event.source.nativeReference.artifactId}`;
    const facts: EventFactsV2 = {};
    if (event.family === "message") {
      const user = record.source === "ebo-antigravity-client";
      facts.message = messageFact(user ? "user" : "assistant", user ? true : undefined, user ? "canonical" : "fragment",
        !user && Number.isSafeInteger(step.step_index) ? known({ id: String(step.step_index), scope, identityClass: "source-native" as const }) : unreported);
    }
    if (payload.event === "result") {
      const usage = object(object(payload.result).usage);
      facts.resource = resources({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_tokens, reasoningTokens: usage.thinking_tokens, totalTokens: usage.total_tokens },
      "session", "cumulative-final", session ? known(session) : unreported);
    }
    const clock = recordedClock(context, record.observedAt, "receipt", "ebo-antigravity-recorder");
    if (event.family !== "tool" && event.family !== "delegation") return { facts, clock };
    const endpoint = event.phase === "before" ? "call" : "result";
    const content = event.family === "tool" ? mergeContent(
      info.parameters === undefined ? undefined : pointedContent(context, "/payload/step_update/tool_info/parameters", "tool-input"),
      endpoint === "result" && info.output !== undefined ? pointedContent(context, "/payload/step_update/tool_info/output", "tool-result") : undefined,
      endpoint === "result" && info.error !== undefined ? pointedContent(context, "/payload/step_update/tool_info/error", "tool-error") : undefined) : undefined;
    return { facts, clock, ...(content ? { content } : {}), operation: {
      nativeId: Number.isSafeInteger(step.step_index) ? String(step.step_index) : undefined,
      scope, endpoint, canonical: true, toolName: text(step.tool_name) ?? text(info.name),
      ...(info.parameters === undefined ? {} : { inputDigest: digestValue(info.parameters) }),
      // An output string alone does not establish a successful exit or inference identity.
      failure: endpoint === "result" && Object.keys(object(info.error)).length ? known(true) : unreported,
    } };
  },
};
