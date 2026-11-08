import { isAtifImportSchema } from "./atif-import.js";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { assertNoDuplicateJsonKeys, validateArtifact } from "./artifacts.js";
import { readBoundedFile } from "./scheduler.js";
import { createRetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { readImportedBehaviorEvidenceV2 } from "./atif-v2.js";
import { buildAtlasViewV2, writeAtlasViewV2 } from "./atlas-v2.js";
import { prepareOccurrenceRatingInputsV2 } from "./ratings-v2.js";
import { prepareSemanticJudgeInputV2, type JudgeRequestV2 } from "./semantic-judge-v2.js";
export async function loadRetainedAnalysisV2(bundleRoot: string) {
  const manifest = JSON.parse(readBoundedFile(join(bundleRoot, "manifest.json"), "V2 manifest").toString("utf8")) as { schemaVersion?: string };
  return isAtifImportSchema(manifest.schemaVersion) ? readImportedBehaviorEvidenceV2(bundleRoot) : createRetainedBehaviorEvidenceV2(bundleRoot);
}
export async function runAnalysisV2Command(args: string[], write: (text: string) => void): Promise<number> {
  const [command, bundleRoot, destination, requestPath] = args;
  if (!["inspect", "prepare-judge"].includes(command ?? "") || !bundleRoot || !destination || args.length !== (command === "prepare-judge" ? 4 : 3)) {
    write("Usage: ebo v2 inspect <retained-bundle> <new-directory> | ebo v2 prepare-judge <retained-bundle> <new-directory> <request.json>\n"); return 1;
  }
  try {
    const evidence = await loadRetainedAnalysisV2(resolve(bundleRoot)), view = await buildAtlasViewV2(evidence);
    const ratingInputs = await prepareOccurrenceRatingInputsV2(evidence, view.ledger);
    let judgeInput;
    if (command === "prepare-judge") {
      const text = readBoundedFile(resolve(requestPath!), "V2 judge request", undefined, 1024 * 1024).toString("utf8"); assertNoDuplicateJsonKeys(text);
      const request = JSON.parse(text) as JudgeRequestV2;
      const errors = validateArtifact("V2 judge request", request); if (errors.length) throw new Error(errors[0]!.message);
      judgeInput = await prepareSemanticJudgeInputV2(evidence, view.observations, view.ledger, request);
    }
    const target = resolve(destination); writeAtlasViewV2(view, target);
    const retain = (name: string, value: unknown) => writeFileSync(join(target, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    retain("dataset.json", evidence.dataset); retain("observations.json", view.observations); retain("ledger.json", view.ledger);
    mkdirSync(join(target, "rating-inputs"), { mode: 0o700 });
    ratingInputs.forEach((input, index) => retain(`rating-inputs/${index + 1}.json`, input));
    if (judgeInput) retain("judge-input.json", judgeInput);
    write(`Prepared ${view.units.length} v2 units and ${ratingInputs.length} rating inputs in ${target}. No inference dispatched.\n`); return 0;
  } catch (error) { write(`${error instanceof Error ? error.message : "V2 analysis failed"}\n`); return 1; }
}
