import { contextFact, digestValue, known, messageFact, object, pointedContent, recordedClock, resultFailure, text, unreported, type NativeProjectionProfile, type ProjectionContext } from "../projection-v2.js";
import type { EventFactsV2 } from "../normalization-v2.js";
const actions = new WeakMap<ProjectionContext["records"], Map<string, Record<string, unknown>>>();
function action(context: ProjectionContext, actionId: string | undefined): Record<string, unknown> | undefined {
  if (!actionId) return undefined;
  let lookup = actions.get(context.records);
  if (!lookup) {
    lookup = new Map();
    for (const record of context.records) { const native = object(record.payload);
      if (native.kind === "ActionEvent" && text(native.id)) lookup.set(JSON.stringify([record.session_id, native.id]), native);
    }
    actions.set(context.records, lookup);
  }
  return lookup.get(JSON.stringify([context.record.session_id, actionId]));
}
export const openHandsV2Profile: NativeProjectionProfile = {
  id: "ebo.openhands-native-v2", version: "2.0.0", harness: "openhands-agent-server", module: "v2-profiles/openhands.js",
  project(context) {
    const { event, record } = context, native = object(record.payload), type = text(native.kind), facts: EventFactsV2 = {};
    const session = text(record.session_id), scope = session ? `conversation:${session}` : `document:${event.source.nativeReference.artifactId}`;
    if (event.family === "message") facts.message = messageFact(type === "SystemPromptEvent" ? "system" : object(native.llm_message).role, true, "canonical",
      text(native.id) ? known({ id: text(native.id)!, scope, identityClass: "source-native" }) : unreported);
    if (event.family === "context") facts.context = contextFact(["CondensationRequest", "Condensation", "CondensationSummaryEvent"].includes(type ?? "") ? "summarization" : "other");
    const clock = recordedClock(context, native.timestamp, "producer-observation", `openhands/${scope}`);
    if (event.family !== "tool") return { facts, clock };
    const call = type === "ActionEvent", related = action(context, text(native.action_id));
    const nativeId = text(native.tool_call_id) ?? text(related?.tool_call_id) ?? (call ? text(native.id) : text(native.action_id));
    const observation = object(native.observation);
    const failure = type === "AgentErrorEvent" || type === "UserRejectObservation" ? known(true) : resultFailure(observation.is_error, observation.exit_code);
    const content = call && native.action !== undefined ? pointedContent(context, "/payload/action", "tool-input")
      : !call && native.observation !== undefined ? pointedContent(context, "/payload/observation", "tool-result") : undefined;
    return { facts, clock, ...(content ? { content } : {}), operation: { nativeId, scope, endpoint: call ? "call" : "result", canonical: true,
      toolName: text(native.tool_name) ?? text(related?.tool_name), ...(native.action === undefined ? {} : { inputDigest: digestValue(native.action) }),
      failure: call ? unreported : failure,
      issuingInference: text(native.llm_response_id) ? known({ id: text(native.llm_response_id)!, scope, identityClass: "declared-single-inference" }) : unreported } };
  },
};
