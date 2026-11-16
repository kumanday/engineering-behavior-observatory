import type { RetainedBehaviorEvidence } from "./retained-evidence.js";
import type { CapturedNativeRecord } from "./uniform-events.js";
import { object, text } from "./projection-v2.js";

/** Only producer-owned model fields enter this inventory; candidate tool payloads are never traversed. */
export function nativeModelAliasesV2(evidence: RetainedBehaviorEvidence, records: readonly CapturedNativeRecord<unknown>[], harness: string,
  declared: readonly string[] = []): string[] {
  const aliases = new Set<string>([...declared, ...evidence.modelAliases ?? []]);
  const add = (value: unknown) => { const id = text(value) ?? text(object(value).id); if (id) aliases.add(id); };
  for (const event of evidence.dataset.events) {
    add(event.attributes.model); add(event.attributes.requestedModel);
    if (harness === "pi-sdk" && event.actor.kind === "model") add(event.actor.id);
  }
  for (const { record: value } of records) {
    const record = object(value), payload = object(record.payload), message = object(record.message ?? payload.message);
    switch (harness) {
      case "pi-sdk":
        if (message.role === "assistant") add(message.model);
        if (record.type === "model_change") { add(record.model); add(record.modelId); }
        if (record.nativeType === "session_created") add(object(payload.model).model ?? payload.model);
        break;
      case "claude-agent-sdk":
        if (message.type === "assistant") add(object(message.message).model);
        if (message.type === "system" && message.subtype === "init") add(message.model);
        if (message.type === "result") Object.keys(object(message.modelUsage)).forEach(add);
        add(object(record.nativePayload).requested_model);
        break;
      case "codex-app-server":
        if (record.method === "model/rerouted") { add(payload.fromModel); add(payload.toModel); }
        if (/^(?:thread|turn)\/(?:start|resume|fork|read)$/u.test(String(record.method))) {
          add(payload.model); add(object(payload.params).model); add(object(payload.result).model);
        }
        break;
      case "factory-droid": {
        if (record.kind !== "capability" || record.capability !== "runtime-composition") break;
        const selection = object(object(record.evidence).modelSelection); add(selection.model); add(selection.nativeModelId); break;
      }
      case "cursor-sdk":
        if (["agent-created", "run-created", "configuration"].includes(String(record.nativeType))) add(payload.model);
        if (message.type === "result" || message.type === "usage") add(message.model);
        break;
      case "deepseek-harness": {
        const event = object(payload.event), data = object(event.data);
        if (event.type === "assistant/message") { const message = object(data.message); add(message.model); add(object(message.source).model); }
        break;
      }
      case "devin-cli": add(object(payload.models).currentModelId); break;
    }
  }
  return [...aliases].filter((value) => typeof value === "string" && value.trim()).sort();
}
