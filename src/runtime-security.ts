import { RuntimePolicyError } from "./runtime-resolution.js";

export type RuntimeSecurityComponent = { id: string; name: string; version: string; ecosystem?: string; purl?: string };
export type OsvQuery = { version: string; package: { name: string; ecosystem: string } | { purl: string }; page_token?: string };
export type OsvVulnerability = { id: string; aliases?: string[]; summary?: string; withdrawn?: string; [key: string]: unknown };
export type OsvResult = { vulns?: OsvVulnerability[]; next_page_token?: string };
export type RuntimeSecurityReceipt = { components: { id: string; query: OsvQuery; queriedAt: string; results: OsvVulnerability[] }[]; warnings: string[] };
export type RuntimeSecurityOptions = { query?: (query: OsvQuery) => Promise<OsvResult>; now?: () => string };

export async function queryOsv(query: OsvQuery): Promise<OsvResult> {
  const response = await fetch("https://api.osv.dev/v1/query", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(query), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new RuntimePolicyError("RUNTIME_OSV_UNAVAILABLE", `OSV returned HTTP ${response.status}.`);
  return await response.json() as OsvResult;
}
/** Used both at freeze and immediately before each launch. No advisory cache permits execution. */
export async function checkRuntimeSecurity(components: readonly RuntimeSecurityComponent[], options: RuntimeSecurityOptions = {}): Promise<RuntimeSecurityReceipt> {
  const receipt: RuntimeSecurityReceipt = { components: [], warnings: [] };
  for (const component of components) {
    if (!component.id || !component.name || !component.version || !(component.ecosystem || component.purl)) throw new RuntimePolicyError("RUNTIME_OSV_IDENTITY_MISSING", `Cannot query ${component.id}.`);
    const query: OsvQuery = { version: component.version, package: component.ecosystem ? { name: component.name, ecosystem: component.ecosystem } : { purl: component.purl! } };
    const results: OsvVulnerability[] = [], pages = new Set<string>();
    const queriedAt = (options.now ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(queriedAt))) throw new RuntimePolicyError("RUNTIME_CLOCK_INVALID", "Security receipt clock is invalid.");
    let token: string | undefined;
    do {
      const result = await (options.query ?? queryOsv)({ ...query, ...(token ? { page_token: token } : {}) });
      if (!result || typeof result !== "object" || (result.vulns !== undefined && (!Array.isArray(result.vulns) || result.vulns.some((v) => !v || typeof v.id !== "string")))) throw new RuntimePolicyError("RUNTIME_OSV_INVALID", `Malformed OSV response for ${component.id}.`);
      results.push(...(result.vulns ?? []));
      token = result.next_page_token;
      if (token !== undefined && (typeof token !== "string" || pages.has(token) || pages.size >= 100)) throw new RuntimePolicyError("RUNTIME_OSV_INVALID", "Invalid or repeated OSV page token.");
      if (token) pages.add(token);
    } while (token);
    receipt.components.push({ id: component.id, query, queriedAt, results });
  }
  const malicious = receipt.components.flatMap((component) => component.results.filter((v) => !v.withdrawn && [v.id, ...(v.aliases ?? [])].some((id) => id.startsWith("MAL-"))).map((v) => `${component.id}:${v.id}`));
  if (malicious.length) throw new RuntimePolicyError("RUNTIME_MALICIOUS", malicious.join(", "));
  for (const component of receipt.components) for (const vulnerability of component.results.filter((v) => !v.withdrawn)) receipt.warnings.push(`RUNTIME_ADVISORY: ${component.id}: ${vulnerability.id}`);
  return receipt;
}
