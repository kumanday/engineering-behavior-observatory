import { canonicalizeMetadata } from "./artifacts.js";

import { visibleEvidence } from "./exports.js";
export { visibleEvidence } from "./exports.js";

/** Keep scalar metadata (exit codes, cwd, paths) while bounding long output strings. */
export function boundedEvidence(value: unknown, maxChars: number): { content: string; truncated: boolean } {
  const projected = visibleEvidence(value);
  const original = canonicalizeMetadata(projected);
  let content = original;
  let stringLimit = Math.floor(maxChars / 2);
  while (content.length > maxChars && stringLimit >= 64) {
    const bound = (entry: unknown): unknown => typeof entry === "string" && entry.length > stringLimit
      ? ends(entry, stringLimit)
      : Array.isArray(entry) ? entry.map(bound)
      : entry !== null && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, bound(child)])) : entry;
    content = canonicalizeMetadata(bound(projected));
    stringLimit = Math.floor(stringLimit / 2);
  }
  // ponytail: structurally huge records use a marked excerpt; add native paging if needed.
  if (content.length > maxChars) content = ends(original, maxChars);
  return { content, truncated: original.length > maxChars };
}

function ends(text: string, limit: number): string {
  const marker = `...[OMITTED MIDDLE; originalChars=${text.length}]...`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room / 2);
  const tail = room - head;
  return text.slice(0, head) + marker + (tail === 0 ? "" : text.slice(-tail));
}

/** Only explicit native cwd fields establish workspace identity. Relative paths do not. */
export function evidenceWorkspaces(value: unknown): string[] {
  const found = new Set<string>();
  // A tool result is often a JSON document carried as a string (`{"output": ..., "cwd": "/repo"}`); its fields are
  // explicit native fields too, so a string holding a JSON object or array is read as one, a few encodings deep.
  const visit = (entry: unknown, encodings = 0): void => {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (encodings >= 3 || text.length > 1_000_000 || !/^["{[]/u.test(text)) return;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { return; }
      visit(parsed, encodings + 1);
      return;
    }
    if (Array.isArray(entry)) { entry.forEach((child) => visit(child, encodings)); return; }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (["cwd", "workdir", "workingDirectory", "working_directory", "workspaceCwd"].includes(key) && typeof child === "string") found.add(child);
      else visit(child, encodings);
    }
  };
  visit(visibleEvidence(value));
  return [...found].sort();
}
