import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { inspectAtifBytes } from "./atif-reader.js";
import { sanitizeDerivedExport, type PortableExportPolicy } from "./exports.js";
import { object, text } from "./projection-v2.js";

/** A lossy, source-specific ATIF derivative; the owned native bundle remains authoritative. */
export async function exportAntigravityAtif(bundleRoot: string, policy: PortableExportPolicy): Promise<Record<string, unknown>> {
  const retained = await createRetainedBehaviorEvidenceV2(bundleRoot);
  const manifest = JSON.parse(await readFile(join(bundleRoot, "manifest.json"), "utf8"));
  if (manifest.run.harness.id !== "antigravity-cli") throw new Error("ATIF derivative requires an Antigravity bundle.");
  const records = retained.capture.records.map(({ record }) => object(record));
  const steps: Record<string, unknown>[] = [];
  const add = (value: Record<string, unknown>) => steps.push({step_id: steps.length + 1, ...value});
  const input = records.find(r => r.source === "ebo-antigravity-client" && r.kind === "request");
  const prompt = text(object(object(input?.payload).message).content);
  if (prompt) add({source: "user", message: prompt});
  const groups = new Map<number, Record<string, unknown>[]>();
  for (const record of records) {
    const payload = object(record.payload), step = object(payload.step_update);
    if (record.kind !== "frame" || payload.event !== "step_update" || !Number.isSafeInteger(step.step_index)) continue;
    const index = Number(step.step_index); groups.set(index, [...groups.get(index) ?? [], step]);
  }
  for (const [index, snapshots] of [...groups].sort(([a], [b]) => a - b)) {
    const last = snapshots.at(-1)!;
    if (last.step_type === "agent_response") {
      let done = false;
      const message = snapshots.flatMap(s => {
        if (done) return [];
        if (s.state === "DONE") done = true;
        return typeof s.text_delta === "string" ? [s.text_delta] : [];
      }).join("");
      if (message) add({source: "agent", message});
    } else if (last.step_type === "tool" && !last.subagent_info) {
      const info = snapshots.map(s => object(s.tool_info)).find(i => i.parameters !== undefined);
      const name = text(last.tool_name) ?? text(info?.name);
      if (!info || !name || !info.parameters || typeof info.parameters !== "object" || Array.isArray(info.parameters)) continue;
      const output = snapshots.filter(s => s.state === "DONE").map(s => object(s.tool_info)).find(i => i.output !== undefined);
      add({source: "agent", message: "", tool_calls: [{tool_call_id: `step-${index}`, function_name: name, arguments: info.parameters}],
        ...(output ? {observation: {results: [{source_call_id: `step-${index}`, content: typeof output.output === "string" ? output.output : JSON.stringify(output.output)}]}} : {})});
    }
  }
  const document = sanitizeDerivedExport({schema_version: "ATIF-v1.8", agent: {name: "antigravity-cli", version: manifest.run.harness.version}, steps,
    notes: "EBO stream-json derivative. Private reasoning, subagent histories, model-request identities and token-accounting conversion are omitted; native evidence remains authoritative."}, policy) as Record<string, unknown>;
  const inspection = inspectAtifBytes(Buffer.from(JSON.stringify(document))).inspection;
  if (inspection.structural.status !== "valid") throw new Error("Antigravity ATIF derivative failed structural admission.");
  return document;
}
