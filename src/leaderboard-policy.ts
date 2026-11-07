import { parseLeaderboardFact } from "./leaderboard-facts.js";
import { spawn } from "node:child_process";
import { digestBytes, digestMetadata } from "./artifacts.js";

export const LEADERBOARD_PUBLIC_POLICY = {
  id: "harness-leaderboard-public", version: "1.0.0", revision: "c4a8c4cb468aa1b1e8f3e31c002d2272cc090236",
  packageVersion: "0.1.1", files: {
    "__init__.py": "154220e61e92dfb6043d1f2f31c4c189c89b6a71232f3dc7da892b96f86eeb2d",
    "scoring.py": "1b5cfa8d484c162ee9b7efc106aa8032ff29fcccf4dc6d6b078c7489ac7ff438",
    "config.py": "b56abed9b6da360f90eaa8af68f390cd118235e68366f5460c036a7f20504151",
    "data/models.json": "63d627c51940e740d80cb0c0fd2c52869d707229141f3ed21ebf1332ff95067b",
    "data/harnesses.json": "d442b8bb0ef3d784837cb303799b82be02877de82923aee5ce0910e6322ebb2a",
    "data/benchmarks.json": "281a4fceead2303927f9dbf0a4efd25eee6f349f68752b59f18b015c61e71f82",
    "data/responses-bridge.cjs": "385878a44b15206d46117f48e0861ad4c8688626c163672a783fcd4d8108412f",
  },
} as const;
export type LeaderboardPolicyInput = { schemaVersion: "ebo.leaderboard-policy-input/v1"; policyRevision: string;
  historyCompleteness: "complete" | "bounded-subset"; facts: Record<string, unknown>[];
  runs: Record<string, unknown>; invalid: Record<string, unknown> };
export type LeaderboardPolicyRow = { sourceIndex: number; group: string[]; id: string; runId: string; sourceRunId: string;
  outcome: "pass" | "fail" | "infra"; providerExhausted: boolean };
export type LeaderboardPolicyReceipt = { schemaVersion: "ebo.leaderboard-policy-receipt/v1";
  policy: typeof LEADERBOARD_PUBLIC_POLICY; policyDigest: `sha256:${string}`; runtimePolicyDigest: `sha256:${string}`;
  inputDigest: `sha256:${string}`; sourceAuthority: "third-party"; historyCompleteness: "complete" | "bounded-subset";
  population: "retained-complete-source-closure" | "retained-subset-not-full-board";
  status: "available" | "unavailable"; diagnostics: string[]; rows: LeaderboardPolicyRow[]; excludedSourceIndexes: number[] };
const PROGRAM = `import sys,json,pathlib,hashlib,importlib.util
from importlib.metadata import version
try:
 spec=importlib.util.find_spec('hlb')
 if spec is None or version('harness-leaderboard')!='0.1.1': raise ValueError('runtime')
 root=pathlib.Path(next(iter(spec.submodule_search_locations)))
 expected=${JSON.stringify(LEADERBOARD_PUBLIC_POLICY.files)}
 if any(hashlib.sha256((root/p).read_bytes()).hexdigest()!=digest for p,digest in expected.items()): raise ValueError('runtime')
except Exception:
 print(json.dumps({'status':'unavailable','diagnostics':['LEADERBOARD_RUNTIME_UNAVAILABLE_OR_UNPINNED'],'rows':[]}));sys.exit(0)
from hlb import scoring
try:
 x=json.load(sys.stdin)
 for record in x['invalid'].values():
  for rule in (record or {}).get('rules',[]):
   if set(rule)-{'harnesses','benchmarks','tasks','trials','outcome','reason'}:raise ValueError('rule')
   if any(not isinstance(rule[k],list) or any(not isinstance(v,str) for v in rule[k]) for k in ('harnesses','benchmarks','tasks','trials') if k in rule):raise ValueError('rule')
 sources={}
 for i,fact in enumerate(x['facts']):sources.setdefault((fact['id'],fact['run_id']),[]).append((i,fact))
 rows=[]
 for group,(facts,price) in scoring.board_facts(x['facts'],x['runs'],x['invalid'],public=True).items():
  for fact in facts:
   matches=[i for i,source in sources.get((fact['id'],fact['run_id']),[]) if all(fact.get(k)==v for k,v in source.items())]
   if not matches: raise ValueError('binding')
   rows.append({'sourceIndex':min(matches),'group':list(group),'id':fact['id'],'runId':fact['run_id'],'sourceRunId':fact.get('reused_from') or fact['run_id'],'outcome':fact['_outcome'],'providerExhausted':bool(fact.get('_provider_exhausted'))})
 rows.sort(key=lambda r:(r['group'],r['id'],r['sourceIndex']))
 print(json.dumps({'status':'available','diagnostics':[],'rows':rows},allow_nan=False))
except Exception:
 print(json.dumps({'status':'unavailable','diagnostics':['LEADERBOARD_SOURCE_OR_RULES_UNSUPPORTED'],'rows':[]}))
`;

/** Calls the installed hash-pinned policy runtime. Imported files cannot provide executable reader code. */
export async function selectPinnedLeaderboardFacts(input: LeaderboardPolicyInput, pythonExecutable = "python3"): Promise<LeaderboardPolicyReceipt> {
  if (input.schemaVersion !== "ebo.leaderboard-policy-input/v1" || input.policyRevision !== LEADERBOARD_PUBLIC_POLICY.revision
      || !["complete", "bounded-subset"].includes(input.historyCompleteness) || !Array.isArray(input.facts) || input.facts.length > 100_000
      || Object.keys(input.runs).length > 4096 || Object.keys(input.invalid).length > 4096
      || input.facts.some((fact) => parseLeaderboardFact(fact) === undefined || fact === null || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact).some((key) => key.startsWith("_")))) throw new Error("Unsupported or unbounded leaderboard policy input.");
  const inputDigest = `sha256:${digestMetadata(input).value}` as const;
  const bytes = Buffer.from(JSON.stringify(input)); if (bytes.length > 32 * 1024 * 1024) throw new Error("Leaderboard policy input exceeds its byte limit.");
  const receipt = { schemaVersion: "ebo.leaderboard-policy-receipt/v1" as const, policy: LEADERBOARD_PUBLIC_POLICY,
    policyDigest: `sha256:${digestMetadata(LEADERBOARD_PUBLIC_POLICY).value}` as const,
    runtimePolicyDigest: `sha256:${digestBytes(Buffer.from(PROGRAM)).value}` as const, inputDigest, sourceAuthority: "third-party" as const,
    historyCompleteness: input.historyCompleteness, population: input.historyCompleteness === "complete" ? "retained-complete-source-closure" as const : "retained-subset-not-full-board" as const };
  const unavailable = (code: string): LeaderboardPolicyReceipt => ({ ...receipt, status: "unavailable", diagnostics: [code], rows: [], excludedSourceIndexes: [] });
  if (input.historyCompleteness === "complete") {
    const hasRun = (id: unknown) => {
      if (typeof id !== "string" || !Object.hasOwn(input.runs, id)) return false;
      const run = input.runs[id];
      return run !== null && typeof run === "object" && !Array.isArray(run) && (run as Record<string, unknown>).run_id === id;
    };
    const key = (run: unknown, id: unknown) => JSON.stringify([run, id]);
    const parents = new Map<string, string | null>();
    for (const fact of input.facts) {
      if (!hasRun(fact.run_id) || fact.reused_from !== null && fact.reused_from !== undefined && !hasRun(fact.reused_from)) return unavailable("LEADERBOARD_RUN_OR_REUSE_CONTEXT_UNAVAILABLE");
      const own = key(fact.run_id, fact.id), parent = typeof fact.reused_from === "string" ? key(fact.reused_from, fact.id) : null;
      if (parents.has(own) && parents.get(own) !== parent) return unavailable("LEADERBOARD_RUN_OR_REUSE_CONTEXT_UNAVAILABLE");
      parents.set(own, parent);
    }
    const complete = new Set<string>();
    for (const own of parents.keys()) {
      let current: string | null = own; const visiting = new Set<string>();
      while (current !== null && !complete.has(current)) {
        if (!parents.has(current) || visiting.has(current)) return unavailable("LEADERBOARD_RUN_OR_REUSE_CONTEXT_UNAVAILABLE");
        visiting.add(current); current = parents.get(current)!;
      }
      for (const item of visiting) complete.add(item);
    }
  }
  return new Promise((complete) => {
    const child = spawn(pythonExecutable, ["-I", "-c", PROGRAM], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let total = 0, done = false;
    const finish = (value: LeaderboardPolicyReceipt) => { if (done) return; done = true; clearTimeout(timer); complete(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(unavailable("LEADERBOARD_POLICY_TIMEOUT")); }, 15_000);
    child.on("error", () => finish(unavailable("LEADERBOARD_RUNTIME_UNAVAILABLE"))); child.stdin.on("error", () => {}); child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => { total += chunk.length;
      if (total > 16 * 1024 * 1024) { child.kill("SIGKILL"); finish(unavailable("LEADERBOARD_POLICY_OUTPUT_LIMIT")); } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) { finish(unavailable("LEADERBOARD_POLICY_FAILED")); return; }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status: string; diagnostics: string[]; rows: LeaderboardPolicyRow[] };
        if (value.status === "unavailable") { finish(unavailable(value.diagnostics[0] === "LEADERBOARD_SOURCE_OR_RULES_UNSUPPORTED" ? value.diagnostics[0] : "LEADERBOARD_RUNTIME_UNAVAILABLE_OR_UNPINNED")); return; }
        if (value.status !== "available" || !Array.isArray(value.rows) || value.rows.length > input.facts.length) throw new Error("Invalid policy receipt.");
        for (const row of value.rows) {
          const fact = input.facts[row.sourceIndex];
          if (!Number.isSafeInteger(row.sourceIndex) || !fact || row.id !== fact.id || row.runId !== fact.run_id || row.sourceRunId !== (fact.reused_from || fact.run_id)
              || !Array.isArray(row.group) || row.group.length !== 4 || !row.group.every((part) => typeof part === "string")
              || !["pass", "fail", "infra"].includes(row.outcome) || typeof row.providerExhausted !== "boolean") throw new Error("Stale policy receipt.");
        }
        const selected = new Set(value.rows.map(({ sourceIndex }) => sourceIndex));
        finish({ ...receipt, status: "available", diagnostics: [], rows: value.rows,
          excludedSourceIndexes: input.facts.flatMap((_, index) => selected.has(index) ? [] : [index]) });
      } catch { finish(unavailable("LEADERBOARD_POLICY_INVALID_RECEIPT")); }
    });
    child.stdin.end(bytes);
  });
}
