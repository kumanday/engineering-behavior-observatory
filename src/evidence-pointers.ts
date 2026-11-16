import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";
import type { CapturedNativeRecord, NativeEvidenceReference, NativeEvidenceResolution, NativeEvidenceResolver } from "./uniform-events.js";

export type PointerValue = { found: true; value: unknown } | { found: false };

/** EBO's raw JSON-pointer locator convention. Percent characters are literal, not URI escapes. */
export function readEvidencePointer(document: unknown, locator: string): PointerValue {
  if (locator === "#") return { found: true, value: document };
  if (!locator.startsWith("#/")) return { found: false };
  let current = document;
  for (const encoded of locator.slice(2).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return { found: false };
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) return { found: false };
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property === undefined || !("value" in property)) return { found: false };
      current = property.value;
    } else {
      if (current === null || typeof current !== "object") return { found: false };
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property === undefined || !("value" in property)) return { found: false };
      current = property.value;
    }
  }
  return { found: true, value: current };
}

type Entry = { reference: NativeEvidenceReference; value: unknown; digest: `sha256:${string}` };
export type PointedEvidence = {
  value: unknown;
  /** Longest retained pointer record containing the requested value. */
  containingReference: NativeEvidenceReference;
  containingDigest: `sha256:${string}`;
  /** Canonical requested value, distinct from both the containing record and the file's raw-byte digest. */
  pointedDigest: `sha256:${string}`;
};

/** Ephemeral resolver over retained pointer records; it does not introduce another evidence store. */
export function createPointerEvidenceResolver(input: {
  runId: string; attemptId: string; records: readonly CapturedNativeRecord<unknown>[];
}): NativeEvidenceResolver & { read(reference: NativeEvidenceReference): PointedEvidence | undefined } {
  const records = new Map<string, Entry>();
  for (const { reference, record } of input.records) {
    if (!validLocator(reference.recordLocator)) throw new Error("Pointer evidence records require valid # JSON-pointer locators.");
    const key = referenceKey(reference);
    if (records.has(key)) throw new Error("Pointer evidence contains duplicate record references.");
    assertJsonData(record);
    const value = structuredClone(record);
    records.set(key, { reference: { ...reference }, value, digest: digest(value) });
  }
  const containing = (reference: NativeEvidenceReference, strict = false): Entry | undefined => {
    if (!validLocator(reference.recordLocator)) return undefined;
    let locator = strict ? parentLocator(reference.recordLocator) : reference.recordLocator;
    while (locator !== undefined) {
      const entry = records.get(referenceKey({ artifactId: reference.artifactId, recordLocator: locator }));
      if (entry !== undefined) return entry;
      locator = parentLocator(locator);
    }
    return undefined;
  };
  // Redundant nested records must describe the same bytes-as-JSON value, regardless of insertion order.
  for (const entry of records.values()) {
    const parent = containing(entry.reference, true);
    if (parent === undefined) continue;
    const value = readEvidencePointer(parent.value, relativePointer(parent.reference.recordLocator, entry.reference.recordLocator));
    if (!value.found || canonicalizeMetadata(value.value) !== canonicalizeMetadata(entry.value)) {
      throw new Error("Nested pointer evidence conflicts with its retained containing record.");
    }
  }
  const read = (reference: NativeEvidenceReference): PointedEvidence | undefined => {
    const parent = containing(reference);
    if (parent === undefined) return undefined;
    const result = readEvidencePointer(parent.value, relativePointer(parent.reference.recordLocator, reference.recordLocator));
    if (!result.found) return undefined;
    return { value: structuredClone(result.value), containingReference: { ...parent.reference },
      containingDigest: parent.digest, pointedDigest: digest(result.value) };
  };
  return {
    read,
    resolve(reference): NativeEvidenceResolution | false {
      const result = read(reference);
      return result === undefined ? false : { runId: input.runId, attemptId: input.attemptId, digest: result.pointedDigest };
    },
  };
}

function validLocator(locator: string): boolean {
  return (locator === "#" || locator.startsWith("#/")) && !/~(?:[^01]|$)/u.test(locator);
}
function parentLocator(locator: string): string | undefined {
  if (locator === "#") return undefined;
  const slash = locator.lastIndexOf("/");
  return slash <= 1 ? "#" : locator.slice(0, slash);
}
function relativePointer(parent: string, child: string): string { return `#${child.slice(parent.length)}`; }
function referenceKey(reference: NativeEvidenceReference): string { return JSON.stringify([reference.artifactId, reference.recordLocator]); }
function digest(value: unknown): `sha256:${string}` { return `sha256:${digestMetadata(value).value}`; }

/** Validate data descriptors before cloning, which would otherwise evaluate enumerable getters. */
function assertJsonData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || depth > 128) throw new Error("Pointer records require bounded JSON data.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype
    || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error("Pointer records require plain, acyclic JSON data.");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const property = descriptors[String(index)];
        if (property === undefined || !("value" in property) || !property.enumerable) throw new Error("Pointer records require dense arrays with own data properties.");
        assertJsonData(property.value, ancestors, depth + 1);
      }
      if (Object.keys(descriptors).some((key) => key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
        throw new Error("Pointer arrays cannot contain non-JSON properties.");
      }
    } else for (const property of Object.values(descriptors)) {
      if (!("value" in property) || !property.enumerable) throw new Error("Pointer records require enumerable data properties, without accessors.");
      assertJsonData(property.value, ancestors, depth + 1);
    }
  } finally { ancestors.delete(value); }
}
