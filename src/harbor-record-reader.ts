import { spawn } from "node:child_process";
import { assertNoDuplicateJsonKeys, digestBytes } from "./artifacts.js";

export type HarborTrialValidation = { status: "valid" | "invalid" | "unavailable"; version: string; validator?: "ebo"; harborCrossCheck?: Omit<HarborTrialValidation, "harborCrossCheck" | "validator">;
  modelDigest?: `sha256:${string}`; policyDigest: `sha256:${string}`; diagnostics: Array<{ code: string; pointer: string }> };
const VALIDATOR = `import sys,json,hashlib,pathlib
from importlib.metadata import version
installed_version=version('harbor')
import harbor.models as models
from harbor.models.trial.result import TrialResult
root=pathlib.Path(next(iter(models.__path__)))
files=[(p.relative_to(root).as_posix(),p.read_text()) for p in sorted(root.rglob('*.py'))]
model_digest='sha256:'+hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
try:
 TrialResult.model_validate_json(sys.stdin.read().removeprefix(chr(0xfeff)))
 print(json.dumps({'status':'valid','version':installed_version,'modelDigest':model_digest,'diagnostics':[]}))
except Exception as error:
 errors=error.errors(include_input=False,include_context=False,include_url=False) if hasattr(error,'errors') else []
 diagnostics=[]
 for error in errors[:32]:
  pointer='#/'+'/'.join(str(x).replace('~','~0').replace('/','~1') for x in error['loc'])
  diagnostics.append({'code':'HARBOR_TRIAL_RECORD_INVALID','pointer':pointer if len(pointer.encode())<=512 else '#'})
 print(json.dumps({'status':'invalid','version':installed_version,'modelDigest':model_digest,'diagnostics':diagnostics or [{'code':'HARBOR_TRIAL_RECORD_INVALID','pointer':'#'}]}))
`;

/** Independent pinned model validation. Source bytes are stdin data, never executable code or import paths. */
async function crossCheckHarborTrialBytes(bytes: Uint8Array, python: string): Promise<HarborTrialValidation> {
  const policyDigest = `sha256:${digestBytes(Buffer.from(VALIDATOR)).value}` as const;
  const unavailable = (code: string): HarborTrialValidation => ({ status: "unavailable", version: "unknown", policyDigest, diagnostics: [{ code, pointer: "#" }] });
  if (bytes.length > 4 * 1024 * 1024) return unavailable("HARBOR_TRIAL_RECORD_BYTE_LIMIT");
  return new Promise((complete) => {
    const child = spawn(python, ["-I", "-c", VALIDATOR], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0, finished = false;
    const finish = (value: HarborTrialValidation) => { if (finished) return; finished = true; clearTimeout(timer); complete(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(unavailable("HARBOR_TRIAL_VALIDATION_TIMEOUT")); }, 15_000);
    child.on("error", () => finish(unavailable("HARBOR_TRIAL_VALIDATOR_UNAVAILABLE")));
    child.stdin.on("error", () => {}); child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length;
      if (size > 64 * 1024) { child.kill("SIGKILL"); finish(unavailable("HARBOR_TRIAL_VALIDATOR_OUTPUT_LIMIT")); } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) { finish(unavailable("HARBOR_TRIAL_VALIDATOR_UNAVAILABLE")); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (!["valid", "invalid", "unavailable"].includes(String(value.status)) || !Array.isArray(value.diagnostics)
            || value.status !== "unavailable" && (typeof value.modelDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.modelDigest))) throw new Error("Invalid validator receipt.");
        finish({ ...value, version: typeof value.version === "string" ? value.version : "unknown", policyDigest } as HarborTrialValidation);
      } catch { finish(unavailable("HARBOR_TRIAL_VALIDATOR_INVALID_RECEIPT")); }
    });
    child.stdin.end(bytes);
  });
}

/** EBO validates only the retained TrialResult fields it uses. Installed Harbor is an optional independent cross-check. */
export async function validateHarborTrialBytes(bytes: Uint8Array, python?: string): Promise<HarborTrialValidation> {
  const policyDigest = `sha256:${digestBytes(Buffer.from(validateTrialFields.toString())).value}` as const;
  let diagnostics: HarborTrialValidation["diagnostics"];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text);
    diagnostics = validateTrialFields(JSON.parse(text));
  } catch { diagnostics = [{ code: "EBO_TRIAL_JSON_INVALID", pointer: "#" }]; }
  const result: HarborTrialValidation = { status: diagnostics.length ? "invalid" : "valid", validator: "ebo", version: "2.0.0", modelDigest: policyDigest, policyDigest, diagnostics };
  if (python !== undefined) result.harborCrossCheck = await crossCheckHarborTrialBytes(bytes, python);
  return result;
}
function validateTrialFields(value: unknown): HarborTrialValidation["diagnostics"] {
  const diagnostics: HarborTrialValidation["diagnostics"] = [];
  const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  const issue = (pointer: string) => diagnostics.push({ code: "EBO_TRIAL_FIELD_INVALID", pointer });
  if (!object(value)) return [{ code: "EBO_TRIAL_OBJECT_REQUIRED", pointer: "#" }];
  if (typeof value.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value.id)) issue("#/id");
  if (typeof value.task_name !== "string" || !value.task_name.trim()) issue("#/task_name");
  if (typeof value.task_checksum !== "string" || !/^[a-f0-9]{64}$/iu.test(value.task_checksum)) issue("#/task_checksum");
  if (!object(value.config) || !object(value.config.agent)) issue("#/config/agent");
  if (!object(value.agent_info) || typeof value.agent_info.name !== "string" || typeof value.agent_info.version !== "string") issue("#/agent_info");
  for (const key of ["started_at", "finished_at"]) if (value[key] != null && (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))) issue(`#/${key}`);
  if (value.task_id != null && (!object(value.task_id) || typeof value.task_id.path !== "string")) issue("#/task_id");
  if (value.exception_info != null && (!object(value.exception_info) || typeof value.exception_info.exception_type !== "string")) issue("#/exception_info");
  if (value.verifier_result != null) {
    const rewards = object(value.verifier_result) ? value.verifier_result.rewards : undefined;
    if (rewards != null && (!object(rewards) || Object.values(rewards).some((v) => typeof v !== "number" || !Number.isFinite(v)))) issue("#/verifier_result/rewards");
  }
  return diagnostics;
}
