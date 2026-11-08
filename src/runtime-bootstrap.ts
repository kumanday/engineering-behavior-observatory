import { isAbsolute } from "node:path";
import type { RuntimeCommandRunner } from "./runtime-installation.js";
import { RuntimePolicyError } from "./runtime-resolution.js";

export type PythonBootstrap = { schemaVersion: "ebo.python-bootstrap/v1"; executable: string; version: string;
  abi: string; platform: string; architecture: string; binaryIntegrity: string };
const identityScript = String.raw`import hashlib,json,os,platform,sys,sysconfig,base64
executable=os.path.realpath(sys.executable)
with open(executable,'rb') as source: digest=hashlib.file_digest(source,'sha256').digest()
machine=platform.machine().lower()
print(json.dumps(dict(schemaVersion='ebo.python-bootstrap/v1',executable=executable,version=platform.python_version(),abi=sysconfig.get_config_var('SOABI') or sys.implementation.cache_tag,platform=sys.platform,architecture={'x86_64':'x64','aarch64':'arm64'}.get(machine,machine),binaryIntegrity='sha256-'+base64.b64encode(digest).decode())))
`;
export async function probePythonBootstrap(python: string, run: RuntimeCommandRunner, cwd: string): Promise<PythonBootstrap> {
  const result = await run(python, ["-I", "-B", "-c", identityScript], cwd);
  if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_PYTHON_PROBE_FAILED", `${python}: ${result.stderr.slice(0, 2000)}`);
  let value: PythonBootstrap;
  try { value = JSON.parse(result.stdout); } catch { throw new RuntimePolicyError("RUNTIME_PYTHON_PROBE_INVALID", "Python identity probe returned malformed JSON."); }
  if (value?.schemaVersion !== "ebo.python-bootstrap/v1" || ![value.executable, value.version, value.abi, value.platform, value.architecture].every((item) => typeof item === "string" && item.length > 0) || !isAbsolute(value.executable) || !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(value.binaryIntegrity)) throw new RuntimePolicyError("RUNTIME_PYTHON_PROBE_INVALID", "Python identity probe lacks an exact interpreter identity.");
  return value;
}
export function assertPythonTarget(actual: PythonBootstrap, target: string, abi?: string): void {
  if (`${actual.platform}-${actual.architecture}` !== target) throw new RuntimePolicyError("RUNTIME_PLATFORM_MISMATCH", `Python is ${actual.platform}-${actual.architecture}; the requested runtime is ${target}. Resolve Python runtimes on their execution host.`);
  if (abi && actual.abi !== abi) throw new RuntimePolicyError("RUNTIME_ABI_MISMATCH", `Python ABI is ${actual.abi}; expected ${abi}.`);
}
export function assertPythonIdentity(actual: PythonBootstrap, frozen: PythonBootstrap, executableMayMove = false): void {
  for (const key of ["version", "abi", "platform", "architecture", "binaryIntegrity", ...(!executableMayMove ? ["executable" as const] : [])] as const) {
    if (actual[key] !== frozen[key]) throw new RuntimePolicyError("RUNTIME_PYTHON_BOOTSTRAP_MISMATCH", `Python ${key} changed: expected ${frozen[key]}; actual ${actual[key]}.`);
  }
}
