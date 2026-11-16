var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// src/contracts.ts
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
function resolveBundleArtifact(bundleRoot, reference, maxBytes, rootHandle) {
  const root = rootHandle ?? openBundleRoot(bundleRoot);
  const ownsRoot = rootHandle === void 0;
  try {
    return readVerifiedBundleFile(
      openBundleRegularFile(bundleRoot, reference.locator, "Artifact locator", root),
      reference,
      "Artifact",
      maxBytes,
      root,
      bundleRoot
    );
  } finally {
    if (ownsRoot) closeBundleRoot(root);
  }
}
function openBundleRoot(bundleRoot) {
  const path = realpathSync(bundleRoot);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const root = { path, descriptor };
  try {
    assertBundleRootHandle(root, bundleRoot, "bundle root");
    return root;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
function closeBundleRoot(root) {
  closeSync(root.descriptor);
}
function readVerifiedBundleFile(descriptor, reference, label, maxBytes, root, bundleRoot) {
  try {
    const opened = fstatSync(descriptor);
    const openedTimes = fstatSync(descriptor, { bigint: true });
    const size = opened.size;
    if (!opened.isFile() || !isReadableBundleFile(root === void 0 ? void 0 : resolve(root.path, reference.locator), opened) || !Number.isSafeInteger(size) || size < 0 || maxBytes !== void 0 && size > maxBytes) {
      throw new Error(`${label} exceeds its maximum bytes.`);
    }
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size; ) {
      const read = readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) throw new Error(`${label} changed while it was being read.`);
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, size) !== 0) {
      throw new Error(`${label} changed while it was being read.`);
    }
    const completed = fstatSync(descriptor);
    const completedTimes = fstatSync(descriptor, { bigint: true });
    if (!completed.isFile() || !isReadableBundleFile(root === void 0 ? void 0 : resolve(root.path, reference.locator), completed) || completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== size || completedTimes.mtimeNs !== openedTimes.mtimeNs || completedTimes.ctimeNs !== openedTimes.ctimeNs || maxBytes !== void 0 && completed.size > maxBytes) {
      throw new Error(`${label} changed while it was being read.`);
    }
    if (root !== void 0 && bundleRoot !== void 0) {
      assertBundleRootHandle(root, bundleRoot, reference.locator);
      const current = lstatSync(assertBundlePathWithoutLinks(root.path, reference.locator, `${label} locator`));
      if (current.dev !== completed.dev || current.ino !== completed.ino) {
        throw new Error(`${label} changed after bundle-root verification.`);
      }
    }
    const resolvedDigest = {
      algorithm: "sha256",
      value: createHash("sha256").update(bytes).digest("hex")
    };
    if (reference.digest.algorithm !== resolvedDigest.algorithm || reference.digest.value !== resolvedDigest.value) {
      throw new Error(`${label} digest does not match its source reference.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
function openBundleRegularFile(bundleRoot, locator, label, root) {
  if (!isSafeArtifactRelativePath(locator)) {
    throw new Error(`${label} "${locator}" is unsafe.`);
  }
  assertBundleRootHandle(root, bundleRoot, locator);
  let descriptor;
  const originalCwd = process.cwd();
  let changedCwd = false;
  try {
    process.chdir(root.path);
    changedCwd = true;
    if (!sameFileIdentity(fstatSync(root.descriptor), lstatSync("."))) {
      throw new Error(`${label} "${locator}" bundle root changed during verification.`);
    }
    let currentPath = root.path;
    const segments2 = locator.split("/");
    for (let index = 0; index < segments2.length - 1; index += 1) {
      const segment = segments2[index];
      let childDescriptor;
      try {
        childDescriptor = openSync(segment, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (error.code === "ELOOP") {
          throw new Error(`${label} "${locator}" escapes its declared root.`);
        }
        throw error;
      }
      try {
        const openedDirectory = fstatSync(childDescriptor);
        const namedDirectory = lstatSync(segment);
        if (!openedDirectory.isDirectory() || namedDirectory.isSymbolicLink() || !sameFileIdentity(openedDirectory, namedDirectory)) {
          throw new Error(`${label} "${locator}" crosses a symbolic link.`);
        }
        process.chdir(segment);
        const currentDirectory = lstatSync(".");
        if (!sameFileIdentity(openedDirectory, currentDirectory)) {
          throw new Error(`${label} "${locator}" parent changed during verification.`);
        }
        currentPath = resolve(currentPath, segment);
      } finally {
        closeSync(childDescriptor);
      }
    }
    const leaf = segments2[segments2.length - 1];
    try {
      descriptor = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ELOOP") {
        throw new Error(`${label} "${locator}" escapes its declared root.`);
      }
      throw error;
    }
    let opened = fstatSync(descriptor);
    const current = lstatSync(leaf);
    if (opened.nlink > 1) {
      removeInterruptedPublicationLink(resolve(currentPath, leaf), opened);
      opened = fstatSync(descriptor);
    }
    if (!opened.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current) || !isReadableBundleFile(resolve(currentPath, leaf), opened)) {
      throw new Error(`${label} "${locator}" is not an isolated regular file.`);
    }
    assertBundleRootHandle(root, root.path, locator);
    return descriptor;
  } catch (error) {
    if (descriptor !== void 0) closeSync(descriptor);
    throw error;
  } finally {
    if (changedCwd) process.chdir(originalCwd);
  }
}
function assertBundleRootHandle(root, bundleRoot, locator) {
  let requestedRoot;
  try {
    requestedRoot = realpathSync(bundleRoot);
  } catch {
    throw new Error(`Artifact path "${locator}" bundle root changed during verification.`);
  }
  const opened = fstatSync(root.descriptor);
  const current = lstatSync(root.path);
  if (requestedRoot !== root.path || !opened.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error(`Artifact path "${locator}" bundle root changed during verification.`);
  }
}
function assertBundlePathWithoutLinks(bundleRoot, locator, label) {
  let selectedPath = bundleRoot;
  const segments2 = locator.split("/");
  for (const [index, segment] of segments2.entries()) {
    selectedPath = resolve(selectedPath, segment);
    const entry = lstatSync(selectedPath);
    if (!isContained(bundleRoot, selectedPath) || entry.isSymbolicLink()) {
      throw new Error(`${label} "${locator}" escapes its bundle root.`);
    }
    if (index === segments2.length - 1 && !entry.isFile()) {
      throw new Error(`${label} "${locator}" is not an isolated regular file.`);
    }
  }
  return selectedPath;
}
function isReadableBundleFile(path, target) {
  if (target.nlink !== 1) return false;
  if (path === void 0) return true;
  try {
    const current = lstatSync(path);
    return current.nlink === 1 && current.isFile() && !current.isSymbolicLink() && sameFileIdentity(current, target);
  } catch {
    return false;
  }
}
function removeInterruptedPublicationLink(path, target) {
  for (const name of readdirSync(dirname(path))) {
    if (!/^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(name)) continue;
    const temporaryPath = resolve(dirname(path), name);
    if (temporaryPath === path) continue;
    try {
      const candidate = lstatSync(temporaryPath);
      if (candidate.isFile() && sameFileIdentity(candidate, target)) unlinkSync(temporaryPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function isSafeArtifactRelativePath(path) {
  const segments2 = path.split("/");
  return path === posix.normalize(path) && path.length <= MAX_ARCHIVE_PATH_LENGTH && /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+()\[\]\/-]+$/.test(path) && segments2.length <= MAX_ARCHIVE_PATH_COMPONENTS && !segments2.some((segment) => segment.length > 255 || segment.endsWith(".") || segment.toLowerCase() === ".git" || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
}
function isContained(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || !isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`);
}
var MAX_ARCHIVE_PATH_COMPONENTS, MAX_ARCHIVE_PATH_LENGTH;
var init_contracts = __esm({
  "src/contracts.ts"() {
    MAX_ARCHIVE_PATH_COMPONENTS = 64;
    MAX_ARCHIVE_PATH_LENGTH = 960;
  }
});

// src/artifacts.ts
import { createHash as createHash2, randomUUID } from "node:crypto";
import {
  closeSync as closeSync2,
  constants as constants2,
  fstatSync as fstatSync2,
  fsyncSync,
  linkSync,
  lstatSync as lstatSync2,
  mkdirSync,
  openSync as openSync2,
  readFileSync,
  readSync as readSync2,
  realpathSync as realpathSync2,
  unlinkSync as unlinkSync2,
  writeFileSync
} from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname as dirname2, isAbsolute as isAbsolute2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formats from "ajv-formats";
function canonicalizeMetadata(value) {
  return canonicalJson(value, /* @__PURE__ */ new Set());
}
function digestBytes(bytes) {
  return { algorithm: "sha256", value: createHash2("sha256").update(bytes).digest("hex") };
}
function digestMetadata(metadata) {
  return digestBytes(Buffer.from(canonicalizeMetadata(metadata)));
}
function verifyDigest(bytes, expected) {
  const actual = digestBytes(bytes);
  return expected.algorithm === actual.algorithm && expected.value === actual.value;
}
function assertNoDuplicateJsonKeys(text9) {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(text9[index] ?? "")) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < text9.length) {
      if (text9[index] === "\\") index += 2;
      else if (text9[index++] === '"') return text9.slice(start, index);
    }
    throw new Error("Verifier output contains an unterminated JSON string.");
  };
  const readValue = () => {
    skipWhitespace();
    if (text9[index] === "{") readObject();
    else if (text9[index] === "[") readArray();
    else if (text9[index] === '"') readString();
    else while (index < text9.length && !/[\s,\]}]/.test(text9[index])) index += 1;
  };
  const readObject = () => {
    index += 1;
    skipWhitespace();
    const keys = /* @__PURE__ */ new Set();
    if (text9[index] === "}") {
      index += 1;
      return;
    }
    while (index < text9.length) {
      skipWhitespace();
      const key = JSON.parse(readString());
      if (keys.has(key)) throw new Error("Verifier output contains duplicate JSON object keys.");
      keys.add(key);
      skipWhitespace();
      index += 1;
      readValue();
      skipWhitespace();
      if (text9[index] === "}") {
        index += 1;
        return;
      }
      index += 1;
    }
    throw new Error("Verifier output contains an unterminated JSON object.");
  };
  const readArray = () => {
    index += 1;
    skipWhitespace();
    if (text9[index] === "]") {
      index += 1;
      return;
    }
    while (index < text9.length) {
      readValue();
      skipWhitespace();
      if (text9[index] === "]") {
        index += 1;
        return;
      }
      index += 1;
    }
    throw new Error("Verifier output contains an unterminated JSON array.");
  };
  readValue();
  skipWhitespace();
}
function assertUniqueArtifactIdentities(identities) {
  const ids = /* @__PURE__ */ new Set();
  const paths = /* @__PURE__ */ new Set();
  const ancestorPaths = /* @__PURE__ */ new Set();
  for (const identity of identities) {
    if (identity.id.trim() === "" || ids.has(identity.id)) {
      throw new Error(`Duplicate artifact identity "${identity.id}".`);
    }
    if (!isSafeArtifactRelativePath(identity.relativePath)) {
      throw new Error(`Artifact path "${identity.relativePath}" is unsafe.`);
    }
    const normalizedPath = identity.relativePath.toLowerCase();
    if (paths.has(normalizedPath) || ancestorPaths.has(normalizedPath)) {
      throw new Error(`Artifact path "${identity.relativePath}" collides with another artifact path.`);
    }
    for (let boundary = normalizedPath.lastIndexOf("/"); boundary > 0; boundary = normalizedPath.lastIndexOf("/", boundary - 1)) {
      const ancestor = normalizedPath.slice(0, boundary);
      if (paths.has(ancestor)) {
        throw new Error(`Artifact path "${identity.relativePath}" collides with another artifact path.`);
      }
      ancestorPaths.add(ancestor);
    }
    ids.add(identity.id);
    paths.add(normalizedPath);
  }
}
function validateArtifact(artifact, document) {
  const schemaVersion = schemaVersionOf(document);
  const validate = validators.get(schemaVersion);
  if (validate === void 0) {
    return [{ artifact, schemaVersion, field: "/schemaVersion", message: "Unsupported schema version." }];
  }
  const errors = validate(document) ? [] : (validate.errors ?? []).map((error) => validationError(artifact, schemaVersion, error));
  if (schemaVersion === "run-manifest/v1" && isRecord(document) && Array.isArray(document.evidence)) {
    errors.push(...runManifestIntegrityErrors(artifact, schemaVersion, document));
  }
  if (schemaVersion === "verifier-result/v1" && isRecord(document) && Array.isArray(document.assertions)) {
    const assertionIds = document.assertions.filter((assertion) => isRecord(assertion) && typeof assertion.id === "string").map((assertion) => assertion.id);
    if (new Set(assertionIds).size !== assertionIds.length) {
      errors.push({ artifact, schemaVersion, field: "/assertions", message: "Verifier assertion IDs must be unique." });
    }
    if (Array.isArray(document.diagnostics)) {
      const diagnosticLocators = document.diagnostics.filter((diagnostic) => isRecord(diagnostic) && typeof diagnostic.locator === "string").map((diagnostic) => diagnostic.locator.toLowerCase());
      const diagnosticStreams = document.diagnostics.filter((diagnostic) => isRecord(diagnostic) && typeof diagnostic.stream === "string").map((diagnostic) => diagnostic.stream);
      if (new Set(diagnosticStreams).size !== diagnosticStreams.length) {
        errors.push({ artifact, schemaVersion, field: "/diagnostics", message: "Verifier diagnostic streams must be unique." });
      }
      const seenDiagnosticLocators = /* @__PURE__ */ new Set();
      if (diagnosticLocators.some((locator) => {
        const collision = hasPortablePathCollision(locator, seenDiagnosticLocators);
        seenDiagnosticLocators.add(locator);
        return collision;
      })) {
        errors.push({ artifact, schemaVersion, field: "/diagnostics", message: "Verifier diagnostic locators must be unique and non-overlapping." });
      }
    }
  }
  return errors;
}
function validateRunManifestEvidence(artifact, manifest, bundleRoot) {
  if (!isRecord(manifest) || manifest.schemaVersion !== "run-manifest/v1" || !Array.isArray(manifest.evidence)) return [];
  const errors = [];
  const expectedBundleId = typeof manifest.bundleId === "string" ? manifest.bundleId : void 0;
  const expectedVerifier = isRecord(manifest.run) && isRecord(manifest.run.verifier) ? manifest.run.verifier : void 0;
  const workspaceEvidence = new Map(
    manifest.evidence.filter((entry) => isRecord(entry) && typeof entry.id === "string" && entry.kind === "workspace").map((entry) => [entry.id, entry])
  );
  const verifierOutcomes = [];
  const verifierResults = /* @__PURE__ */ new Map();
  const evidenceByPath = new Map(
    manifest.evidence.filter((entry) => isRecord(entry) && typeof entry.relativePath === "string").map((entry) => [entry.relativePath.toLowerCase(), entry])
  );
  const evidencePaths = new Set(
    manifest.evidence.filter((entry) => isRecord(entry) && typeof entry.relativePath === "string").map((entry) => entry.relativePath.toLowerCase())
  );
  const nestedDiagnosticPaths = /* @__PURE__ */ new Set();
  for (const descriptor of manifest.evidence) {
    if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.relativePath !== "string" || typeof descriptor.digest !== "string" || typeof descriptor.sizeBytes !== "number") continue;
    try {
      const bytes = resolveBundleArtifact(bundleRoot, {
        locator: descriptor.relativePath,
        digest: runDigest(descriptor.digest)
      });
      if (bytes.length !== descriptor.sizeBytes) throw new Error("Artifact size does not match its manifest descriptor.");
      if (descriptor.kind === "verifier") {
        const verifierErrors = nestedVerifierDiagnosticErrors(
          artifact,
          descriptor.id,
          bytes,
          bundleRoot,
          expectedBundleId,
          expectedVerifier,
          workspaceEvidence,
          descriptor.sanitizedFrom !== void 0,
          isRecord(descriptor.sanitizedFrom) && typeof descriptor.sanitizedFrom.artifactId === "string" ? descriptor.sanitizedFrom.artifactId : void 0,
          evidenceByPath,
          evidencePaths,
          nestedDiagnosticPaths
        );
        errors.push(...verifierErrors);
        if (verifierErrors.length === 0) {
          const outcome = nestedVerifierOutcome(bytes);
          if (outcome !== void 0) {
            verifierResults.set(descriptor.id, outcome);
            if (descriptor.sanitizedFrom === void 0) verifierOutcomes.push(outcome);
          }
        }
      }
    } catch (error) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}`,
        message: error instanceof Error ? error.message : "Evidence could not be verified."
      });
    }
  }
  for (const descriptor of manifest.evidence) {
    if (!isRecord(descriptor) || descriptor.kind !== "verifier" || !isRecord(descriptor.sanitizedFrom) || typeof descriptor.id !== "string" || typeof descriptor.sanitizedFrom.artifactId !== "string") continue;
    const source = verifierResults.get(descriptor.sanitizedFrom.artifactId);
    const derivative = verifierResults.get(descriptor.id);
    if (source === void 0 || derivative === void 0) continue;
    if (source.status !== derivative.status) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/status`,
        message: "Sanitized verifier must preserve its source outcome status."
      });
    }
    const sourceAssertions = new Map(source.assertions.map((assertion) => [assertion.id, assertion.status]));
    const derivativeAssertions = new Map(derivative.assertions.map((assertion) => [assertion.id, assertion.status]));
    if (sourceAssertions.size !== derivativeAssertions.size || [...sourceAssertions].some(([id, status]) => derivativeAssertions.get(id) !== status)) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/assertions`,
        message: "Sanitized verifier must preserve source assertion outcomes."
      });
    }
    if (derivative.exitCode !== source.exitCode) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/exitCode`,
        message: "Sanitized verifier must preserve its source exit code."
      });
    }
    const sourceVerifier = source.verifier;
    const derivativeVerifier = derivative.verifier;
    const sameVerifier = sourceVerifier === void 0 ? derivativeVerifier === void 0 : derivativeVerifier !== void 0 && derivativeVerifier.locator === sourceVerifier.locator && derivativeVerifier.digest === sourceVerifier.digest && derivativeVerifier.format === sourceVerifier.format;
    if (!sameVerifier) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/verifier`,
        message: "Sanitized verifier must preserve its source verifier binding."
      });
    }
    if (source.durationMs !== derivative.durationMs) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/durationMs`,
        message: "Sanitized verifier must preserve its source duration."
      });
    }
    const sameError = derivative.errorRedacted === true ? source.status === "error" && derivative.error === "[redacted]" : source.error === derivative.error && source.errorRedacted === derivative.errorRedacted;
    if (!sameError) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/error`,
        message: "Sanitized verifier must preserve or explicitly redact its source error."
      });
    }
    const sourceWorkspace = source.workspace;
    const derivativeWorkspace = derivative.workspace;
    const sameWorkspace = sourceWorkspace === void 0 ? derivativeWorkspace === void 0 : derivativeWorkspace !== void 0 && derivativeWorkspace.artifactId === sourceWorkspace.artifactId && derivativeWorkspace.digest === sourceWorkspace.digest && derivativeWorkspace.fingerprint === sourceWorkspace.fingerprint;
    if (!sameWorkspace) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/workspace`,
        message: "Sanitized verifier must preserve its source workspace binding."
      });
    }
    if (derivative.diagnostics.some((diagnostic) => diagnostic.source === void 0 || !source.diagnostics.some((sourceDiagnostic) => sameDiagnosticOrigin(sourceDiagnostic, diagnostic.source)))) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `/evidence/${escapeJsonPointer(descriptor.id)}/diagnostics`,
        message: "Sanitized verifier diagnostics must identify source diagnostics."
      });
    }
  }
  const terminal = isRecord(manifest.terminal) ? manifest.terminal : void 0;
  const assessmentMode = isRecord(manifest.run) ? manifest.run.assessmentMode ?? "verified" : void 0;
  const terminalWorkspace = typeof terminal?.workspaceArtifactId === "string" ? workspaceEvidence.get(terminal.workspaceArtifactId) : void 0;
  const matchesTerminalWorkspace = (outcome, status) => outcome.status === status && outcome.workspace !== void 0 && terminalWorkspace !== void 0 && outcome.workspace.artifactId === terminalWorkspace.id && outcome.workspace.digest === terminalWorkspace.digest && (outcome.workspace.fingerprint === void 0 ? terminalWorkspace.fingerprint === void 0 : terminalWorkspace.fingerprint !== void 0 && outcome.workspace.fingerprint === terminalWorkspace.fingerprint);
  if (assessmentMode === "verified" && terminal?.state === "completed" && !verifierOutcomes.some((outcome) => matchesTerminalWorkspace(outcome, "passed"))) {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/terminal/state",
      message: "Completed runs require a passed verifier bound to the terminal workspace."
    });
  }
  if (terminal?.state === "failed" && terminal.failureClass === "task" && !verifierOutcomes.some((outcome) => matchesTerminalWorkspace(outcome, "failed"))) {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/terminal/state",
      message: "Task-failed runs require a failed verifier bound to the terminal workspace."
    });
  }
  if (assessmentMode === "observational" && terminal?.failureClass === "task") {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/terminal/failureClass",
      message: "Observational runs cannot claim task failure."
    });
  }
  if (assessmentMode === "observational" && verifierOutcomes.length > 0) {
    errors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: "/evidence",
      message: "Observational runs cannot retain verifier outcome evidence."
    });
  }
  return errors;
}
function isNestedVerifierDiagnostic(value) {
  if (!isRecord(value) || ![5, 6].includes(Object.keys(value).length) || typeof value.stream !== "string" || !["stdout", "stderr"].includes(value.stream) || typeof value.locator !== "string" || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0 || typeof value.truncated !== "boolean") return false;
  return !Object.hasOwn(value, "source") || isNestedVerifierDiagnosticOrigin(value.source);
}
function isNestedVerifierDiagnosticOrigin(value) {
  return isRecord(value) && Object.keys(value).length === 5 && typeof value.stream === "string" && ["stdout", "stderr"].includes(value.stream) && typeof value.locator === "string" && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest) && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 && typeof value.truncated === "boolean";
}
function isDiagnosticSourceBinding(value) {
  return isRecord(value) && Object.keys(value).length === 6 && typeof value.verifierId === "string" && isNestedVerifierDiagnosticOrigin(Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "verifierId")
  ));
}
function sameDiagnosticOrigin(left, right) {
  return left.stream === right.stream && left.locator === right.locator && left.digest === right.digest && left.sizeBytes === right.sizeBytes && left.truncated === right.truncated;
}
function nestedVerifierOutcome(bytes) {
  try {
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(result) || typeof result.status !== "string") return void 0;
    const verifier = isRecord(result.verifier) && typeof result.verifier.locator === "string" && typeof result.verifier.digest === "string" ? {
      locator: result.verifier.locator,
      digest: result.verifier.digest,
      ...typeof result.verifier.format === "string" ? { format: result.verifier.format } : {}
    } : void 0;
    const workspace = isRecord(result.workspace) && typeof result.workspace.artifactId === "string" && typeof result.workspace.digest === "string" ? {
      artifactId: result.workspace.artifactId,
      digest: result.workspace.digest,
      ...typeof result.workspace.fingerprint === "string" ? { fingerprint: result.workspace.fingerprint } : {}
    } : void 0;
    const assertions = Array.isArray(result.assertions) ? result.assertions.flatMap((assertion) => isRecord(assertion) && typeof assertion.id === "string" && typeof assertion.status === "string" ? [{ id: assertion.id, status: assertion.status }] : []) : [];
    const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics.flatMap((diagnostic) => {
      if (!isRecord(diagnostic) || typeof diagnostic.stream !== "string" || typeof diagnostic.locator !== "string" || typeof diagnostic.digest !== "string" || typeof diagnostic.sizeBytes !== "number" || typeof diagnostic.truncated !== "boolean") return [];
      const source = isRecord(diagnostic.source) && typeof diagnostic.source.stream === "string" && typeof diagnostic.source.locator === "string" && typeof diagnostic.source.digest === "string" && typeof diagnostic.source.sizeBytes === "number" && typeof diagnostic.source.truncated === "boolean" ? {
        stream: diagnostic.source.stream,
        locator: diagnostic.source.locator,
        digest: diagnostic.source.digest,
        sizeBytes: diagnostic.source.sizeBytes,
        truncated: diagnostic.source.truncated
      } : void 0;
      return [{
        stream: diagnostic.stream,
        locator: diagnostic.locator,
        digest: diagnostic.digest,
        sizeBytes: diagnostic.sizeBytes,
        truncated: diagnostic.truncated,
        ...source === void 0 ? {} : { source }
      }];
    }) : [];
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : void 0;
    const durationMs = typeof result.durationMs === "number" ? result.durationMs : void 0;
    const error = typeof result.error === "string" ? result.error : void 0;
    const errorRedacted = typeof result.errorRedacted === "boolean" ? result.errorRedacted : void 0;
    return {
      status: result.status,
      ...durationMs === void 0 ? {} : { durationMs },
      ...error === void 0 ? {} : { error },
      ...errorRedacted === void 0 ? {} : { errorRedacted },
      assertions,
      diagnostics,
      ...verifier === void 0 ? {} : { verifier },
      ...workspace === void 0 ? {} : { workspace },
      ...exitCode === void 0 ? {} : { exitCode }
    };
  } catch {
    return void 0;
  }
}
function nestedVerifierDiagnosticErrors(artifact, verifierId, bytes, bundleRoot, expectedBundleId, expectedVerifier, workspaceEvidence, sanitized, sanitizedSourceVerifierId, evidenceByPath, evidencePaths, nestedDiagnosticPaths) {
  const scope = `/evidence/${escapeJsonPointer(verifierId)}`;
  let result;
  try {
    const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result = JSON.parse(text9);
    assertNoDuplicateJsonKeys(text9);
  } catch (error) {
    return [{ artifact, schemaVersion: "run-manifest/v1", field: scope, message: `Verifier artifact could not be parsed: ${error instanceof Error ? error.message : "invalid UTF-8 or JSON."}` }];
  }
  const schemaErrors = validateArtifact(`${artifact}/${verifierId}`, result);
  if (schemaErrors.length > 0) {
    return schemaErrors.map((error) => ({ ...error, artifact, schemaVersion: "run-manifest/v1", field: `${scope}${error.field}` }));
  }
  if (!isRecord(result)) return [];
  const bindingErrors = [];
  if (expectedBundleId !== void 0 && result.bundleId !== expectedBundleId) {
    bindingErrors.push({
      artifact,
      schemaVersion: "run-manifest/v1",
      field: `${scope}/bundleId`,
      message: "Verifier bundleId must match its containing run manifest."
    });
  }
  if (expectedVerifier !== void 0) {
    const actualVerifier = isRecord(result.verifier) ? result.verifier : void 0;
    const expectedFormat = typeof expectedVerifier.format === "string" ? expectedVerifier.format : typeof expectedVerifier.locator === "string" && expectedVerifier.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";
    if (actualVerifier === void 0 || actualVerifier.locator !== expectedVerifier.locator || actualVerifier.digest !== expectedVerifier.digest || actualVerifier.format !== expectedFormat) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/verifier`,
        message: "Verifier execution reference must match the run configuration."
      });
    }
  }
  if (isRecord(result.workspace)) {
    const workspaceArtifactId = result.workspace.artifactId;
    const retainedWorkspace = typeof workspaceArtifactId === "string" ? workspaceEvidence.get(workspaceArtifactId) : void 0;
    if (retainedWorkspace === void 0) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/workspace/artifactId`,
        message: "Verifier workspace must reference retained workspace evidence."
      });
    } else if (retainedWorkspace.digest !== result.workspace.digest || (result.workspace.fingerprint === void 0 ? retainedWorkspace.fingerprint !== void 0 : retainedWorkspace.fingerprint === void 0 || retainedWorkspace.fingerprint !== result.workspace.fingerprint)) {
      bindingErrors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/workspace/digest`,
        message: "Verifier workspace digest must match retained workspace evidence."
      });
    }
  }
  if (result.diagnostics === void 0) return bindingErrors;
  if (!Array.isArray(result.diagnostics)) {
    return [
      ...bindingErrors,
      { artifact, schemaVersion: "run-manifest/v1", field: `${scope}/diagnostics`, message: "Verifier diagnostics must be an array." }
    ];
  }
  const errors = [...bindingErrors];
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (!isNestedVerifierDiagnostic(diagnostic)) {
      errors.push({ artifact, schemaVersion: "run-manifest/v1", field: `${scope}/diagnostics/${index}`, message: "Verifier diagnostic reference is malformed." });
      continue;
    }
    const normalizedLocator = diagnostic.locator.toLowerCase();
    const retainedEvidence = evidenceByPath.get(normalizedLocator);
    const exactSidecar = retainedEvidence !== void 0 && retainedEvidence.relativePath === diagnostic.locator && retainedEvidence.digest === diagnostic.digest && retainedEvidence.sizeBytes === diagnostic.sizeBytes;
    const invalidUnsanitizedReference = !sanitized && diagnostic.source !== void 0;
    const sourceOrigin = diagnostic.source;
    const sourceBinding = retainedEvidence !== void 0 && isDiagnosticSourceBinding(retainedEvidence.diagnosticSource) ? retainedEvidence.diagnosticSource : void 0;
    const sourceBindingMatches = sourceBinding !== void 0 && sourceOrigin !== void 0 && sourceBinding.verifierId === sanitizedSourceVerifierId && sourceBinding.stream === diagnostic.stream && sourceOrigin.stream === diagnostic.stream && sameDiagnosticOrigin(sourceBinding, sourceOrigin);
    const byteIdentical = sanitized && sourceOrigin !== void 0 && diagnostic.digest === sourceOrigin.digest;
    const isSanitizedSidecar = exactSidecar && retainedEvidence.kind === "diagnostic" && retainedEvidence.authority === "outcome" && (retainedEvidence.mediaType === "text/plain" || retainedEvidence.mediaType === "application/octet-stream") && (retainedEvidence.sharingClass === "partner" || retainedEvidence.sharingClass === "public") && isRecord(retainedEvidence.sanitizedFrom) && retainedEvidence.sanitizedFrom.artifactId === sanitizedSourceVerifierId && sourceBindingMatches && !byteIdentical;
    const invalidSanitizedReference = sanitized && !isSanitizedSidecar;
    const aliasesRetainedEvidence = !sanitized && hasPortablePathCollision(normalizedLocator, evidencePaths);
    if (invalidUnsanitizedReference || hasPortablePathCollision(normalizedLocator, RESERVED_MANIFEST_PATHS) || invalidSanitizedReference || aliasesRetainedEvidence || hasPortablePathCollision(normalizedLocator, nestedDiagnosticPaths)) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/diagnostics`,
        message: invalidUnsanitizedReference ? "Unsanitized verifier diagnostics cannot carry source provenance." : invalidSanitizedReference ? "Sanitized verifier diagnostics require classified, source-bound sidecars with changed bytes." : "Verifier diagnostics cannot alias retained evidence paths."
      });
      continue;
    }
    nestedDiagnosticPaths.add(normalizedLocator);
    try {
      const diagnosticBytes = resolveBundleArtifact(bundleRoot, {
        locator: diagnostic.locator,
        digest: runDigest(diagnostic.digest)
      });
      if (diagnosticBytes.length !== diagnostic.sizeBytes) {
        throw new Error("Diagnostic size does not match its result reference.");
      }
    } catch (error) {
      errors.push({
        artifact,
        schemaVersion: "run-manifest/v1",
        field: `${scope}/diagnostics`,
        message: error instanceof Error ? error.message : "Verifier diagnostic could not be verified."
      });
    }
  }
  return errors;
}
function hasPortablePathCollision(path, existingPaths) {
  return [...existingPaths].some((existing) => existing === path || existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`));
}
function validateExportManifest(artifact, exportManifest, containingManifest, bundleRoot) {
  if (!isRecord(exportManifest) || exportManifest.schemaVersion !== "export-manifest/v1" || !["ready", "exported"].includes(String(exportManifest.status))) return [];
  if (!isRecord(containingManifest) || containingManifest.schemaVersion !== "run-manifest/v1" || !Array.isArray(containingManifest.evidence)) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: "/bundleId", message: "Ready exports require their containing run manifest." }];
  }
  if (exportManifest.bundleId !== containingManifest.bundleId) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: "/bundleId", message: "Export bundle ID does not match its containing run manifest." }];
  }
  if (!isRecord(containingManifest.run) || (exportManifest.assessmentMode ?? "verified") !== (containingManifest.run.assessmentMode ?? "verified")) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: "/assessmentMode", message: "Export assessment mode does not match its containing run manifest." }];
  }
  const evidenceById = /* @__PURE__ */ new Map();
  for (const descriptor of containingManifest.evidence) {
    if (isRecord(descriptor) && typeof descriptor.id === "string") evidenceById.set(descriptor.id, descriptor);
  }
  const errors = [];
  const expectedBundleId = typeof containingManifest.bundleId === "string" ? containingManifest.bundleId : void 0;
  const expectedVerifier = isRecord(containingManifest.run) && isRecord(containingManifest.run.verifier) ? containingManifest.run.verifier : void 0;
  const workspaceEvidence = new Map(
    containingManifest.evidence.filter((entry) => isRecord(entry) && typeof entry.id === "string" && entry.kind === "workspace").map((entry) => [entry.id, entry])
  );
  const evidenceByPath = new Map(
    containingManifest.evidence.filter((entry) => isRecord(entry) && typeof entry.relativePath === "string").map((entry) => [entry.relativePath.toLowerCase(), entry])
  );
  const exportedIds = new Set(
    Array.isArray(exportManifest.artifactIds) ? exportManifest.artifactIds.filter((id) => typeof id === "string") : []
  );
  if (bundleRoot !== void 0) {
    errors.push(...validateRunManifestEvidence(artifact, containingManifest, bundleRoot));
  }
  const referencedDiagnosticPaths = /* @__PURE__ */ new Set();
  const exportedDiagnosticDescriptors = [];
  let hasNonExportArtifact = false;
  for (const id of Array.isArray(exportManifest.artifactIds) ? exportManifest.artifactIds : []) {
    const descriptor = typeof id === "string" ? evidenceById.get(id) : void 0;
    if (descriptor === void 0 || descriptor.sharingClass === "unknown" || descriptor.sharingClass !== exportManifest.sharingClass) {
      errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: `Export cannot include artifact ${String(id)}.` });
      continue;
    }
    if (exportManifest.sharingClass === "partner" || exportManifest.sharingClass === "public") {
      validateSanitizedProvenance(artifact, "export-manifest/v1", descriptor, evidenceById, errors);
      if (descriptor.kind === "verifier" && descriptor.sanitizedFrom !== void 0) {
        errors.push(...validateExportedVerifierDiagnostics(
          artifact,
          descriptor,
          bundleRoot,
          expectedBundleId,
          expectedVerifier,
          workspaceEvidence,
          evidenceByPath,
          exportedIds
        ));
        for (const locator of exportedVerifierDiagnosticLocators(bundleRoot, descriptor)) {
          referencedDiagnosticPaths.add(locator);
        }
      }
      if (descriptor.kind === "diagnostic" && descriptor.sanitizedFrom !== void 0) {
        errors.push(...validateExportedDiagnosticSidecar(artifact, descriptor, bundleRoot, evidenceById));
        exportedDiagnosticDescriptors.push(descriptor);
      }
    }
    hasNonExportArtifact ||= descriptor.kind !== "export-manifest";
  }
  for (const descriptor of exportedDiagnosticDescriptors) {
    if (typeof descriptor.relativePath === "string" && !referencedDiagnosticPaths.has(descriptor.relativePath.toLowerCase())) {
      errors.push({
        artifact,
        schemaVersion: "export-manifest/v1",
        field: `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`,
        message: "Exported diagnostic sidecars must be referenced by an exported sanitized verifier."
      });
    }
  }
  if (!hasNonExportArtifact) errors.push({ artifact, schemaVersion: "export-manifest/v1", field: "/artifactIds", message: "Ready exports must include non-export evidence." });
  return errors;
}
function exportedVerifierDiagnosticLocators(bundleRoot, descriptor) {
  if (bundleRoot === void 0 || typeof descriptor.relativePath !== "string" || typeof descriptor.digest !== "string") return [];
  try {
    const bytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath,
      digest: runDigest(descriptor.digest)
    });
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(result) && Array.isArray(result.diagnostics) ? result.diagnostics.flatMap((diagnostic) => isRecord(diagnostic) && typeof diagnostic.locator === "string" ? [diagnostic.locator.toLowerCase()] : []) : [];
  } catch {
    return [];
  }
}
function validateExportedDiagnosticSidecar(artifact, descriptor, bundleRoot, evidenceById) {
  const scope = `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`;
  if (bundleRoot === void 0) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: "Exported diagnostic sidecars require a bundle root." }];
  }
  const sourceBinding = isDiagnosticSourceBinding(descriptor.diagnosticSource) ? descriptor.diagnosticSource : void 0;
  if (sourceBinding === void 0) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource`, message: "Exported diagnostic sidecars require source-specific provenance." }];
  }
  if (!isRecord(descriptor.sanitizedFrom) || descriptor.sanitizedFrom.artifactId !== sourceBinding.verifierId) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/sanitizedFrom`, message: "Diagnostic sidecar provenance must name its diagnostic source verifier." }];
  }
  const sourceDescriptor = evidenceById.get(sourceBinding.verifierId);
  if (sourceDescriptor === void 0 || sourceDescriptor.kind !== "verifier" || typeof sourceDescriptor.relativePath !== "string" || typeof sourceDescriptor.digest !== "string") {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource/verifierId`, message: "Diagnostic source provenance must reference a retained verifier." }];
  }
  let sourceOutcome;
  try {
    const sourceBytes = resolveBundleArtifact(bundleRoot, {
      locator: sourceDescriptor.relativePath,
      digest: runDigest(sourceDescriptor.digest)
    });
    sourceOutcome = nestedVerifierOutcome(sourceBytes);
  } catch {
    sourceOutcome = void 0;
  }
  if (sourceOutcome === void 0 || !sourceOutcome.diagnostics.some((diagnostic) => sameDiagnosticOrigin(diagnostic, sourceBinding))) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/diagnosticSource`, message: "Diagnostic source provenance must match a retained source diagnostic." }];
  }
  const errors = [];
  if (typeof descriptor.relativePath !== "string" || typeof descriptor.digest !== "string" || typeof descriptor.sizeBytes !== "number") return errors;
  try {
    const sidecarBytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath,
      digest: runDigest(descriptor.digest)
    });
    if (sidecarBytes.length !== descriptor.sizeBytes) throw new Error("Diagnostic sidecar size does not match its descriptor.");
  } catch (error) {
    errors.push({ artifact, schemaVersion: "export-manifest/v1", field: scope, message: error instanceof Error ? error.message : "Diagnostic sidecar could not be verified." });
  }
  if (descriptor.digest === sourceBinding.digest) {
    errors.push({ artifact, schemaVersion: "export-manifest/v1", field: `${scope}/digest`, message: "Diagnostic sidecar bytes must differ from the source diagnostic." });
  }
  return errors;
}
function validateExportedVerifierDiagnostics(artifact, descriptor, bundleRoot, expectedBundleId, expectedVerifier, workspaceEvidence, evidenceByPath, exportedIds) {
  const scope = `/artifactIds/${escapeJsonPointer(String(descriptor.id))}`;
  if (bundleRoot === void 0) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: "Sanitized verifier exports require a bundle root to validate diagnostics." }];
  }
  let bytes;
  try {
    bytes = resolveBundleArtifact(bundleRoot, {
      locator: descriptor.relativePath,
      digest: runDigest(descriptor.digest)
    });
  } catch (error) {
    return [{ artifact, schemaVersion: "export-manifest/v1", field: scope, message: error instanceof Error ? error.message : "Sanitized verifier could not be read." }];
  }
  const evidencePaths = /* @__PURE__ */ new Set([...evidenceByPath.keys()]);
  const errors = nestedVerifierDiagnosticErrors(
    artifact,
    String(descriptor.id),
    bytes,
    bundleRoot,
    expectedBundleId,
    expectedVerifier,
    workspaceEvidence,
    true,
    isRecord(descriptor.sanitizedFrom) && typeof descriptor.sanitizedFrom.artifactId === "string" ? descriptor.sanitizedFrom.artifactId : void 0,
    evidenceByPath,
    evidencePaths,
    /* @__PURE__ */ new Set()
  );
  if (errors.length > 0) return errors.map((error) => ({ ...error, schemaVersion: "export-manifest/v1", field: `${scope}${error.field.replace(/^\/evidence\/[^/]*/, "")}` }));
  let result;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return [];
  }
  if (!isRecord(result) || !Array.isArray(result.diagnostics)) return [];
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (!isRecord(diagnostic) || typeof diagnostic.locator !== "string") continue;
    const sidecar = evidenceByPath.get(diagnostic.locator.toLowerCase());
    if (sidecar !== void 0 && typeof sidecar.id === "string" && !exportedIds.has(sidecar.id)) {
      errors.push({
        artifact,
        schemaVersion: "export-manifest/v1",
        field: `${scope}/diagnostics/${index}/locator`,
        message: "Sanitized verifier diagnostic sidecars must be included in the export."
      });
    }
  }
  return errors;
}
async function readVerifiedArtifact(artifactRoot, relativePath, expectedDigest, maxBytes) {
  if (maxBytes !== void 0 && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Artifact byte limit must be a nonnegative safe integer.");
  }
  const { root, path } = await resolveExistingArtifactPath(artifactRoot, relativePath);
  removeInterruptedPublicationLink(path, lstatSync2(path));
  const handle = await open(path, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || !await isReadablePublishedArtifact(path, opened) || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
    if (maxBytes !== void 0 && opened.size > maxBytes) {
      throw new Error(`Artifact "${relativePath}" exceeds the qualification byte limit of ${maxBytes}.`);
    }
    await assertExistingArtifactPath(root, relativePath);
    const bytes = await handle.readFile();
    const completed = await handle.stat();
    if (!completed.isFile() || !await isReadablePublishedArtifact(path, completed) || completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
    if (!verifyDigest(bytes, expectedDigest)) {
      throw new Error(`Artifact "${relativePath}" digest does not match its source reference.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
async function inspectRetainedArtifact(artifactRoot, relativePath, maxBytes) {
  if (maxBytes !== void 0 && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new Error("Artifact byte limit must be a nonnegative safe integer.");
  }
  const { path } = await resolveExistingArtifactPath(artifactRoot, relativePath);
  return inspectExistingPath(path, relativePath, maxBytes);
}
function loadValidators() {
  const readSchema = (name) => JSON.parse(readFileSync(`${schemaDirectory}${name}`, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addKeyword({
    keyword: "eboUniqueItems",
    type: "array",
    schemaType: "boolean",
    validate: (enabled, items) => {
      if (!enabled) return true;
      const seen = /* @__PURE__ */ new Set();
      try {
        for (const item of items) {
          const key = canonicalizeMetadata(item);
          if (seen.has(key)) return false;
          seen.add(key);
        }
      } catch {
        return false;
      }
      return true;
    }
  });
  ajv.addSchema(readSchema("task-packet.v1.schema.json"));
  ajv.addSchema(readSchema("task-packet-freeze.v1.schema.json"));
  ajv.addSchema(readSchema("experiment.v1.schema.json"));
  ajv.addSchema(readSchema("run-queue.v1.schema.json"));
  const runBundleSchema = readSchema("run-bundles/v1.json");
  const missingEvidence = runBundleSchema.$defs.captureReport.properties.missingEvidence;
  missingEvidence.eboUniqueItems = missingEvidence.uniqueItems;
  delete missingEvidence.uniqueItems;
  ajv.addSchema(runBundleSchema);
  ajv.addSchema(readSchema("uniform-events/v1.json"));
  ajv.addSchema(readSchema("normalization-integrity.v1.json"));
  ajv.addSchema(readSchema("structural-observations.v1.json"));
  ajv.addSchema(readSchema("atif-inspection.v1.json"));
  ajv.addSchema(readSchema("import-manifest.v1.json"));
  ajv.addSchema(readSchema("pi-atif-mapping.v1.json"));
  ajv.addSchema(readSchema("atif-producer-profile.v1.json"));
  ajv.addSchema(readSchema("behavior-assertions.v1.json"));
  ajv.addSchema(readSchema("semantic-judge.v1.json"));
  ajv.addSchema(readSchema("human-calibration.v1.json"));
  ajv.addSchema(readSchema("aggregation.v1.json"));
  ajv.addSchema(readSchema("occurrence-ratings.v1.json"));
  ajv.addSchema(readSchema("claim-checks.v1.json"));
  ajv.addSchema(readSchema("atlas-bundle.v1.json"));
  ajv.addSchema(readSchema("deepseek-runtime-composition.v1.schema.json"));
  ajv.addSchema(readSchema("harbor-admission.v1.schema.json"));
  ajv.addSchema(readSchema("harbor-import.v1.json"));
  ajv.addSchema(readSchema("harbor-review.v1.schema.json"));
  ajv.addSchema(readSchema("harbor-freeze.v1.schema.json"));
  ajv.addSchema(readSchema("experiment.v2.schema.json"));
  ajv.addSchema(readSchema("run-queue.v2.schema.json"));
  return /* @__PURE__ */ new Map([
    ["ebo.harbor-trial-inspection/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/inspection")],
    ["ebo.harbor-source-snapshot/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/snapshot")],
    ["ebo.harbor-execution/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/execution")],
    ["ebo.harbor-capture-binding/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/binding")],
    ["ebo.harbor-capture-membership/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/membership")],
    ["ebo.harbor-assessment/v1", requiredValidator(ajv, "urn:ebo:schema:harbor-import:v1#/$defs/assessment")],
    ["ebo.pi-atif-mapping/v1", requiredValidator(ajv, "urn:ebo:schema:pi-atif-mapping:v1")],
    ["ebo.import-manifest/v1", requiredValidator(ajv, "urn:ebo:schema:import-manifest:v1")],
    ["ebo.atif-inspection/v1", requiredValidator(ajv, "urn:ebo:schema:atif-inspection:v1")],
    ["ebo.atif-producer-profile/v1", requiredValidator(ajv, "urn:ebo:schema:atif-producer-profile:v1")],
    ["ebo.task-packet/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet.v1.schema.json")],
    ["ebo.task-packet-freeze/v1", requiredValidator(ajv, "https://ebo.dev/schemas/task-packet-freeze.v1.schema.json")],
    ["ebo.experiment/v1", requiredValidator(ajv, "https://ebo.dev/schemas/experiment.v1.schema.json")],
    ["ebo.run-queue/v1", requiredValidator(ajv, "https://ebo.dev/schemas/run-queue.v1.schema.json")],
    ["run-manifest/v1", requiredValidator(ajv, runBundleSchemaId)],
    ["verifier-result/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/verifierResult`)],
    ["capture-report/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/captureReport`)],
    ["export-manifest/v1", requiredValidator(ajv, `${runBundleSchemaId}#/$defs/exportManifest`)],
    ["ebo.uniform-event/v1", requiredValidator(ajv, "urn:ebo:schema:uniform-events:v1#/$defs/uniformEvent")],
    ["ebo.adapter-capability-profile/v1", requiredValidator(ajv, "urn:ebo:schema:uniform-events:v1#/$defs/capabilityProfile")],
    ["ebo.normalized-dataset/v1", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/normalizedDataset")],
    ["ebo.adapter-coverage-report/v1", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/coverageReport")],
    ["ebo.comparison-request/v1", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/comparisonRequest")],
    ["ebo.comparison-report/v1", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/comparisonReport")],
    ["ebo.comparison-request/v2", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/comparisonRequestV2")],
    ["ebo.comparison-report/v2", requiredValidator(ajv, "urn:ebo:schema:normalization-integrity:v1#/$defs/comparisonReportV2")],
    ["ebo.structural-observation/v1", requiredValidator(ajv, "urn:ebo:schema:structural-observations:v1#/$defs/observation")],
    ["ebo.structural-observation-set/v1", requiredValidator(ajv, "urn:ebo:schema:structural-observations:v1#/$defs/set")],
    ["ebo.behavior-vocabulary/v1", requiredValidator(ajv, "urn:ebo:schema:behavior-assertions:v1#/$defs/vocabulary")],
    ["ebo.behavior-assertion/v1", requiredValidator(ajv, "urn:ebo:schema:behavior-assertions:v1#/$defs/assertion")],
    ["ebo.behavior-review/v1", requiredValidator(ajv, "urn:ebo:schema:behavior-assertions:v1#/$defs/review")],
    ["ebo.occurrence-ratings/v1", requiredValidator(ajv, "urn:ebo:schema:occurrence-ratings:v1#/$defs/ratings")],
    ["ebo.claim-checks/v1", requiredValidator(ajv, "urn:ebo:schema:claim-checks:v1#/$defs/checks")],
    ["ebo.atlas-bundle-request/v1", requiredValidator(ajv, "urn:ebo:schema:atlas-bundle:v1#/$defs/request")],
    ["ebo.atlas-bundle/v1", requiredValidator(ajv, "urn:ebo:schema:atlas-bundle:v1#/$defs/bundle")],
    ["ebo.semantic-judge-request/v1", requiredValidator(ajv, "urn:ebo:schema:semantic-judge:v1#/$defs/request")],
    ["ebo.semantic-judge-input/v1", requiredValidator(ajv, "urn:ebo:schema:semantic-judge:v1#/$defs/input")],
    ["ebo.semantic-judgment/v1", requiredValidator(ajv, "urn:ebo:schema:semantic-judge:v1#/$defs/judgment")],
    ["ebo.review-source-set/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/sourceSet")],
    ["ebo.review-sample-criteria/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/criteria")],
    ["ebo.review-sample/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/sample")],
    ["ebo.review-packet/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/packet")],
    ["ebo.human-review-decision/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/decision")],
    ["ebo.review-history/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/history")],
    ["ebo.calibration-summary/v1", requiredValidator(ajv, "urn:ebo:schema:human-calibration:v1#/$defs/summary")],
    ["ebo.aggregation-request/v1", requiredValidator(ajv, "urn:ebo:schema:aggregation:v1#/$defs/request")],
    ["ebo.aggregation-report/v1", requiredValidator(ajv, "urn:ebo:schema:aggregation:v1#/$defs/report")],
    ["ebo.deepseek-runtime-composition/v1", requiredValidator(ajv, "https://ebo.dev/schemas/deepseek-runtime-composition.v1.schema.json")],
    ["ebo.harbor-admission/v1", requiredValidator(ajv, "https://ebo.dev/schemas/harbor-admission.v1.schema.json")],
    ["ebo.harbor-review/v1", requiredValidator(ajv, "https://ebo.dev/schemas/harbor-review.v1.schema.json")],
    ["ebo.harbor-freeze/v1", requiredValidator(ajv, "https://ebo.dev/schemas/harbor-freeze.v1.schema.json")],
    ["ebo.experiment/v2", requiredValidator(ajv, "https://ebo.dev/schemas/experiment.v2.schema.json")],
    ["ebo.run-queue/v2", requiredValidator(ajv, "https://ebo.dev/schemas/run-queue.v2.schema.json")]
  ]);
}
function requiredValidator(ajv, schemaId) {
  const validate = ajv.getSchema(schemaId);
  if (validate === void 0) throw new Error(`Missing bundled schema ${schemaId}.`);
  return validate;
}
function canonicalJson(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Metadata must contain only finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Metadata must not contain cycles.");
    if (Object.keys(value).some((key) => !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      throw new Error("Metadata arrays must not contain non-index properties.");
    }
    ancestors.add(value);
    try {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("Metadata arrays must not contain holes.");
        entries.push(canonicalJson(value[index], ancestors));
      }
      return `[${entries.join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Metadata must contain only JSON values.");
  }
  if (ancestors.has(value)) throw new Error("Metadata must not contain cycles.");
  ancestors.add(value);
  try {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
function schemaVersionOf(document) {
  return isRecord(document) && typeof document.schemaVersion === "string" ? document.schemaVersion : "unknown";
}
function validationError(artifact, schemaVersion, error) {
  const missing2 = error.keyword === "required" && typeof error.params.missingProperty === "string" ? `/${escapeJsonPointer(error.params.missingProperty)}` : "";
  return {
    artifact,
    schemaVersion,
    field: `${error.instancePath}${missing2}` || "/",
    message: error.message ?? error.keyword
  };
}
function runManifestIntegrityErrors(artifact, schemaVersion, manifest) {
  const errors = [];
  const evidence = manifest.evidence;
  try {
    assertUniqueArtifactIdentities(evidence.map((entry) => ({
      id: isRecord(entry) && typeof entry.id === "string" ? entry.id : "",
      relativePath: isRecord(entry) && typeof entry.relativePath === "string" ? entry.relativePath : ""
    })));
  } catch (error) {
    errors.push({ artifact, schemaVersion, field: "/evidence", message: error instanceof Error ? error.message : "Duplicate evidence identity." });
  }
  const evidenceClasses = /* @__PURE__ */ new Map();
  const evidenceById = /* @__PURE__ */ new Map();
  for (const descriptor of evidence) {
    if (!isRecord(descriptor)) continue;
    const { digest: digest5, id, kind, authority, relativePath } = descriptor;
    if (typeof id === "string") evidenceById.set(id, descriptor);
    if (typeof relativePath === "string" && (relativePath.toLowerCase() === "manifest.json" || relativePath.toLowerCase().startsWith("manifest.json/"))) {
      errors.push({ artifact, schemaVersion, field: "/evidence", message: "Evidence cannot reuse the containing manifest path." });
    }
    if (typeof digest5 !== "string" || typeof kind !== "string" || typeof authority !== "string") continue;
    const evidenceClass = `${kind}:${authority}`;
    const existing = evidenceClasses.get(digest5);
    if (existing !== void 0 && existing !== evidenceClass) {
      errors.push({ artifact, schemaVersion, field: "/evidence", message: `Evidence reuses ${digest5} across evidence classes.` });
    }
    evidenceClasses.set(digest5, evidenceClass);
  }
  for (const descriptor of evidenceById.values()) {
    validateSanitizedProvenance(artifact, schemaVersion, descriptor, evidenceById, errors);
  }
  if (isRecord(manifest.attempt) && manifest.attempt.retryOf === manifest.attempt.id) {
    errors.push({ artifact, schemaVersion, field: "/attempt/retryOf", message: "Retry lineage cannot reference the current attempt." });
  }
  const sourceEvidence = [...evidenceById.values()].filter((descriptor) => descriptor.sanitizedFrom === void 0);
  const run = isRecord(manifest.run) ? manifest.run : void 0;
  if (run !== void 0 && isRecord(run.native)) {
    validateNativeReference(artifact, schemaVersion, "sessionId", "session", "session", run.native, sourceEvidence, errors);
    validateNativeReference(artifact, schemaVersion, "traceId", "telemetry", "trace", run.native, sourceEvidence, errors);
  }
  const harness = run !== void 0 && isRecord(run.harness) ? run.harness : void 0;
  if (run !== void 0 && harness !== void 0 && Array.isArray(run.runtime) && !run.runtime.some((component) => isRecord(component) && component.version === harness.version && (component.name === harness.id || component.source === harness.id))) {
    errors.push({ artifact, schemaVersion, field: "/run/runtime", message: "Declared harness is not represented by its runtime composition." });
  }
  const terminal = isRecord(manifest.terminal) ? manifest.terminal : void 0;
  if (terminal !== void 0 && typeof terminal.workspaceArtifactId === "string" && !sourceEvidence.some((descriptor) => descriptor.id === terminal.workspaceArtifactId && descriptor.kind === "workspace")) {
    errors.push({ artifact, schemaVersion, field: "/terminal/workspaceArtifactId", message: "Terminal workspace must reference retained workspace evidence." });
  }
  return errors;
}
function validateSanitizedProvenance(artifact, schemaVersion, descriptor, evidenceById, errors) {
  if (!isRecord(descriptor.sanitizedFrom) || typeof descriptor.id !== "string" || typeof descriptor.digest !== "string") return;
  const field = `/evidence/${escapeJsonPointer(descriptor.id)}/sanitizedFrom`;
  const shared = descriptor.sharingClass === "partner" || descriptor.sharingClass === "public";
  const seen = /* @__PURE__ */ new Set([descriptor.id]);
  const sharedDigest = descriptor.digest;
  let current = descriptor;
  while (isRecord(current.sanitizedFrom)) {
    const { artifactId, digest: digest5 } = current.sanitizedFrom;
    if (typeof artifactId !== "string" || typeof digest5 !== "string" || seen.has(artifactId)) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance cannot contain a cycle." });
      return;
    }
    const source = evidenceById.get(artifactId);
    if (source === void 0) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance must reference retained source evidence." });
      return;
    }
    const currentShared = current.sharingClass === "partner" || current.sharingClass === "public";
    const diagnosticDerivative = current.kind === "diagnostic" && source.kind === "verifier";
    if (["source", "authority"].some((key) => source[key] !== current[key]) || !diagnosticDerivative && source.kind !== current.kind || (currentShared ? current.nativeReference !== void 0 : !sameNativeReference(source.nativeReference, current.nativeReference)) || source.digest !== digest5 || source.digest === current.digest || source.digest === sharedDigest || source.relativePath === current.relativePath) {
      errors.push({ artifact, schemaVersion, field, message: "Sanitized provenance does not preserve its source evidence." });
      return;
    }
    seen.add(artifactId);
    current = source;
  }
  if (shared && [...evidenceById.values()].some((candidate) => !seen.has(String(candidate.id)) && candidate.digest === sharedDigest)) {
    errors.push({ artifact, schemaVersion, field, message: "Sanitized shared evidence cannot reuse unrelated retained bytes." });
  }
}
function validateNativeReference(artifact, schemaVersion, field, kind, nativeType, native, sourceEvidence, errors) {
  if (typeof native[field] === "string" && !sourceEvidence.some(
    (descriptor) => descriptor.kind === kind && isRecord(descriptor.nativeReference) && descriptor.nativeReference.type === nativeType && descriptor.nativeReference.id === native[field]
  )) {
    errors.push({ artifact, schemaVersion, field: `/run/native/${field}`, message: `Declared ${field} does not match retained ${kind} evidence.` });
  }
}
function sameNativeReference(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return isRecord(left) && isRecord(right) && left.type === right.type && left.id === right.id;
}
function runDigest(value) {
  return { algorithm: "sha256", value: value.slice("sha256:".length) };
}
function escapeJsonPointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
async function resolveExistingArtifactPath(artifactRoot, relativePath) {
  const root = await realpath(artifactRoot);
  return { root, path: await assertExistingArtifactPath(root, relativePath) };
}
async function assertExistingArtifactPath(root, relativePath) {
  assertSafeArtifactPath(relativePath);
  let path = root;
  const segments2 = relativePath.split("/");
  for (const [index, segment] of segments2.entries()) {
    path = resolve2(path, segment);
    const entry = await lstat(path);
    if (!isContained2(root, path) || entry.isSymbolicLink()) {
      throw new Error(`Artifact path "${relativePath}" escapes its declared root.`);
    }
    if (index === segments2.length - 1 && !entry.isFile()) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
  }
  return path;
}
function inspectExistingPath(path, relativePath, maxBytes) {
  const descriptor = openSync2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_NONBLOCK);
  try {
    let opened = fstatSync2(descriptor);
    if (opened.nlink > 1) {
      removeInterruptedPublicationLink(path, opened);
      opened = fstatSync2(descriptor);
    }
    const openedTimes = fstatSync2(descriptor, { bigint: true });
    if (!opened.isFile() || !isReadablePublishedFile(path, opened) || !Number.isSafeInteger(opened.size) || opened.size < 0) {
      throw new Error(`Artifact path "${relativePath}" is not an isolated regular file.`);
    }
    if (maxBytes !== void 0 && opened.size > maxBytes) {
      throw new Error(`Artifact "${relativePath}" exceeds the qualification byte limit of ${maxBytes}.`);
    }
    const hash3 = createHash2("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < opened.size; ) {
      const read = readSync2(descriptor, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (read === 0) throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
      hash3.update(chunk.subarray(0, read));
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync2(descriptor, trailing, 0, 1, opened.size) !== 0) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
    const completed = fstatSync2(descriptor);
    const completedTimes = fstatSync2(descriptor, { bigint: true });
    if (!completed.isFile() || !isReadablePublishedFile(path, completed) || !sameFileIdentity2(opened, completed) || completed.size !== opened.size || completedTimes.mtimeNs !== openedTimes.mtimeNs || completedTimes.ctimeNs !== openedTimes.ctimeNs) {
      throw new Error(`Artifact path "${relativePath}" changed while it was being read.`);
    }
    return {
      digest: { algorithm: "sha256", value: hash3.digest("hex") },
      sizeBytes: opened.size
    };
  } finally {
    closeSync2(descriptor);
  }
}
function isReadablePublishedFile(path, target) {
  try {
    const current = lstatSync2(path);
    return target.nlink === 1 && current.nlink === 1 && current.isFile() && !current.isSymbolicLink() && sameFileIdentity2(current, target);
  } catch {
    return false;
  }
}
async function isReadablePublishedArtifact(path, target) {
  try {
    const current = await lstat(path);
    return target.nlink === 1 && current.nlink === 1 && current.isFile() && !current.isSymbolicLink() && sameFileIdentity2(current, target);
  } catch {
    return false;
  }
}
function sameFileIdentity2(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function assertSafeArtifactPath(relativePath) {
  if (!isSafeArtifactRelativePath(relativePath)) {
    throw new Error(`Artifact path "${relativePath}" is unsafe.`);
  }
}
function isContained2(root, path) {
  const fromRoot = relative2(root, path);
  return fromRoot === "" || !isAbsolute2(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep2}`);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var addFormats, schemaDirectory, runBundleSchemaId, validators, RESERVED_MANIFEST_PATHS, SUPPORTED_ARTIFACT_SCHEMA_VERSIONS;
var init_artifacts = __esm({
  "src/artifacts.ts"() {
    init_contracts();
    addFormats = formats.default;
    schemaDirectory = fileURLToPath(new URL("../../schemas/", import.meta.url));
    runBundleSchemaId = "urn:ebo:schema:run-bundle:v1";
    validators = loadValidators();
    RESERVED_MANIFEST_PATHS = /* @__PURE__ */ new Set(["manifest.json"]);
    SUPPORTED_ARTIFACT_SCHEMA_VERSIONS = [...validators.keys()];
  }
});

// src/task-packets.ts
var init_task_packets = __esm({
  "src/task-packets.ts"() {
    init_artifacts();
    init_contracts();
  }
});

// src/scheduler.ts
import { closeSync as closeSync3, constants as constants3, fstatSync as fstatSync3, lstatSync as lstatSync3, mkdirSync as mkdirSync2, openSync as openSync3, readSync as readSync3 } from "node:fs";
function readBoundedFile(path, label = "Artifact", afterOpen, maxBytes = MAX_RUN_QUEUE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label} byte limit must be a nonnegative safe integer.`);
  let descriptor;
  try {
    descriptor = openSync3(path, constants3.O_RDONLY | constants3.O_NOFOLLOW | constants3.O_NONBLOCK);
    const opened = fstatSync3(descriptor);
    if (!opened.isFile()) throw new Error(`${label} path "${path}" is not a regular file.`);
    const namedBefore = lstatSync3(path);
    if (!namedBefore.isFile() || !sameFileIdentity3(namedBefore, opened)) {
      throw new Error(`${label} file "${path}" changed while being opened.`);
    }
    if (!Number.isSafeInteger(opened.size) || opened.size > maxBytes) {
      throw new Error(`${label} file exceeds the local byte limit of ${maxBytes}.`);
    }
    const openedTimes = fstatSync3(descriptor, { bigint: true });
    afterOpen?.();
    const bytes = Buffer.alloc(opened.size);
    for (let offset = 0; offset < opened.size; ) {
      const read = readSync3(descriptor, bytes, offset, opened.size - offset, offset);
      if (read === 0) throw new Error(`${label} file "${path}" was truncated while being read.`);
      offset += read;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync3(descriptor, trailing, 0, 1, opened.size) !== 0) {
      throw new Error(`${label} file "${path}" grew while being read.`);
    }
    const completed = fstatSync3(descriptor);
    const completedTimes = fstatSync3(descriptor, { bigint: true });
    let namedAfter;
    try {
      namedAfter = lstatSync3(path);
    } catch {
      throw new Error(`${label} file "${path}" changed while being read.`);
    }
    if (!completed.isFile() || completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || !namedAfter.isFile() || !sameFileIdentity3(namedAfter, completed) || completedTimes.mtimeNs !== openedTimes.mtimeNs || completedTimes.ctimeNs !== openedTimes.ctimeNs) {
      throw new Error(`${label} file "${path}" changed while being read.`);
    }
    return bytes;
  } finally {
    if (descriptor !== void 0) closeSync3(descriptor);
  }
}
function sameFileIdentity3(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
var MAX_RUN_QUEUE_BYTES;
var init_scheduler = __esm({
  "src/scheduler.ts"() {
    init_artifacts();
    init_contracts();
    init_task_packets();
    MAX_RUN_QUEUE_BYTES = 128 * 1024 * 1024;
  }
});

// src/atif-import.ts
init_artifacts();
import { join, resolve as resolve3 } from "node:path";

// src/atif-reader.ts
init_artifacts();
init_scheduler();
var ATIF_READER_VERSION = "1.0.0";
var ATIF_HARBOR_VERSION = "0.24.0";
var ATIF_LIMITS = Object.freeze({
  documentBytes: 64 * 1024 * 1024,
  stepBytes: 4 * 1024 * 1024,
  attachmentBytes: 16 * 1024 * 1024,
  attachmentTotalBytes: 64 * 1024 * 1024,
  depth: 64,
  nodes: 1e6,
  pointerRecords: 1e5,
  tokenArrayItems: 1e5
});
var ATIF_VERSION_FEATURES = Object.freeze({
  "ATIF-v1.2": { completionTokenIds: false, promptTokenIds: false, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.3": { completionTokenIds: true, promptTokenIds: false, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.4": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.5": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: false, multimodal: false, copiedContext: true, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.6": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: false, multimodal: true, copiedContext: true, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.7": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: true, multimodal: true, copiedContext: true, declaredInference: true, embeddedTrajectories: true, audio: false },
  "ATIF-v1.8": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: true, multimodal: true, copiedContext: true, declaredInference: true, embeddedTrajectories: true, audio: true }
});
function inspectAtifBytes(bytes) {
  const inspection = {
    schemaVersion: "ebo.atif-inspection/v1",
    readerVersion: ATIF_READER_VERSION,
    source: { bytes: bytes.byteLength, digest: hashBytes(bytes) },
    versionPolicy: { status: "unavailable", diagnostics: [] },
    structural: unavailableValidator("STRUCTURAL_VALIDATION_NOT_RUN"),
    records: [],
    references: [],
    fieldCoverage: {},
    limitations: ["THIRD_PARTY_SOURCE", "CAPTURE_COMPLETENESS_UNPROVEN"]
  };
  if (bytes.byteLength > ATIF_LIMITS.documentBytes) return rejected(inspection, "DOCUMENT_BYTE_LIMIT");
  let document;
  try {
    const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(text9);
    checkBounds(document);
    assertNoDuplicateJsonKeys(text9);
  } catch (error) {
    return rejected(inspection, error instanceof AtifLimitError ? error.code : error instanceof Error && /duplicate JSON object keys/u.test(error.message) ? "DUPLICATE_JSON_KEY" : "INVALID_JSON");
  }
  if (!isAtifObject(document)) return rejected(inspection, "DOCUMENT_NOT_OBJECT");
  if (typeof document.schema_version === "string") inspection.sourceVersion = document.schema_version;
  const policyDiagnostics = [];
  let unsupported = false;
  const count2 = (key) => {
    inspection.fieldCoverage[key] = (inspection.fieldCoverage[key] ?? 0) + 1;
  };
  const sourceDigest = inspection.source.digest;
  const pointerDigests = /* @__PURE__ */ new Map();
  const record3 = (value, pointer, kind, copied, gap) => {
    if (inspection.records.length >= ATIF_LIMITS.pointerRecords) throw new AtifLimitError("POINTER_RECORD_LIMIT");
    const digest5 = hashValue(value);
    pointerDigests.set(pointer, digest5);
    inspection.records.push({ pointer, digest: digest5, sourceDigest, kind, copied, gap });
  };
  const violation = (code, pointer) => policyDiagnostics.push({ code, pointer });
  const visit = (trajectory, pointer, inheritedCopied, inheritedGap) => {
    const version = typeof trajectory.schema_version === "string" ? trajectory.schema_version : "";
    const features = Object.hasOwn(ATIF_VERSION_FEATURES, version) ? ATIF_VERSION_FEATURES[version] : void 0;
    if (features === void 0) {
      unsupported = true;
      violation("UNSUPPORTED_ATIF_VERSION", `${pointer}/schema_version`);
    }
    if (features !== void 0 && !features.embeddedTrajectories) {
      for (const key of ["trajectory_id", "subagent_trajectories"]) if (key in trajectory) violation(`VERSION_FIELD:${key}`, `${pointer}/${key}`);
      if (typeof trajectory.session_id !== "string") violation("VERSION_REQUIRES_SESSION_ID", `${pointer}/session_id`);
    }
    if (features !== void 0 && !features.toolDefinitions && "tool_definitions" in object(trajectory.agent)) violation("VERSION_FIELD:agent.tool_definitions", `${pointer}/agent/tool_definitions`);
    record3(trajectory, pointer, "trajectory", inheritedCopied, inheritedGap);
    for (const [index, value] of array(trajectory.steps).entries()) {
      if (!isAtifObject(value)) continue;
      const stepPointer = `${pointer}/steps/${index}`;
      if (Buffer.byteLength(JSON.stringify(value)) > ATIF_LIMITS.stepBytes) throw new AtifLimitError("STEP_BYTE_LIMIT");
      const copied = inheritedCopied || value.is_copied_context === true;
      const gap = inheritedGap || object(value.extra).added_by === "hlb";
      if (features !== void 0) {
        if (!features.copiedContext && "is_copied_context" in value) violation("VERSION_FIELD:is_copied_context", `${stepPointer}/is_copied_context`);
        if (!features.declaredInference && "llm_call_count" in value) violation("VERSION_FIELD:llm_call_count", `${stepPointer}/llm_call_count`);
        if (!features.multimodal && Array.isArray(value.message)) violation("VERSION_FIELD:multimodal", `${stepPointer}/message`);
        if (!features.completionTokenIds && "completion_token_ids" in object(value.metrics)) violation("VERSION_FIELD:completion_token_ids", `${stepPointer}/metrics/completion_token_ids`);
        if (!features.promptTokenIds && "prompt_token_ids" in object(value.metrics)) violation("VERSION_FIELD:prompt_token_ids", `${stepPointer}/metrics/prompt_token_ids`);
      }
      record3(value, stepPointer, "step", copied, gap);
      count2("steps");
      if (copied) count2("copiedSteps");
      if (gap) count2("gapSteps");
      if ("llm_call_count" in value) count2("declaredInferenceFields");
      for (const [callIndex, call] of array(value.tool_calls).entries()) {
        if (features !== void 0 && !features.toolCallExtra && "extra" in object(call)) violation("VERSION_FIELD:tool_call.extra", `${stepPointer}/tool_calls/${callIndex}/extra`);
        record3(call, `${stepPointer}/tool_calls/${callIndex}`, "call", copied, gap);
        count2("toolCallFields");
      }
      for (const [resultIndex, result] of array(object(value.observation).results).entries()) {
        const resultPointer = `${stepPointer}/observation/results/${resultIndex}`;
        record3(result, resultPointer, "result", copied, gap);
        if (!features?.multimodal && Array.isArray(object(result).content)) violation("VERSION_FIELD:multimodal", `${resultPointer}/content`);
        if (features !== void 0 && !features.embeddedTrajectories && "extra" in object(result)) violation("VERSION_FIELD:result.extra", `${resultPointer}/extra`);
        if (typeof object(object(result).extra).is_error === "boolean") count2("explicitIsErrorFields");
      }
    }
    for (const [index, child] of array(trajectory.subagent_trajectories).entries()) {
      if (isAtifObject(child)) visit(child, `${pointer}/subagent_trajectories/${index}`, inheritedCopied, inheritedGap);
    }
    findReferences(trajectory, pointer, inspection.references, features, pointerDigests, violation);
  };
  try {
    visit(document, "#", false, false);
  } catch (error) {
    return rejected(inspection, error instanceof AtifLimitError ? error.code : "POINTER_INVENTORY_FAILED");
  }
  inspection.references = [...new Map(inspection.references.map((reference) => [reference.pointer, reference])).values()];
  if (inspection.references.some(({ status }) => status === "unavailable")) inspection.limitations.push("EXTERNAL_REFERENCE_UNAVAILABLE");
  inspection.versionPolicy = {
    status: unsupported ? "unsupported" : policyDiagnostics.length ? "inconsistent" : "supported",
    diagnostics: [...new Map(policyDiagnostics.map((diagnostic) => [`${diagnostic.code}\0${diagnostic.pointer}`, diagnostic])).values()]
  };
  return { inspection, document };
}
function isAtifObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
var object = (value) => isAtifObject(value) ? value : {};
var array = (value) => Array.isArray(value) ? value : [];
var hashBytes = (bytes) => `sha256:${digestBytes(bytes).value}`;
var hashValue = (value) => `sha256:${digestMetadata(value).value}`;
var AtifLimitError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
  code;
};
function unavailableValidator(code) {
  return { status: "unavailable", validator: "harbor", version: ATIF_HARBOR_VERSION, diagnostics: [{ code, pointer: "#" }] };
}
function rejected(inspection, code) {
  inspection.versionPolicy = { status: "unavailable", diagnostics: [{ code, pointer: "#" }] };
  inspection.records = [];
  inspection.references = [];
  return { inspection };
}
function checkBounds(document) {
  const pending = [{ value: document, depth: 0, key: "" }];
  let nodes = 0;
  let enqueued = 1;
  const enqueue = (value, depth, key) => {
    if (++enqueued > ATIF_LIMITS.nodes) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
    pending.push({ value, depth, key });
  };
  while (pending.length) {
    const { value, depth, key } = pending.pop();
    if (++nodes > ATIF_LIMITS.nodes || depth > ATIF_LIMITS.depth) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
    if (typeof value === "number" && !Number.isFinite(value)) throw new AtifLimitError("NONFINITE_JSON_NUMBER");
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new AtifLimitError("UNSAFE_JSON_INTEGER");
    if (Array.isArray(value)) {
      if (["prompt_token_ids", "completion_token_ids", "logprobs"].includes(key) && value.length > ATIF_LIMITS.tokenArrayItems) throw new AtifLimitError("TOKEN_ARRAY_LIMIT");
      if (value.length > ATIF_LIMITS.nodes - enqueued) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
      for (const nested of value) enqueue(nested, depth + 1, "");
    } else if (isAtifObject(value)) {
      for (const name in value) if (Object.hasOwn(value, name)) enqueue(value[name], depth + 1, name);
    }
  }
}
function findReferences(trajectory, pointer, references, features, pointerDigests, violation) {
  const children = /* @__PURE__ */ new Map();
  for (const [index, value] of array(trajectory.subagent_trajectories).entries()) {
    const identity = object(value).trajectory_id, location = `${pointer}/subagent_trajectories/${index}`;
    const digest5 = pointerDigests.get(location);
    if (typeof identity === "string" && digest5 !== void 0) children.set(identity, children.has(identity) ? null : { pointer: location, digest: digest5 });
  }
  const addFile = (target, location, kind) => {
    if (typeof target === "string") references.push({ pointer: location, target, kind, status: "unavailable", reason: "REFERENCE_NOT_ADMITTED" });
  };
  const content = (value, location) => {
    for (const [index, part] of array(value).entries()) {
      const item = object(part);
      if (item.type === "audio" && !features?.audio) violation("VERSION_FIELD:audio", `${location}/${index}`);
      if (["image", "audio"].includes(String(item.type))) addFile(object(item.source).path, `${location}/${index}/source/path`, "media");
    }
  };
  addFile(trajectory.continued_trajectory_ref, `${pointer}/continued_trajectory_ref`, "continuation");
  for (const [index, step] of array(trajectory.steps).entries()) {
    const location = `${pointer}/steps/${index}`;
    content(object(step).message, `${location}/message`);
    for (const [resultIndex, result] of array(object(object(step).observation).results).entries()) {
      const resultLocation = `${location}/observation/results/${resultIndex}`;
      content(object(result).content, `${resultLocation}/content`);
      for (const [refIndex, value] of array(object(result).subagent_trajectory_ref).entries()) {
        const reference = object(value), refLocation = `${resultLocation}/subagent_trajectory_ref/${refIndex}`;
        if (features !== void 0 && !features.embeddedTrajectories && typeof reference.session_id !== "string") violation("VERSION_REQUIRES_REF_SESSION_ID", `${refLocation}/session_id`);
        addFile(reference.trajectory_path, `${refLocation}/trajectory_path`, "subagent-file");
        if (reference.trajectory_id == null && reference.trajectory_path == null && typeof reference.session_id === "string") {
          references.push({
            pointer: `${refLocation}/session_id`,
            target: reference.session_id,
            kind: "session-only",
            status: "unavailable",
            reason: "SESSION_REFERENCE_NOT_RETAINED"
          });
        }
        if (typeof reference.trajectory_id === "string") {
          if (features !== void 0 && !features.embeddedTrajectories) violation("VERSION_FIELD:ref.trajectory_id", `${refLocation}/trajectory_id`);
          const child = children.get(reference.trajectory_id);
          if (child == null) references.push({
            pointer: `${refLocation}/trajectory_id`,
            target: reference.trajectory_id,
            kind: "embedded",
            status: "unavailable",
            reason: "EMBEDDED_REFERENCE_MISSING_OR_AMBIGUOUS"
          });
          else references.push({
            pointer: `${refLocation}/trajectory_id`,
            target: child.pointer,
            kind: "embedded",
            status: "retained",
            digest: child.digest
          });
        }
      }
    }
  }
}
var HARBOR_VALIDATOR = `import sys,json,hashlib,pathlib
from importlib.metadata import version
if version('harbor') != '${ATIF_HARBOR_VERSION}':
 print(json.dumps({'status':'unavailable','code':'HARBOR_VERSION_MISMATCH'}));sys.exit(0)
import harbor.models.trajectories as package
from harbor.models.trajectories import Trajectory
root=pathlib.Path(package.__file__).parent
files=[(p.name,p.read_text()) for p in sorted(root.glob('*.py'))]
model_digest='sha256:'+hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
document=json.loads(sys.stdin.read().removeprefix(chr(0xfeff)))
native_status='valid'
try: Trajectory.model_validate(document)
except Exception: native_status='invalid'
compatibility=[]
def diagnostic(code,pointer):
 return {'code':code,'pointer':pointer} if len(json.dumps(pointer).encode())<=512 else {'code':code+'_LOCATION_UNAVAILABLE','pointer':'#'}
def collection(value): return value if isinstance(value,list) else []
def legacy_view(trajectory,pointer='#'):
 if not isinstance(trajectory,dict): return
 if trajectory.get('schema_version') in {'ATIF-v1.2','ATIF-v1.3','ATIF-v1.4','ATIF-v1.5','ATIF-v1.6'}:
  for si,step in enumerate(collection(trajectory.get('steps'))):
   if not isinstance(step,dict): continue
   observation=step.get('observation')
   if not isinstance(observation,dict): continue
   for ri,result in enumerate(collection(observation.get('results'))):
    if not isinstance(result,dict): continue
    for fi,ref in enumerate(collection(result.get('subagent_trajectory_ref'))):
     if isinstance(ref,dict) and isinstance(ref.get('session_id'),str) and ref.get('trajectory_id') is None and ref.get('trajectory_path') is None:
      ref['trajectory_path']='ebo-validation-unresolved-legacy-reference'
      compatibility.append(diagnostic('PRE_V1_7_SESSION_REFERENCE_VALIDATION_VIEW',pointer+'/steps/'+str(si)+'/observation/results/'+str(ri)+'/subagent_trajectory_ref/'+str(fi)))
 for ci,child in enumerate(collection(trajectory.get('subagent_trajectories'))): legacy_view(child,pointer+'/subagent_trajectories/'+str(ci))
if native_status=='invalid': legacy_view(document)
base={'modelDigest':model_digest,'nativeModelStatus':native_status,'compatibilityDiagnostics':compatibility[:32],
 'compatibilityDiagnosticCount':len(compatibility),'compatibilityDiagnosticsTruncated':len(compatibility)>32}
try:
 Trajectory.model_validate(document)
 print(json.dumps(dict(base,status='valid',diagnostics=[])))
except Exception as error:
 locations=error.errors(include_input=False,include_context=False,include_url=False) if hasattr(error,'errors') else []
 diagnostics=[diagnostic('HARBOR_STRUCTURAL_INVALID','#/'+ '/'.join(str(x).replace('~','~0').replace('/','~1') for x in e['loc'])) for e in locations[:32]]
 print(json.dumps(dict(base,status='invalid',diagnostics=diagnostics or [{'code':'HARBOR_STRUCTURAL_INVALID','pointer':'#'}])))
`;

// src/atif-profiles.ts
init_artifacts();
var HARBOR_PI_CONVERTER_DIGEST = "sha256:5d51eddbbbf8f5bcab2263fe3ada99bd9611add2e857c4b7d4f4c2eb3a2a5487";
var HLB_PI_WRAPPER_DIGEST = "sha256:e98d1ab28990388683c46652223de9338b55d0aedca756190932bfd6e25593a6";
var HLB_PI_PILOT_REVISION = "0583ba55ac8ddaea3464c85b54828baeaa8d834a";
var commonRules = {
  operationIdentity: "document-scoped-native-tool-call-id",
  resultFailure: "pi-result-extra-is-error",
  inputTokens: "inclusive-prompt-minus-cache-read-and-write",
  usageAuthority: "step-metrics-reconciled-with-root-final",
  inferenceCount: "declared-llm-call-count",
  nativeRequests: "unavailable",
  copiedContext: "exclude-new-behavior",
  gaps: "withhold-exact-attempt-measures",
  context: "pi-event-type-and-explicit-transformations",
  branchSelection: "active-root-to-leaf",
  termination: "source-declared-not-owned"
};
var limitations = [
  "THIRD_PARTY_SOURCE",
  "CAPTURE_COMPLETENESS_UNPROVEN",
  "BRANCH_HISTORY_MAY_BE_OMITTED",
  "CONVERTER_ZERO_FILL_POSSIBLE",
  "NATIVE_REQUEST_IDENTITIES_UNAVAILABLE"
];
var converter = { id: "harbor.agents.installed.pi.Pi", packageVersion: "0.24.0", sourceDigest: HARBOR_PI_CONVERTER_DIGEST };
var profile = (agentVersion, context) => ({
  schemaVersion: "ebo.atif-producer-profile/v1",
  id: `pi/harbor-0.24.0/atif-1.7/agent-${agentVersion}/${context.kind}${context.revision === null ? "" : `-${context.revision}`}`,
  version: "1.0.0",
  harness: context.kind === "harbor" ? "atif.harbor.pi" : "atif.harness-leaderboard.pi",
  producer: { formatVersion: "ATIF-v1.7", agent: { name: "pi", version: agentVersion }, converter: { ...converter }, context: { ...context } },
  rules: { ...commonRules },
  limitations: [...limitations, ...agentVersion === "unknown" ? ["AGENT_VERSION_UNREPORTED"] : []],
  sources: ["https://pypi.org/project/harbor/0.24.0/", ...context.kind === "harness-leaderboard" ? [
    `https://huggingface.co/spaces/joelniklaus/harness-leaderboard/blob/${HLB_PI_PILOT_REVISION}/hlb/harbor_ext/agents.py`,
    `https://huggingface.co/spaces/joelniklaus/harness-leaderboard/blob/${HLB_PI_PILOT_REVISION}/uv.lock`
  ] : []]
});
var profiles = [
  profile("unknown", { kind: "harbor", revision: null, wrapperDigest: null }),
  profile("1.2.0", { kind: "harness-leaderboard", revision: HLB_PI_PILOT_REVISION, wrapperDigest: HLB_PI_WRAPPER_DIGEST })
];
var registry = new Map(profiles.map((value) => [canonicalizeMetadata(value.producer), value]));
function selectAtifProducerProfile(producer) {
  let selected;
  try {
    selected = registry.get(canonicalizeMetadata(producer));
  } catch {
  }
  return selected === void 0 ? { status: "unsupported", reason: "PRODUCER_PROFILE_UNREGISTERED" } : { status: "supported", profile: structuredClone(selected), profileDigest: `sha256:${digestMetadata(selected).value}` };
}

// src/atif-pi.ts
init_artifacts();

// src/evidence-pointers.ts
init_artifacts();
function readEvidencePointer(document, locator) {
  if (locator === "#") return { found: true, value: document };
  if (!locator.startsWith("#/")) return { found: false };
  let current = document;
  for (const encoded of locator.slice(2).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return { found: false };
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) return { found: false };
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property === void 0 || !("value" in property)) return { found: false };
      current = property.value;
    } else {
      if (current === null || typeof current !== "object") return { found: false };
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (property === void 0 || !("value" in property)) return { found: false };
      current = property.value;
    }
  }
  return { found: true, value: current };
}
function createPointerEvidenceResolver(input) {
  const records = /* @__PURE__ */ new Map();
  for (const { reference, record: record3 } of input.records) {
    if (!validLocator(reference.recordLocator)) throw new Error("Pointer evidence records require valid # JSON-pointer locators.");
    const key = referenceKey(reference);
    if (records.has(key)) throw new Error("Pointer evidence contains duplicate record references.");
    assertJsonData(record3);
    const value = structuredClone(record3);
    records.set(key, { reference: { ...reference }, value, digest: digest(value) });
  }
  const containing = (reference, strict = false) => {
    if (!validLocator(reference.recordLocator)) return void 0;
    let locator = strict ? parentLocator(reference.recordLocator) : reference.recordLocator;
    while (locator !== void 0) {
      const entry = records.get(referenceKey({ artifactId: reference.artifactId, recordLocator: locator }));
      if (entry !== void 0) return entry;
      locator = parentLocator(locator);
    }
    return void 0;
  };
  for (const entry of records.values()) {
    const parent = containing(entry.reference, true);
    if (parent === void 0) continue;
    const value = readEvidencePointer(parent.value, relativePointer(parent.reference.recordLocator, entry.reference.recordLocator));
    if (!value.found || canonicalizeMetadata(value.value) !== canonicalizeMetadata(entry.value)) {
      throw new Error("Nested pointer evidence conflicts with its retained containing record.");
    }
  }
  const read = (reference) => {
    const parent = containing(reference);
    if (parent === void 0) return void 0;
    const result = readEvidencePointer(parent.value, relativePointer(parent.reference.recordLocator, reference.recordLocator));
    if (!result.found) return void 0;
    return {
      value: structuredClone(result.value),
      containingReference: { ...parent.reference },
      containingDigest: parent.digest,
      pointedDigest: digest(result.value)
    };
  };
  return {
    read,
    resolve(reference) {
      const result = read(reference);
      return result === void 0 ? false : { runId: input.runId, attemptId: input.attemptId, digest: result.pointedDigest };
    }
  };
}
function validLocator(locator) {
  return (locator === "#" || locator.startsWith("#/")) && !/~(?:[^01]|$)/u.test(locator);
}
function parentLocator(locator) {
  if (locator === "#") return void 0;
  const slash = locator.lastIndexOf("/");
  return slash <= 1 ? "#" : locator.slice(0, slash);
}
function relativePointer(parent, child) {
  return `#${child.slice(parent.length)}`;
}
function referenceKey(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
function digest(value) {
  return `sha256:${digestMetadata(value).value}`;
}
function assertJsonData(value, ancestors = /* @__PURE__ */ new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || depth > 128) throw new Error("Pointer records require bounded JSON data.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) throw new Error("Pointer records require plain, acyclic JSON data.");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const property = descriptors[String(index)];
        if (property === void 0 || !("value" in property) || !property.enumerable) throw new Error("Pointer records require dense arrays with own data properties.");
        assertJsonData(property.value, ancestors, depth + 1);
      }
      if (Object.keys(descriptors).some((key) => key !== "length" && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
        throw new Error("Pointer arrays cannot contain non-JSON properties.");
      }
    } else for (const property of Object.values(descriptors)) {
      if (!("value" in property) || !property.enumerable) throw new Error("Pointer records require enumerable data properties, without accessors.");
      assertJsonData(property.value, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

// src/normalization-integrity.ts
init_artifacts();

// src/uniform-events.ts
init_artifacts();
var UNIFORM_EVENT_FAMILIES = [
  "message",
  "model-request",
  "tool",
  "context",
  "permission",
  "delegation",
  "artifact",
  "validation",
  "runtime",
  "outcome"
];
async function validateUniformEvents(events, resolver) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    assertValidArtifact(`uniform event ${event.id}`, event);
    if (ids.has(event.id)) throw new Error(`Duplicate uniform event ID "${event.id}".`);
    ids.add(event.id);
  }
  for (const event of events) {
    await assertResolvable(event.source.nativeReference, resolver);
    if (event.content.status === "known") {
      for (const content of event.content.value) await assertResolvable(content.nativeReference, resolver);
    }
    const relationTargets = [
      ...event.relations.parent.status === "known" ? [event.relations.parent.value] : [],
      ...event.relations.known.map(({ eventId }) => eventId)
    ];
    if (relationTargets.some((eventId) => !ids.has(eventId))) {
      throw new Error(`Uniform event "${event.id}" has an unresolved event relation.`);
    }
  }
  const parentById = new Map(events.flatMap((event) => event.relations.parent.status === "known" ? [[event.id, event.relations.parent.value]] : []));
  const resolved = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (resolved.has(event.id)) continue;
    const ancestry = /* @__PURE__ */ new Set();
    const path = [];
    let current = event.id;
    while (current !== void 0 && !resolved.has(current)) {
      if (ancestry.has(current)) throw new Error(`Uniform event "${event.id}" has cyclic parentage.`);
      ancestry.add(current);
      path.push(current);
      current = parentById.get(current);
    }
    for (const eventId of path) resolved.add(eventId);
  }
}
function assertValidArtifact(artifact, document) {
  const errors = validateArtifact(artifact, document);
  if (errors.length > 0) {
    throw new Error(errors.map(({ field, message }) => `${artifact} ${field}: ${message}`).join("\n"));
  }
}
async function assertResolvable(reference, resolver) {
  if (!await resolver.resolve(reference)) {
    throw new Error(`Native evidence reference ${reference.artifactId}:${reference.recordLocator} is unresolved.`);
  }
}

// src/normalization-integrity.ts
function describeNormalizedDataset(input) {
  if (!["qualified", "qualified-with-gaps"].includes(input.capture.qualification)) {
    throw new Error("Normalized datasets require capture-qualified evidence.");
  }
  return describeEvidenceDataset(input);
}
function describeImportedDataset(input) {
  if (input.capture.qualification !== "imported" || input.origin.kind !== "imported" || input.origin.qualification !== "imported" || input.origin.exactAttemptMeasures !== "unavailable") throw new Error("Imported datasets require imported provenance and explicit attempt-measure limits.");
  const normalization = { ...input.normalization, events: input.normalization.events.map((event) => ({
    ...event,
    attributes: { ...event.attributes, evidenceOrigin: "imported" }
  })) };
  return { ...describeEvidenceDataset({ ...input, normalization }), origin: structuredClone(input.origin) };
}
function describeEvidenceDataset(input) {
  const nativeRecords = input.capture.records.map(({ reference, record: record3 }) => ({
    reference: structuredClone(reference),
    nativeType: required(input.nativeType(record3), "Native record type"),
    digest: digestString(digestMetadata(record3))
  }));
  const nativeDigests = new Map(nativeRecords.map((record3) => [referenceKey2(record3.reference), record3.digest]));
  const contentReferences = /* @__PURE__ */ new Map();
  for (const event of input.normalization.events) {
    if (event.content.status !== "known") continue;
    for (const { nativeReference: reference } of event.content.value) {
      const key = referenceKey2(reference);
      const containing = containingReference(reference);
      const digest5 = input.contentDigestPolicy === "canonical-json-pointers/v1" && reference.recordLocator.startsWith("#") ? input.contentDigest?.(reference) : nativeDigests.get(key) ?? (containing === void 0 ? void 0 : nativeDigests.get(referenceKey2(containing))) ?? input.contentDigest?.(reference);
      if (digest5 === void 0) throw new Error(`Content reference ${formatReference(reference)} requires a trusted digest.`);
      const existing = contentReferences.get(key);
      if (existing !== void 0 && existing.digest !== digest5) {
        throw new Error(`Content reference ${formatReference(reference)} has conflicting digests.`);
      }
      contentReferences.set(key, { reference: structuredClone(reference), digest: digest5 });
    }
  }
  return {
    schemaVersion: "ebo.normalized-dataset/v1",
    runId: input.capture.runId,
    attemptId: input.capture.attemptId,
    adapter: {
      id: input.capabilityProfile.adapterId,
      version: required(input.adapterVersion, "Adapter version"),
      harness: input.capabilityProfile.harness
    },
    capabilityProfile: structuredClone(input.capabilityProfile),
    nativeRecords,
    contentReferences: [...contentReferences.values()],
    events: structuredClone(input.normalization.events),
    unmapped: structuredClone(input.normalization.unmapped)
  };
}
function createCapturedNativeEvidenceResolver(capture, fallback) {
  const records = new Map(capture.records.map(({ reference, record: record3 }) => [
    referenceKey2(reference),
    {
      record: record3,
      resolution: {
        runId: capture.runId,
        attemptId: capture.attemptId,
        digest: digestString(digestMetadata(record3))
      }
    }
  ]));
  return {
    async resolve(reference) {
      const exact = records.get(referenceKey2(reference));
      if (exact !== void 0) return exact.resolution;
      const fallbackResolution = await fallback?.resolve(reference);
      if (fallbackResolution) {
        if (typeof fallbackResolution !== "boolean") {
          return fallbackResolution.runId === capture.runId && fallbackResolution.attemptId === capture.attemptId ? fallbackResolution : false;
        }
        const containing2 = containingNativeRecord(records, reference);
        return containing2 !== void 0 && resolvesJsonPointer(containing2.record, reference.recordLocator) ? containing2.resolution : false;
      }
      const containing = containingNativeRecord(records, reference);
      if (containing !== void 0 && resolvesJsonPointer(containing.record, reference.recordLocator)) {
        return containing.resolution;
      }
      return false;
    }
  };
}
async function validateNormalizedDataset(dataset, resolver) {
  assertValidArtifact2("normalized dataset", dataset);
  if (dataset.adapter.id !== dataset.capabilityProfile.adapterId || dataset.adapter.harness !== dataset.capabilityProfile.harness) {
    throw new Error("Normalized dataset adapter identity does not match its capability profile.");
  }
  const recordByReference = /* @__PURE__ */ new Map();
  for (const record3 of dataset.nativeRecords) {
    const key = referenceKey2(record3.reference);
    if (recordByReference.has(key)) throw new Error("Normalized dataset contains duplicate native records.");
    recordByReference.set(key, record3);
    const resolution = await resolver.resolve(record3.reference);
    if (resolution === false) throw unresolved(record3.reference);
    if (typeof resolution === "boolean") {
      throw new Error(`Native evidence reference ${formatReference(record3.reference)} lacks run and digest integrity metadata.`);
    }
    assertResolution(dataset, record3, resolution);
  }
  const contentByReference = /* @__PURE__ */ new Map();
  for (const content of dataset.contentReferences) {
    const key = referenceKey2(content.reference);
    if (contentByReference.has(key)) throw new Error("Normalized dataset contains duplicate content references.");
    contentByReference.set(key, content);
  }
  const usedContent = /* @__PURE__ */ new Set();
  for (const event of dataset.events) {
    if (event.content.status !== "known") continue;
    for (const content of event.content.value) {
      const key = referenceKey2(content.nativeReference);
      if (!contentByReference.has(key)) {
        throw new Error(`Content reference ${formatReference(content.nativeReference)} has no expected digest.`);
      }
      usedContent.add(key);
    }
  }
  if ([...contentByReference.keys()].some((key) => !usedContent.has(key))) {
    throw new Error("Normalized dataset contains an unreferenced content digest.");
  }
  const ownedResolver = {
    async resolve(reference) {
      const resolution = await resolver.resolve(reference);
      const expectedContent = contentByReference.get(referenceKey2(reference));
      return typeof resolution === "object" && resolution.runId === dataset.runId && resolution.attemptId === dataset.attemptId && (expectedContent === void 0 || resolution.digest === expectedContent.digest) ? resolution : false;
    }
  };
  await validateUniformEvents(dataset.events, ownedResolver);
  const mapped = /* @__PURE__ */ new Set();
  for (const event of dataset.events) {
    if (event.runId !== dataset.runId || event.attemptId !== dataset.attemptId) {
      throw new Error(`Uniform event "${event.id}" belongs to the wrong run or attempt.`);
    }
    if (event.source.harness !== dataset.adapter.harness) {
      throw new Error(`Uniform event "${event.id}" belongs to the wrong harness.`);
    }
    const key = referenceKey2(event.source.nativeReference);
    const record3 = recordByReference.get(key);
    if (record3 === void 0) throw new Error(`Uniform event "${event.id}" does not identify a captured native record.`);
    if (record3.nativeType !== event.source.nativeType) {
      throw new Error(`Uniform event "${event.id}" native type does not match its captured record.`);
    }
    if (!dataset.capabilityProfile.nativeTypes.includes(event.source.nativeType)) {
      throw new Error(`Uniform event "${event.id}" uses undeclared native type "${event.source.nativeType}".`);
    }
    if (dataset.capabilityProfile.families[event.family].status === "unsupported") {
      throw new Error(`Uniform event "${event.id}" uses unsupported event family "${event.family}".`);
    }
    assertEvidenceCapability(dataset.capabilityProfile.evidence.nativeOrder, event.nativeOrder.status, "nativeOrder");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.nativeTime, event.nativeTime.status, "nativeTime");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.parentage, event.relations.parent.status, "parentage");
    assertEvidenceCapability(dataset.capabilityProfile.evidence.content, event.content.status, "content");
    if (dataset.capabilityProfile.evidence.parentage.status === "unsupported" && event.relations.known.length > 0) {
      throw new Error(`Uniform event "${event.id}" contradicts unsupported parentage.`);
    }
    mapped.add(key);
  }
  assertSourceLocalOrder(dataset);
  const unmapped = /* @__PURE__ */ new Set();
  for (const entry of dataset.unmapped) {
    const key = referenceKey2(entry.reference);
    if (unmapped.has(key)) throw new Error("Normalized dataset lists a native record as unmapped more than once.");
    if (!recordByReference.has(key)) throw new Error("Normalized dataset lists an uncaptured native record as unmapped.");
    unmapped.add(key);
  }
  for (const key of recordByReference.keys()) {
    if (mapped.has(key) === unmapped.has(key)) {
      throw new Error("Every native record must be mapped or explicitly retained as unmapped.");
    }
  }
  return coverageReport(dataset, mapped, unmapped);
}
function assessComparisonEligibility(request) {
  assertValidArtifact2("comparison request", request);
  const blockers = [];
  const caveats = [];
  const origin = (candidate) => candidate.evidenceOrigin?.kind === "imported" || candidate.harness.id.startsWith("atif.") ? "imported" : "owned";
  if (origin(request.left) !== origin(request.right)) blockers.push({
    code: "evidence-origin-mismatch",
    dimension: "evidence origin",
    detail: "Cross-origin comparison has no registered profile-and-measure invariance gate."
  });
  const imported = [request.left, request.right].filter((candidate) => origin(candidate) === "imported");
  if (imported.some((candidate) => candidate.evidenceOrigin?.kind !== "imported" || candidate.evidenceOrigin.profileDigest === void 0) || imported.length === 2 && imported[0].evidenceOrigin.profileDigest !== imported[1].evidenceOrigin.profileDigest) {
    blockers.push({ code: "producer-profile-mismatch", dimension: "producer profile", detail: "Imported comparison requires the same explicitly bound producer profile." });
  }
  compareExact(request.left.task, request.right.task, "task", "task-mismatch", blockers);
  compareExact(request.left.fixture, request.right.fixture, "fixture", "fixture-mismatch", blockers);
  for (const [dimension, left, right] of [
    ["assessment mode", request.left.assessmentMode, request.right.assessmentMode],
    ["capture profile", request.left.captureProfileDigest, request.right.captureProfileDigest],
    ["budget", request.left.budgetDigest, request.right.budgetDigest],
    ["tool policy", request.left.toolPolicyDigest, request.right.toolPolicyDigest]
  ]) {
    if (left !== right) blockers.push({
      code: "material-configuration-mismatch",
      dimension,
      detail: `${dimension} differs between the proposed comparison candidates.`
    });
  }
  compareDeclaredCondition("model", request.left.model, request.right.model, request.policy.declaredDifferences, blockers, caveats);
  compareDeclaredCondition("harness", request.left.harness, request.right.harness, request.policy.declaredDifferences, blockers, caveats);
  if (request.left.harness.id === request.right.harness.id && (request.left.capabilityProfile.adapterId !== request.right.capabilityProfile.adapterId || request.left.adapterVersion !== request.right.adapterVersion)) {
    blockers.push({
      code: "material-configuration-mismatch",
      dimension: "normalization adapter",
      detail: "normalization adapter identity differs for the same harness condition."
    });
  }
  for (const capability of request.policy.requiredCapabilities) {
    for (const candidate of [request.left, request.right]) {
      const value = candidateCapability(candidate, capability);
      if (value.status === "unsupported") blockers.push({
        code: "capability-unsupported",
        dimension: capability,
        detail: `${candidate.id} does not support required capability ${capability}.`
      });
      else if (value.status === "partial") caveats.push({
        code: "capability-partial",
        dimension: capability,
        detail: `${candidate.id} only partially supports required capability ${capability}.`
      });
    }
  }
  const reasons = [...blockers, ...caveats];
  const report = {
    schemaVersion: "ebo.comparison-report/v2",
    measure: request.measure,
    requestDigest: `sha256:${digestMetadata(request).value}`,
    status: blockers.length > 0 ? "unsupported" : caveats.length > 0 ? "qualified-with-caveats" : "supported",
    candidates: [request.left.id, request.right.id],
    policy: structuredClone(request.policy),
    reasons
  };
  assertValidArtifact2("comparison report", report);
  return report;
}
function coverageReport(dataset, mapped, unmapped) {
  const nativeTypes = /* @__PURE__ */ new Map();
  for (const record3 of dataset.nativeRecords) {
    const counts = nativeTypes.get(record3.nativeType) ?? { total: 0, mapped: 0, unmapped: 0 };
    counts.total += 1;
    if (mapped.has(referenceKey2(record3.reference))) counts.mapped += 1;
    else counts.unmapped += 1;
    nativeTypes.set(record3.nativeType, counts);
  }
  const report = {
    schemaVersion: "ebo.adapter-coverage-report/v1",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    adapter: structuredClone(dataset.adapter),
    records: { total: dataset.nativeRecords.length, mapped: mapped.size, unmapped: unmapped.size },
    nativeTypes: [...nativeTypes].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([nativeType, counts]) => ({ nativeType, ...counts })),
    families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, {
      capability: structuredClone(dataset.capabilityProfile.families[family]),
      observedEvents: dataset.events.filter((event) => event.family === family).length
    }])),
    evidence: structuredClone(dataset.capabilityProfile.evidence)
  };
  assertValidArtifact2("adapter coverage report", report);
  return report;
}
function assertResolution(dataset, record3, resolution) {
  if (resolution.runId !== dataset.runId || resolution.attemptId !== dataset.attemptId) {
    throw new Error(`Native evidence reference ${formatReference(record3.reference)} resolves to the wrong run or attempt.`);
  }
  if (resolution.digest !== record3.digest) {
    throw new Error(`Native evidence reference ${formatReference(record3.reference)} has a digest mismatch.`);
  }
}
function assertSourceLocalOrder(dataset) {
  const last = /* @__PURE__ */ new Map();
  for (const event of dataset.events) {
    if (event.nativeOrder.status !== "known") continue;
    const previous = last.get(event.nativeOrder.domain);
    if (previous !== void 0 && event.nativeOrder.value < previous) {
      throw new Error(`Uniform event "${event.id}" violates source-local order domain "${event.nativeOrder.domain}".`);
    }
    last.set(event.nativeOrder.domain, event.nativeOrder.value);
  }
}
function compareExact(left, right, dimension, code, blockers) {
  if (canonicalizeMetadata(left) !== canonicalizeMetadata(right)) blockers.push({
    code,
    dimension,
    detail: `${dimension} identity or digest differs between the proposed comparison candidates.`
  });
}
function compareDeclaredCondition(dimension, left, right, declared, blockers, caveats) {
  if (canonicalizeMetadata(left) === canonicalizeMetadata(right)) return;
  if (!declared.includes(dimension)) {
    blockers.push({
      code: dimension === "model" ? "undeclared-model-difference" : "undeclared-harness-difference",
      dimension,
      detail: `${dimension} differs but is not declared by the comparison policy.`
    });
    return;
  }
  caveats.push({
    code: dimension === "model" ? "declared-model-difference" : "declared-harness-difference",
    dimension,
    detail: `${dimension} differs as declared; results are qualified and do not establish causality.`
  });
}
function candidateCapability(candidate, capability) {
  const [kind, name] = capability.split(":");
  return kind === "family" ? candidate.capabilityProfile.families[name] : candidate.capabilityProfile.evidence[name];
}
function assertEvidenceCapability(capability, evidenceStatus, field) {
  if (capability.status === "unsupported" !== (evidenceStatus === "unsupported") && capability.status !== "partial") {
    throw new Error(`Adapter evidence capability contradicts event ${field}.`);
  }
}
function assertValidArtifact2(label, value) {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}
function digestString(digest5) {
  return `${digest5.algorithm}:${digest5.value}`;
}
function required(value, label) {
  if (value.trim() === "") throw new Error(`${label} is required.`);
  return value;
}
function referenceKey2(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
function containingNativeRecord(records, reference) {
  const containing = containingReference(reference);
  return containing === void 0 ? void 0 : records.get(referenceKey2(containing));
}
function containingReference(reference) {
  const pointer = reference.recordLocator.indexOf("#");
  const base = pointer > 0 ? reference.recordLocator.slice(0, pointer) : pointer === 0 && reference.recordLocator.startsWith("#/") ? "#" : void 0;
  return base === void 0 ? void 0 : { ...reference, recordLocator: base };
}
function resolvesJsonPointer(document, locator) {
  const hash3 = locator.indexOf("#");
  if (hash3 < 0) return false;
  const pointer = locator.slice(hash3 + 1);
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return false;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) return false;
      current = current.at(Number(key));
      continue;
    }
    if (typeof current !== "object" || current === null) return false;
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property === void 0 || !("value" in property)) return false;
    current = property.value;
  }
  return true;
}
function formatReference(reference) {
  return `${reference.artifactId}:${reference.recordLocator}`;
}
function unresolved(reference) {
  return new Error(`Native evidence reference ${formatReference(reference)} is unresolved.`);
}

// src/atif-pi.ts
var hash = (value) => `sha256:${digestMetadata(value).value}`;
var object2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
var array2 = (value) => Array.isArray(value) ? value : [];
var missing = (reason) => ({ status: "unavailable", reason });
var count = (value, unit) => ({ status: "known", value, unit });
var integer = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
async function normalizePiAtif(input) {
  const { inspection, document } = input.read;
  if (document === void 0 || inspection.versionPolicy.status !== "supported" || inspection.structural.status !== "valid") {
    throw new Error("ATIF admission requires supported source versions and valid pinned structural validation.");
  }
  if (input.producer.formatVersion !== document.schema_version || input.producer.agent.name !== object2(document.agent).name || input.producer.agent.version !== (object2(document.agent).version ?? null)) throw new Error("Producer declaration differs from the retained trajectory.");
  const selection = selectAtifProducerProfile(input.producer);
  const artifactId = input.artifactId ?? "atif-trajectory";
  const reference = (recordLocator) => ({ artifactId, recordLocator });
  const records = inspection.records.map(({ pointer }) => {
    const value = readEvidencePointer(document, pointer);
    if (!value.found) throw new Error("ATIF pointer inventory does not resolve.");
    return { reference: reference(pointer), record: value.value };
  });
  const pointerTypes = new Map(inspection.records.map(({ pointer, kind }) => [pointer, `atif:${kind}`]));
  const nativeTypes = new Map(records.map((record3, index) => [record3.record, `atif:${inspection.records[index].kind}`]));
  const capture = { runId: input.runId, attemptId: input.attemptId, qualification: "imported", records };
  const resolver = createPointerEvidenceResolver(capture);
  const events = [];
  const limitations2 = new Set(inspection.limitations);
  const mapping = {
    schemaVersion: "ebo.pi-atif-mapping/v1",
    scope: "retained-selected-trajectory",
    producerStatus: selection.status,
    limitations: [],
    recorded: { calls: null, linkedResults: null, copiedStepsExcluded: null, contextOnlyStepsExcluded: null },
    signatures: [],
    measures: {}
  };
  const harness = selection.status === "supported" ? selection.profile.harness : "atif.unregistered";
  const agentSteps = [];
  const usageDocuments = [];
  let gap = false;
  const emit = (step, stepPointer, pointer, suffix, family, phase, attributes, contentPointer, operation2) => {
    const documentPointer = stepPointer.slice(0, stepPointer.lastIndexOf("/steps/"));
    const pointedDocument = readEvidencePointer(document, documentPointer);
    const sourceDocument = object2(pointedDocument.found ? pointedDocument.value : void 0);
    events.push({
      schemaVersion: "ebo.uniform-event/v1",
      id: `${pointer}/${suffix}`,
      runId: input.runId,
      attemptId: input.attemptId,
      family,
      phase,
      source: { harness, nativeType: pointerTypes.get(pointer) ?? "atif:step", nativeReference: reference(pointer) },
      nativeOrder: { status: "known", value: Number(step.step_id), domain: `${artifactId}:${documentPointer}` },
      nativeTime: { status: "unsupported", reason: "PER_OPERATION_CLOCK_NOT_RECORDED" },
      actor: { kind: family === "tool" && phase === "after" ? "tool" : step.source === "agent" ? family === "message" ? "model" : "agent" : step.source === "user" ? "user" : "system" },
      scope: operation2 === void 0 ? { kind: "session", id: `document:${documentPointer}` } : { kind: "operation", id: operation2 },
      relations: { parent: { status: "unsupported", reason: "PARENTAGE_NOT_ESTABLISHED" }, known: [] },
      attributes: {
        ...attributes,
        documentScope: documentPointer,
        ...typeof sourceDocument.session_id === "string" ? { sessionId: sourceDocument.session_id } : {},
        ...typeof sourceDocument.trajectory_id === "string" ? { agentId: sourceDocument.trajectory_id } : {},
        ...step.llm_call_count === 1 ? { inferenceId: `${artifactId}:${stepPointer}`, inferenceIdentitySource: "declared-single-inference-step" } : {}
      },
      content: { status: "known", value: contentPointer === void 0 ? [] : [{ nativeReference: reference(contentPointer), role: family === "tool" ? phase === "before" ? "tool-input" : "tool-result" : "message" }] }
    });
  };
  const visit = (trajectory, pointer, contextOnly) => {
    if (!contextOnly) {
      for (const [index, value] of array2(trajectory.steps).entries()) {
        const step = object2(value), location = `${pointer}/steps/${index}`;
        if (Object.hasOwn(step, "is_copied_context") && typeof step.is_copied_context !== "boolean" || !integer(step.step_id) || Number(step.step_id) < 1 || step.llm_call_count !== void 0 && step.llm_call_count !== null && !integer(step.llm_call_count)) {
          throw new Error(`Pi projection requires canonical flag and ordinal fields at ${location}.`);
        }
      }
    }
    const documentSteps = [];
    if (!contextOnly) usageDocuments.push({ trajectory, steps: documentSteps });
    if (object2(trajectory.extra).partial) {
      gap = true;
      limitations2.add("PRODUCER_PARTIAL_HISTORY");
    }
    const roles = /* @__PURE__ */ new Map();
    const childIds = /* @__PURE__ */ new Map();
    for (const child of array2(trajectory.subagent_trajectories)) {
      const id = object2(child).trajectory_id;
      childIds.set(id, (childIds.get(id) ?? 0) + 1);
    }
    const callFrequency = /* @__PURE__ */ new Map();
    for (const value of array2(trajectory.steps)) {
      const step = object2(value);
      if (step.is_copied_context === true || object2(step.extra).added_by === "hlb") continue;
      for (const value2 of array2(step.tool_calls)) {
        const id = object2(value2).tool_call_id;
        callFrequency.set(id, (callFrequency.get(id) ?? 0) + 1);
      }
    }
    for (const value of array2(trajectory.steps)) {
      const step = object2(value), extra = object2(step.extra);
      const context = ["compaction", "branch_summary"].includes(String(extra.pi_event_type ?? object2(extra.context_management).type));
      for (const result of array2(object2(step.observation).results)) for (const ref of array2(object2(result).subagent_trajectory_ref)) {
        const id = object2(ref).trajectory_id;
        if (typeof id !== "string") continue;
        const role = contextOnly || step.is_copied_context === true || extra.added_by === "hlb" ? "borrowed" : context ? "summary" : "delegated";
        const values = roles.get(id) ?? /* @__PURE__ */ new Set();
        values.add(role);
        roles.set(id, values);
      }
    }
    for (const [index, value] of array2(trajectory.steps).entries()) {
      const step = object2(value), extra = object2(step.extra), stepPointer = `${pointer}/steps/${index}`;
      if (step.is_copied_context === true) {
        mapping.recorded.copiedStepsExcluded = (mapping.recorded.copiedStepsExcluded ?? 0) + 1;
        continue;
      }
      if (contextOnly) {
        mapping.recorded.contextOnlyStepsExcluded = (mapping.recorded.contextOnlyStepsExcluded ?? 0) + 1;
        continue;
      }
      if (extra.added_by === "hlb") {
        gap = true;
        limitations2.add("CONVERSION_GAP");
        continue;
      }
      if (step.source === "agent") {
        agentSteps.push(step);
        documentSteps.push(step);
      }
      const contextType = extra.pi_event_type ?? object2(extra.context_management).type;
      if (["compaction", "branch_summary"].includes(String(contextType))) {
        emit(step, stepPointer, stepPointer, "context", "context", "instant", {
          contextManagementType: String(contextType),
          ...contextType === "compaction" ? { subtype: "compact_boundary" } : {}
        }, typeof step.message === "string" || Array.isArray(step.message) ? `${stepPointer}/message` : void 0);
        continue;
      }
      if ((typeof step.message === "string" || Array.isArray(step.message)) && step.message.length > 0) emit(
        step,
        stepPointer,
        stepPointer,
        "message",
        "message",
        "after",
        { role: step.source === "agent" ? "assistant" : String(step.source) },
        `${stepPointer}/message`
      );
      const calls = array2(step.tool_calls).map(object2);
      mapping.recorded.calls = (mapping.recorded.calls ?? 0) + calls.length;
      const duplicates = new Set(calls.filter((call) => (callFrequency.get(call.tool_call_id) ?? 0) > 1).map((call) => call.tool_call_id));
      const resultsById = /* @__PURE__ */ new Map();
      for (const [resultIndex, value2] of array2(object2(step.observation).results).entries()) {
        const result = object2(value2), values = resultsById.get(result.source_call_id) ?? [];
        values.push({ result, resultIndex });
        resultsById.set(result.source_call_id, values);
      }
      if (duplicates.size) {
        gap = true;
        limitations2.add("DUPLICATE_OPERATION_ID");
      }
      for (const [position, call] of calls.entries()) {
        const id = call.tool_call_id, name = call.function_name;
        if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || duplicates.has(id)) {
          gap = true;
          limitations2.add("MALFORMED_OPERATION_IDENTITY");
          continue;
        }
        const scoped = `${pointer}:${id}`, callPointer = `${stepPointer}/tool_calls/${position}`;
        const results = resultsById.get(id) ?? [];
        const statuses = results.map(({ result: result2 }) => object2(result2.extra).is_error);
        const failed = statuses.length === 1 && typeof statuses[0] === "boolean" ? statuses[0] : null;
        mapping.signatures.push({ document: pointer, id, name, failed });
        const attrs = { toolCallId: scoped, nativeToolCallId: id, toolName: name, operationIdentitySource: "document-scoped-native-id" };
        emit(step, stepPointer, callPointer, "call", "tool", "before", {
          ...attrs,
          ...Object.keys(object2(call.arguments)).length === 0 ? { inputMayBeZeroFilled: true } : { inputDigest: hash(call.arguments) }
        }, `${callPointer}/arguments`, scoped);
        if (results.length !== 1) {
          limitations2.add(results.length ? "AMBIGUOUS_RESULT_LINK" : "PENDING_CALL");
          continue;
        }
        const { result, resultIndex } = results[0];
        const resultPointer = `${stepPointer}/observation/results/${resultIndex}`;
        mapping.recorded.linkedResults = (mapping.recorded.linkedResults ?? 0) + 1;
        if (failed === null) limitations2.add("TOOL_RESULT_STATUS_INCOMPLETE");
        emit(
          step,
          stepPointer,
          resultPointer,
          "result",
          "tool",
          "after",
          {
            ...attrs,
            ...failed === null ? {} : { producerIsError: failed },
            ...failed === true ? { isError: true } : failed === false ? { successStatusUnavailable: "CONVERTER_ZERO_FILL_POSSIBLE" } : {}
          },
          result.content === void 0 ? void 0 : `${resultPointer}/content`,
          scoped
        );
      }
    }
    for (const [index, value] of array2(trajectory.subagent_trajectories).entries()) {
      const child = object2(value), role = roles.get(String(child.trajectory_id));
      const duplicateId = (childIds.get(child.trajectory_id) ?? 0) > 1;
      const admitted = !duplicateId && role?.size === 1 && role.has("delegated");
      if (duplicateId) {
        gap = true;
        limitations2.add("DUPLICATE_CHILD_TRAJECTORY_ID");
      }
      if (!admitted) limitations2.add("CHILD_CONTEXT_NOT_NEW_BEHAVIOR");
      const sameProducer = child.schema_version === input.producer.formatVersion && object2(child.agent).name === input.producer.agent.name && (object2(child.agent).version ?? null) === input.producer.agent.version;
      if (!sameProducer) {
        limitations2.add("CHILD_PRODUCER_UNREGISTERED");
        gap = true;
      }
      if (role === void 0 || role.size > 1) {
        limitations2.add("CHILD_ROLE_UNRESOLVED");
        gap = true;
      }
      visit(child, `${pointer}/subagent_trajectories/${index}`, contextOnly || !admitted || !sameProducer);
    }
  };
  if (selection.status === "supported") {
    mapping.recorded = { calls: 0, linkedResults: 0, copiedStepsExcluded: 0, contextOnlyStepsExcluded: 0 };
    mapping.profileDigest = selection.profileDigest;
    selection.profile.limitations.forEach((reason) => limitations2.add(reason));
    visit(document, "#", false);
    mapping.measures["tool-operation-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : count(mapping.recorded.calls ?? 0, "identified-logical-tool-operations");
    mapping.measures["tool-error-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : mapping.signatures.some(({ failed }) => failed === null) ? missing("TOOL_RESULT_STATUS_INCOMPLETE") : count(mapping.signatures.filter(({ failed }) => failed).length, "logical-tool-operations");
    const documentUsage = usageDocuments.map(({ trajectory, steps: agentSteps2 }) => {
      const componentsComplete = agentSteps2.every((step) => step.llm_call_count === 1);
      const usageMissingReason = !componentsComplete ? "USAGE_COMPONENT_COMPLETENESS_UNPROVEN" : "STEP_USAGE_INCOMPLETE";
      if (!componentsComplete) limitations2.add("USAGE_COMPONENT_COMPLETENESS_UNPROVEN");
      const sum = (key, extra = false) => {
        if (gap || !agentSteps2.length || !componentsComplete) return void 0;
        const values = agentSteps2.map((step) => extra ? object2(object2(step.metrics).extra)[key] : object2(step.metrics)[key]);
        if (!values.every(integer)) return void 0;
        const total = values.reduce((left, right) => left + right, 0);
        return Number.isSafeInteger(total) ? total : void 0;
      };
      const prompt = sum("prompt_tokens"), cached = sum("cached_tokens"), writes = sum("cache_write_tokens", true), output = sum("completion_tokens");
      const final = object2(trajectory.final_metrics);
      const stepZero = (key) => agentSteps2.some((step) => object2(step.metrics)[key] === 0);
      const reconciled = (value, key, stepKey) => value === void 0 ? missing(usageMissingReason) : final[key] !== void 0 && final[key] !== value ? missing("STEP_FINAL_USAGE_CONFLICT") : stepZero(stepKey) ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(value, "tokens");
      const negativeStepInput = agentSteps2.some((step) => {
        const metrics = object2(step.metrics), extra = object2(metrics.extra);
        return integer(metrics.prompt_tokens) && integer(metrics.cached_tokens) && integer(extra.cache_write_tokens) && metrics.prompt_tokens - metrics.cached_tokens - extra.cache_write_tokens < 0;
      });
      const inputTokens = prompt === void 0 || cached === void 0 || writes === void 0 ? missing(usageMissingReason) : negativeStepInput || cached + writes > prompt ? missing("PI_INCLUSIVE_PROMPT_CONFLICT") : final.total_prompt_tokens !== void 0 && final.total_prompt_tokens !== prompt || final.total_cached_tokens !== void 0 && final.total_cached_tokens !== cached || object2(final.extra).cache_write_tokens !== void 0 && object2(final.extra).cache_write_tokens !== writes ? missing("STEP_FINAL_USAGE_CONFLICT") : agentSteps2.some((step) => {
        const metrics = object2(step.metrics);
        return Number(metrics.prompt_tokens) - Number(metrics.cached_tokens) - Number(object2(metrics.extra).cache_write_tokens) === 0;
      }) ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(prompt - cached - writes, "tokens");
      return {
        "input-token-count": inputTokens,
        "output-token-count": reconciled(output, "total_completion_tokens", "completion_tokens"),
        "cache-read-input-token-count": reconciled(cached, "total_cached_tokens", "cached_tokens")
      };
    });
    for (const id of ["input-token-count", "output-token-count", "cache-read-input-token-count"]) {
      const values = documentUsage.map((usage) => usage[id]);
      const unavailable2 = values.find((value) => value.status === "unavailable");
      const total = values.reduce((sum, value) => sum + (value.status === "known" ? value.value : 0), 0);
      mapping.measures[id] = unavailable2 ?? (Number.isSafeInteger(total) ? count(total, "tokens") : missing("USAGE_SUM_OVERFLOW"));
    }
    const inference = !gap && agentSteps.length > 0 && agentSteps.every((step) => integer(step.llm_call_count)) ? agentSteps.reduce((sum, step) => sum + Number(step.llm_call_count), 0) : void 0;
    mapping.measures["declared-inference-count"] = inference !== void 0 && Number.isSafeInteger(inference) ? count(inference, "declared-inferences") : missing("DECLARED_INFERENCE_INCOMPLETE");
  } else limitations2.add("PRODUCER_PROFILE_UNREGISTERED");
  mapping.measures["model-request-count"] = missing("NATIVE_REQUEST_IDENTITIES_UNAVAILABLE");
  mapping.limitations = [...limitations2].sort();
  const mappingErrors = validateArtifact("Pi ATIF mapping", mapping);
  if (mappingErrors.length) throw new Error(`Invalid generated Pi mapping: ${mappingErrors[0].message}`);
  capture.sourceLimitations = mapping.limitations;
  const capabilities = {
    schemaVersion: "ebo.adapter-capability-profile/v1",
    adapterId: "atif-pi-import",
    harness,
    nativeTypes: ["atif:trajectory", "atif:step", "atif:call", "atif:result"],
    families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, {
      status: events.some((event) => event.family === family) ? "partial" : "unsupported",
      detail: "Imported selected history cannot establish complete attempt coverage."
    }])),
    evidence: { nativeOrder: { status: "partial" }, nativeTime: { status: "unsupported" }, parentage: { status: "unsupported" }, content: { status: "partial" } }
  };
  const used = new Set(events.map((event) => event.source.nativeReference.recordLocator));
  const dataset = describeImportedDataset({
    capture,
    normalization: { events, unmapped: records.filter(({ reference: reference2 }) => !used.has(reference2.recordLocator)).map(({ reference: reference2 }) => ({ reference: reference2, reason: "RETAINED_WITHOUT_AGENT_BEHAVIOR_PROJECTION" })) },
    capabilityProfile: capabilities,
    adapterVersion: "1.0.0",
    nativeType: (record3) => nativeTypes.get(record3) ?? "atif:trajectory",
    contentDigestPolicy: "canonical-json-pointers/v1",
    contentDigest: (reference2) => resolver.read(reference2)?.pointedDigest,
    origin: {
      kind: "imported",
      qualification: "imported",
      manifestDigest: input.manifestDigest,
      exactAttemptMeasures: "unavailable",
      reason: "Imported selected trajectory does not establish complete attempt coverage."
    }
  });
  const coverage = await validateNormalizedDataset(dataset, resolver);
  const aliases = /* @__PURE__ */ new Set();
  const alias = (value) => {
    if (typeof value === "string" && value.trim()) aliases.add(value);
  };
  const collectAliases = (trajectory) => {
    alias(object2(trajectory.agent).model_name);
    for (const value of array2(trajectory.steps)) {
      const step = object2(value);
      alias(step.model_name);
      alias(object2(step.extra).response_model);
    }
    for (const child of array2(trajectory.subagent_trajectories)) collectAliases(object2(child));
  };
  collectAliases(document);
  return {
    capture,
    dataset,
    coverage,
    resolver,
    mapping,
    modelAliases: [...aliases].sort(),
    outcomeCapture: { ...capture, records: capture.records.map(({ reference: reference2, record: record3 }) => ({ reference: reference2, record: { schemaVersion: "ebo.imported-outcome-record/v1", kind: "imported-source", authority: "third-party", document: record3 } })) }
  };
}

// src/atif-import.ts
init_scheduler();
var ATIF_IMPORTER_VERSION = "1.0.0";
var bytesDigest = (bytes) => `sha256:${digestBytes(bytes).value}`;
var hash2 = (value) => `sha256:${digestMetadata(value).value}`;
function readImportManifest(bundleRoot) {
  const bytes = readBoundedFile(join(bundleRoot, "manifest.json"), "Import manifest", void 0, 1024 * 1024);
  const manifest = parseJson(bytes);
  assertManifest(manifest);
  if (manifest.importer.version !== ATIF_IMPORTER_VERSION) throw new Error("Unsupported retained ATIF importer version.");
  const selection = selectAtifProducerProfile(manifest.producer);
  const expected = selection.status === "supported" ? { status: "supported", id: selection.profile.id, digest: selection.profileDigest } : selection;
  if (hash2(expected) !== hash2(manifest.profile)) throw new Error("Retained import profile differs from its pinned registry identity.");
  return manifest;
}
async function readImportedBehaviorEvidence(bundleRoot) {
  const { manifest, read } = readAtifImportAdmission(bundleRoot);
  return withDeclaredAliases(await normalizePiAtif({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: hash2(manifest) }), manifest);
}
function readAtifImportAdmission(bundleRoot) {
  const manifest = readImportManifest(bundleRoot);
  const bytes = readBoundedFile(join(bundleRoot, manifest.source.path), "Retained ATIF", void 0, ATIF_LIMITS.documentBytes);
  if (bytes.length !== manifest.source.bytes || bytesDigest(bytes) !== manifest.source.digest) throw new Error("Retained ATIF bytes differ from the admitted source.");
  const receiptBytes = readBoundedFile(join(bundleRoot, manifest.inspection.path), "ATIF inspection", void 0, 32 * 1024 * 1024);
  if (bytesDigest(receiptBytes) !== manifest.inspection.digest) throw new Error("ATIF inspection receipt is stale.");
  const receipt = parseJson(receiptBytes);
  const errors = validateArtifact("ATIF inspection", receipt);
  if (errors.length || receipt.readerVersion !== ATIF_READER_VERSION || receipt.structural.status !== "valid" || receipt.structural.version !== "0.24.0" || !receipt.structural.modelDigest || !receipt.structural.validationPolicyDigest) throw new Error("Import lacks a supported pinned validation receipt.");
  const read = inspectAtifBytes(bytes);
  if (hash2(read.inspection.source) !== hash2(receipt.source) || hash2(read.inspection.records) !== hash2(receipt.records) || hash2(read.inspection.versionPolicy) !== hash2(receipt.versionPolicy)) throw new Error("Retained source inventory differs from its admission receipt.");
  read.inspection.structural = receipt.structural;
  return { manifest, read };
}
function parseJson(bytes) {
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text9);
  return JSON.parse(text9);
}
function assertManifest(value) {
  const errors = validateArtifact("Import manifest", value);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
}
function withDeclaredAliases(evidence, manifest) {
  return manifest.blinding === void 0 ? evidence : { ...evidence, modelAliases: [.../* @__PURE__ */ new Set([...evidence.modelAliases ?? [], ...manifest.blinding.modelAliases])].sort() };
}

// src/retained-evidence.ts
init_artifacts();

// src/factory-model.ts
var FACTORY_BYOK_MODEL_ID = "custom:ebo-byok";
function validateFactoryModelRoute(value) {
  const route = record(value);
  if (!route || !["factory-managed", "byok"].includes(String(route.kind))) throw new Error("Invalid Factory model route.");
  const allowed = route.kind === "factory-managed" ? ["kind"] : ["kind", "provider", "baseUrl", "maxOutputTokens", "extraArgs"];
  if (Object.keys(route).some((key) => !allowed.includes(key))) throw new Error("Unknown Factory route field; credentials belong in environment variables.");
  if (route.kind === "factory-managed") return;
  if (route.provider !== "generic-chat-completion-api") throw new Error("Factory BYOK requires generic-chat-completion-api.");
  let url;
  try {
    url = new URL(String(route.baseUrl));
  } catch {
    throw new Error("Factory BYOK baseUrl must be an absolute HTTP(S) URL.");
  }
  if (typeof route.baseUrl !== "string" || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Factory BYOK baseUrl must have no credentials, query or fragment.");
  if (!Number.isSafeInteger(route.maxOutputTokens) || route.maxOutputTokens < 1) throw new Error("Factory BYOK maxOutputTokens must be a positive integer.");
  if (route.extraArgs === void 0) return;
  const args = record(route.extraArgs);
  if (!args || Object.keys(args).some((key) => !["temperature", "top_p", "reasoning_effort", "thinking"].includes(key))) throw new Error("Unknown Factory BYOK extraArgs field.");
  if (args.temperature !== void 0 && (typeof args.temperature !== "number" || !Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2) || args.top_p !== void 0 && (typeof args.top_p !== "number" || !Number.isFinite(args.top_p) || args.top_p <= 0 || args.top_p > 1) || args.reasoning_effort !== void 0 && !["none", "low", "medium", "high", "max"].includes(String(args.reasoning_effort))) throw new Error("Invalid Factory BYOK sampling or reasoning argument.");
  if (args.thinking !== void 0) {
    const thinking = record(args.thinking);
    if (!thinking || Object.keys(thinking).length !== 1 || !["enabled", "disabled"].includes(String(thinking.type))) throw new Error("Invalid Factory BYOK thinking argument.");
  }
}
function factoryModelSelection(model, route = { kind: "factory-managed" }) {
  validateFactoryModelRoute(route);
  if (!model.trim() || model.startsWith("custom:")) throw new Error("Factory model must name the managed or upstream model, not a custom selector.");
  return { model, nativeModelId: route.kind === "byok" ? FACTORY_BYOK_MODEL_ID : model, route };
}
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

// src/factory-droid.ts
init_artifacts();
import {
  createSession,
  DroidInteractionMode,
  ToolConfirmationOutcome
} from "@factory/droid-sdk/node";
import {
  FACTORY_PROTOCOL_VERSION,
  SessionNotificationSchema,
  RequestPermissionRequestSchema,
  InitializeSessionRequestSchema,
  InitializeSessionResponseSchema,
  AddUserMessageRequestSchema,
  AddUserMessageResponseSchema
} from "@factory/droid-sdk";

// src/process-protocol.ts
var DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
var DEFAULT_MAX_RECORD_BYTES = DEFAULT_MAX_LINE_BYTES * 8 + 4096;
var DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
function assertProtocolObservation(value, lineNumber2) {
  const candidate = isRecord2(value) ? value.sequence : void 0;
  if (!isRecord2(value) || value.schemaVersion !== "ebo.protocol-observation/v1" || !Number.isSafeInteger(lineNumber2) || lineNumber2 < 1 || typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate !== lineNumber2) {
    throw new Error(`Existing JSONL evidence line ${lineNumber2} is not a contiguous protocol observation.`);
  }
  assertRecoveredObservation(value, lineNumber2);
}
function assertRecoveredObservation(value, line) {
  if (typeof value.observedAt !== "string" || value.observedAt.trim() === "") {
    throw new Error(`Existing JSONL evidence line ${line} has no valid observation timestamp.`);
  }
  const kind = value.kind;
  if (!["frame", "request", "response", "notification", "completion", "capability", "error", "process"].includes(String(kind))) {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid observation kind.`);
  }
  if (typeof value.source !== "string" || value.source.trim() === "") {
    throw new Error(`Existing JSONL evidence line ${line} has no valid observation source.`);
  }
  if (value.stream !== void 0 && value.stream !== "stdout" && value.stream !== "stderr") {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid observation stream.`);
  }
  for (const field of ["method", "sourceIdentity", "raw", "parseError", "status", "capability"]) {
    if (value[field] !== void 0 && (typeof value[field] !== "string" || value[field].trim() === "")) {
      throw new Error(`Existing JSONL evidence line ${line} has an invalid ${field}.`);
    }
  }
  if (value.id !== void 0 && (typeof value.id === "number" && !Number.isFinite(value.id) || typeof value.id !== "string" && typeof value.id !== "number" && value.id !== null)) {
    throw new Error(`Existing JSONL evidence line ${line} has an invalid protocol identity.`);
  }
  if (kind === "frame" && !Object.hasOwn(value, "payload")) {
    if (typeof value.parseError !== "string" || value.parseError.trim() === "") {
      throw new Error(`Existing JSONL evidence line ${line} is missing frame payload.`);
    }
  } else if (kind === "frame" && value.parseError !== void 0) {
    throw new Error(`Existing JSONL evidence line ${line} has contradictory frame payload evidence.`);
  } else if (kind !== "frame" && value.parseError !== void 0) {
    throw new Error(`Existing JSONL evidence line ${line} has an unexpected frame parse error.`);
  }
  if ((kind === "request" || kind === "response" || kind === "notification") && (typeof value.method !== "string" || value.method.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing protocol method.`);
  }
  if (kind === "completion" && (!Object.hasOwn(value, "evidence") || typeof value.status !== "string" || value.status.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing completion evidence.`);
  }
  if (kind === "capability" && (typeof value.capability !== "string" || value.capability.trim() === "" || !["available", "unsupported", "missing", "not-checked"].includes(String(value.status)))) {
    throw new Error(`Existing JSONL evidence line ${line} has invalid capability evidence.`);
  }
  if ((kind === "error" || kind === "process") && (typeof value.status !== "string" || value.status.trim() === "")) {
    throw new Error(`Existing JSONL evidence line ${line} is missing status evidence.`);
  }
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/factory-droid.ts
var FACTORY_HARNESS = "factory-droid";
var FACTORY_SDK_VERSION = "0.9.1";
var FACTORY_CLI_VERSION = "0.238.0";
var FACTORY_ADAPTER_VERSION = "0.1.0";
var RETAINED_FACTORY_ADAPTER_VERSIONS = ["0.1.0"];
var FACTORY_NORMALIZATION_ADAPTER_VERSION = "0.1.0";
var RETAINED_FACTORY_CLI_VERSIONS = [FACTORY_CLI_VERSION];
var RETAINED_FACTORY_SDK_VERSIONS = [FACTORY_SDK_VERSION];
var FACTORY_CLIENT = "ebo-factory-client";
function qualifyFactoryCapture(capture, options) {
  const captureAdapterVersion = options.adapterVersion ?? FACTORY_ADAPTER_VERSION;
  if (!RETAINED_FACTORY_CLI_VERSIONS.includes(options.cliVersion) || !RETAINED_FACTORY_SDK_VERSIONS.includes(options.sdkVersion) || !RETAINED_FACTORY_ADAPTER_VERSIONS.includes(captureAdapterVersion)) throw new Error("Unsupported retained Factory runtime.");
  const records = capture.records.map(({ record: record3, reference }) => {
    const line = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
    assertProtocolObservation(record3, line);
    if (![FACTORY_HARNESS, FACTORY_CLIENT].includes(record3.source)) throw new Error("Foreign source in retained Factory stream.");
    if (record3.raw !== void 0 && record3.parseError === void 0) {
      assertNoDuplicateJsonKeys(record3.raw);
      if (digestMetadata(JSON.parse(record3.raw)).value !== digestMetadata(record3.payload).value) throw new Error("Factory raw frame differs from its parsed payload.");
    }
    if (record3.source === FACTORY_CLIENT && (object3(record3.payload)?.jsonrpc !== "2.0" || !["request", "response"].includes(String(object3(record3.payload)?.type)) || record3.kind !== "request" || object3(record3.payload)?.id !== record3.id || record3.method !== "jsonrpc-response" && object3(record3.payload)?.method !== record3.method)) throw new Error("Factory outbound envelope differs from its protocol frame.");
    return record3;
  });
  const compositions = records.filter((r) => r.kind === "capability" && r.capability === "runtime-composition");
  if (compositions.length !== 1 || object3(compositions[0]?.evidence)?.version !== options.cliVersion || object3(compositions[0]?.evidence)?.sdkVersion !== options.sdkVersion || object3(compositions[0]?.evidence)?.adapterVersion !== captureAdapterVersion || object3(compositions[0]?.evidence)?.protocolVersion !== FACTORY_PROTOCOL_VERSION) throw new Error("Retained Factory native runtime composition differs from the manifest.");
  const initializations = records.filter((r) => r.source === FACTORY_CLIENT && r.method === "droid.initialize_session");
  if (initializations.length > 1 || options.expectsCompletion && initializations.length !== 1) throw new Error("Factory requires one owned initialization request.");
  const initialization = initializations[0];
  if (initialization !== void 0 && !InitializeSessionRequestSchema.safeParse(initialization.payload).success) throw new Error("Factory initialization fails the pinned native schema.");
  const responses = initialization === void 0 ? [] : records.filter((r) => r.kind === "frame" && object3(r.payload)?.type === "response" && object3(r.payload)?.id === initialization.id);
  if (responses.length > 1 || responses.some((r) => r.sequence <= initialization.sequence)) throw new Error("Factory initialization response is ambiguous or unordered.");
  const sessionId = text(object3(object3(responses[0]?.payload)?.result)?.sessionId);
  if (options.expectsCompletion && (responses.length !== 1 || object3(responses[0]?.payload)?.error !== void 0)) throw new Error("Completed Factory capture lacks successful initialization.");
  if (responses.length === 1 && !InitializeSessionResponseSchema.safeParse(responses[0].payload).success) throw new Error("Factory initialization response fails the pinned native schema.");
  if (sessionId !== options.sessionId) throw new Error("Retained Factory session identity differs from the manifest.");
  const prompts = records.filter((r) => r.source === FACTORY_CLIENT && r.method === "droid.add_user_message");
  if (prompts.length > 1 || options.expectsCompletion && prompts.length !== 1) throw new Error("Factory requires one owned prompt request.");
  const prompt = prompts[0];
  const turnId = text(object3(object3(prompt?.payload)?.params)?.messageId);
  const promptSessionId = object3(object3(prompt?.payload)?.params)?.sessionId;
  if (prompt !== void 0 && (sessionId === void 0 || turnId === void 0 || promptSessionId !== void 0 && promptSessionId !== sessionId || !AddUserMessageRequestSchema.safeParse(prompt.payload).success || prompt.sequence <= (responses[0]?.sequence ?? Infinity))) throw new Error("Factory prompt lacks ordered owned session evidence.");
  const promptResponses = prompt === void 0 ? [] : records.filter((r) => r.kind === "frame" && object3(r.payload)?.type === "response" && object3(r.payload)?.id === prompt.id);
  if (promptResponses.length > 1 || promptResponses.some((r) => r.sequence <= prompt.sequence) || options.expectsCompletion && (promptResponses.length !== 1 || object3(promptResponses[0]?.payload)?.error !== void 0)) throw new Error("Factory prompt acknowledgement is missing, ambiguous or failed.");
  if (promptResponses.length === 1 && !AddUserMessageResponseSchema.safeParse(promptResponses[0].payload).success) throw new Error("Factory prompt acknowledgement fails the pinned native schema.");
  if (options.expectsCompletion) {
    const requested = object3(object3(initialization?.payload)?.params);
    const effective = object3(object3(object3(responses[0]?.payload)?.result)?.settings);
    if (["modelId", "reasoningEffort", "autonomyLevel", "interactionMode"].some((key) => requested?.[key] !== effective?.[key])) throw new Error("Factory native effective settings differ from initialization.");
  }
  const terminals = records.filter((r) => {
    const frame = object3(r.payload);
    const params = object3(frame?.params);
    const n = object3(params?.notification);
    return r.kind === "frame" && frame?.method === "droid.session_notification" && params?.sessionId === sessionId && n?.type === "agent_turn_completed" && n.turnId === turnId && turnId !== void 0;
  });
  if (terminals.length > 1 || terminals.some((r) => r.sequence <= prompt.sequence)) throw new Error("Factory requires unambiguous ordered owned terminal evidence.");
  const terminal = object3(object3(object3(terminals[0]?.payload)?.params)?.notification);
  if (terminals.length === 1 && !SessionNotificationSchema.safeParse(terminals[0].payload).success) throw new Error("Factory owned terminal fails the pinned native schema.");
  if (options.expectsCompletion && (terminal?.reason !== "completed" || sessionId === void 0)) throw new Error("Completed Factory capture lacks an owned completed native turn.");
  return { ...capture, ...sessionId === void 0 ? {} : { sessionId }, ...turnId === void 0 ? {} : { turnId }, ...terminal === void 0 ? {} : { terminal } };
}
var FACTORY_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "ebo-factory-droid",
  harness: FACTORY_HARNESS,
  nativeTypes: ["droid.add_user_message", "create_message", "assistant_text_delta", "tool_call", "tool_result", "droid.request_permission", "permission_resolved", "session_compacted", "child_session_available", "llm_retry", "agent_turn_completed", "session_token_usage_changed", "settings_updated"],
  families: {
    message: { status: "partial", detail: "Completed visible messages, or partial text when no completed message exists; copied SDK messages are not counted again." },
    "model-request": { status: "unsupported", detail: "No inference requests are inferred from message streams." },
    tool: { status: "partial", detail: "Native tool IDs bind calls and results; child histories are incomplete." },
    context: { status: "partial", detail: "Explicit settings, retry and compaction notifications only." },
    permission: { status: "partial", detail: "Client requests, frozen responses and native resolutions are retained." },
    delegation: { status: "partial", detail: "Child identity and tool relationship; child history is not fetched." },
    artifact: { status: "unsupported", detail: "Workspace outcome is packaged separately." },
    validation: { status: "unsupported", detail: "Only explicit verifier evidence establishes validation." },
    runtime: { status: "partial", detail: "Owned terminal turn usage inclusive of children; cumulative updates are context snapshots, not additive usage." },
    outcome: { status: "available", detail: "Exact native owned session and turn terminal reason." }
  },
  evidence: {
    nativeOrder: { status: "available", detail: "One recorded stdio ordering domain." },
    nativeTime: { status: "partial", detail: "Capture receipt times are labeled separately from upstream timestamps." },
    parentage: { status: "partial", detail: "Native tool IDs and exposed child relations only." },
    content: { status: "partial", detail: "References to restricted frames; hidden reasoning never projected." }
  }
};
function factoryNativeType(record3) {
  const frame = object3(record3.payload);
  return text(object3(object3(frame?.params)?.notification)?.type) ?? text(frame?.method) ?? record3.method ?? record3.capability ?? record3.kind;
}
async function normalizeFactoryCapture(input) {
  const capture = input;
  const events = [];
  const mapped = /* @__PURE__ */ new Set();
  const calls = /* @__PURE__ */ new Map();
  const completedMessages = new Set(capture.records.flatMap(({ record: record3 }) => {
    const n = object3(object3(object3(record3.payload)?.params)?.notification);
    return object3(object3(record3.payload)?.params)?.sessionId === capture.sessionId && n?.type === "create_message" && object3(n.message)?.role === "assistant" && SessionNotificationSchema.safeParse(record3.payload).success ? [text(object3(n.message)?.id)] : [];
  }).filter((id) => id !== void 0));
  const seenTools = /* @__PURE__ */ new Set();
  const seenMessages = /* @__PURE__ */ new Set();
  for (const { record: record3, reference } of capture.records) {
    if (capture.sessionId === void 0) continue;
    const frame = object3(record3.payload);
    const params = object3(frame?.params);
    const n = object3(params?.notification);
    const type = factoryNativeType(record3);
    const attributes = { nativeTimeSource: "capture-receipt" };
    let family;
    let phase = "instant";
    let actor = "harness";
    let parent;
    let contentPointer = "/payload";
    const id = `factory:${record3.sequence}`;
    if (record3.source === FACTORY_CLIENT && frame?.method === "droid.add_user_message" && params?.messageId === capture.turnId) {
      family = "message";
      actor = "user";
      phase = "before";
      contentPointer = "/payload/params/text";
    } else if (record3.kind === "frame" && frame?.method === "droid.request_permission" && RequestPermissionRequestSchema.safeParse(frame).success) {
      family = "permission";
      phase = "before";
    } else if (record3.kind === "frame" && frame?.method === "droid.session_notification" && params?.sessionId === capture.sessionId && SessionNotificationSchema.safeParse(frame).success) {
      if (type === "create_message" && ["assistant", "user"].includes(String(object3(n?.message)?.role))) {
        const message = object3(n?.message);
        if (message.role === "user") continue;
        if (seenMessages.has(String(message.id))) continue;
        seenMessages.add(String(message.id));
        family = "message";
        actor = "agent";
        phase = "after";
        attributes.messageId = String(message.id);
      } else if (type === "assistant_text_delta" && !completedMessages.has(String(n?.messageId))) {
        family = "message";
        actor = "agent";
        phase = "during";
      } else if (type === "tool_call") {
        const tool = object3(n?.toolUse);
        const toolId = text(tool?.id);
        if (toolId === void 0 || seenTools.has(`call:${toolId}`)) continue;
        seenTools.add(`call:${toolId}`);
        calls.set(toolId, id);
        family = "tool";
        actor = "agent";
        phase = "before";
        attributes.toolCallId = toolId;
        if (typeof tool?.name === "string") attributes.toolName = tool.name;
        if (tool?.input !== void 0) attributes.inputDigest = `sha256:${digestMetadata(tool.input).value}`;
      } else if (type === "tool_result") {
        const toolId = text(n?.toolUseId);
        if (toolId === void 0 || seenTools.has(`result:${toolId}`)) continue;
        seenTools.add(`result:${toolId}`);
        family = "tool";
        actor = "tool";
        phase = "after";
        attributes.toolCallId = toolId;
        if (typeof n?.isError === "boolean") attributes.isError = n.isError;
        parent = calls.get(toolId);
      } else if (["session_compacted", "settings_updated", "llm_retry"].includes(type)) family = "context";
      else if (type === "session_token_usage_changed") {
        family = "context";
        attributes.usageSemantics = "cumulative-session-snapshot";
      } else if (type === "permission_resolved") family = "permission";
      else if (type === "child_session_available") {
        family = "delegation";
        if (typeof n?.childSessionId === "string") attributes.childSessionId = n.childSessionId;
        parent = calls.get(String(n?.toolUseId));
      } else if (type === "agent_turn_completed" && n !== void 0 && n.turnId === capture.turnId) {
        family = "outcome";
        phase = "after";
        attributes.reason = String(n.reason);
        attributes.usageSemantics = "turn-inclusive-children";
        const usage = object3(n.tokenUsage);
        for (const [native, uniform] of Object.entries({
          inputTokens: "inputTokens",
          outputTokens: "outputTokens",
          cacheReadTokens: "cacheReadInputTokens",
          cacheCreationTokens: "cacheCreationInputTokens",
          thinkingTokens: "thinkingTokens",
          factoryCredits: "factoryCredits"
        })) {
          if (typeof usage?.[native] === "number" && Number.isFinite(usage[native])) attributes[uniform] = usage[native];
        }
        if (typeof n.durationMs === "number") attributes.durationMs = n.durationMs;
      }
    }
    if (family === void 0) continue;
    events.push({
      schemaVersion: "ebo.uniform-event/v1",
      id,
      runId: capture.runId,
      attemptId: capture.attemptId,
      source: { harness: FACTORY_HARNESS, nativeType: type, nativeReference: reference },
      nativeOrder: { status: "known", value: record3.sequence, domain: "factory-native-stdio" },
      nativeTime: { status: "known", value: record3.observedAt },
      actor: { kind: actor },
      family,
      phase,
      scope: { kind: "session", id: capture.sessionId },
      relations: { parent: parent === void 0 ? { status: "unknown", reason: "No exposed native parent." } : { status: "known", value: parent }, known: [] },
      attributes,
      content: { status: "known", value: [{ nativeReference: { ...reference, recordLocator: `${reference.recordLocator}#${contentPointer}` }, mediaType: "application/json" }] }
    });
    if (type === "agent_turn_completed" && family === "outcome") {
      events.push({
        ...events[events.length - 1],
        id: `${id}:usage`,
        family: "runtime",
        attributes: { ...attributes, resourceSemantics: "cumulative-final" }
      });
    }
    mapped.add(record3.sequence);
  }
  await validateUniformEvents(events, createCapturedNativeEvidenceResolver(capture));
  return { events, unmapped: capture.records.filter(({ record: record3 }) => !mapped.has(record3.sequence)).map(({ reference }) => ({ reference, reason: "Native record retained without a supported uniform projection." })) };
}
async function describeAndValidateFactoryDataset(capture) {
  const dataset = describeNormalizedDataset({
    capture,
    normalization: await normalizeFactoryCapture(capture),
    capabilityProfile: FACTORY_CAPABILITIES,
    adapterVersion: FACTORY_NORMALIZATION_ADAPTER_VERSION,
    nativeType: factoryNativeType
  });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}
function object3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}

// src/retained-evidence.ts
import { join as join4 } from "node:path";

// src/agent-sdk-normalizer.ts
init_artifacts();
import { createHash as createHash3 } from "node:crypto";
import { resolve as resolve5 } from "node:path";
import { HOOK_EVENTS as HOOK_EVENTS2 } from "@anthropic-ai/claude-agent-sdk";

// src/run-bundles.ts
import { execFile as execFile2, spawn } from "node:child_process";
import { cp, lstat as lstat2, mkdir as mkdir2, mkdtemp, readdir, readlink, realpath as realpath2, rm as rm2, rmdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as dirname3, isAbsolute as isAbsolute3, join as join2, relative as relative3, resolve as resolve4, sep as sep3 } from "node:path";
import { promisify as promisify2 } from "node:util";
init_artifacts();
init_contracts();
import { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk";

// src/verifiers.ts
init_artifacts();
init_contracts();
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
var execFileAsync = promisify(execFile);
var COMPLETION_MESSAGE = "ebo-verifier-complete/v1\n";
var VERIFIER_COMPLETION_HOOK = `
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const stageRoot = __dirname;
const nodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = (from) => nodeModulePaths(from)
  .filter((candidate) => candidate === stageRoot || candidate.startsWith(stageRoot + path.sep));
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  const resolved = resolveFilename.call(this, request, parent, isMain, options);
  if (typeof resolved === "string"
      && (resolved.startsWith("node:") || Module.builtinModules.includes(resolved)
        || resolved === stageRoot || resolved.startsWith(stageRoot + path.sep))) return resolved;
  throw new Error("Verifier dependency resolves outside its private staging root.");
};
let abnormal = false;
const report = (error) => {
  abnormal = true;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
};
process.on("uncaughtException", report);
process.on("unhandledRejection", report);
process.on("exit", () => {
  if (!abnormal) {
    try { fs.writeSync(3, ${JSON.stringify(COMPLETION_MESSAGE)}); } catch {}
  }
});
`;

// src/run-bundles.ts
init_scheduler();
var execFileAsync2 = promisify2(execFile2);
var MAX_WORKSPACE_PATCH_BYTES = 64 * 1024 * 1024;
var MAX_WORKSPACE_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
var MAX_QUALIFICATION_ARTIFACT_BYTES = 64 * 1024 * 1024;
var QUALIFICATION_DIMENSION_RANK = { qualified: 0, unsupported: 1, gap: 2, unqualified: 3 };
var PINNED_HOOK_EVENTS = new Set(HOOK_EVENTS);
var TAR_COMMAND = process.platform === "win32" ? "tar" : "/usr/bin/tar";
async function qualifyRunBundle(bundleRoot, options = {}) {
  const report = emptyQualificationReport();
  let document;
  try {
    const text9 = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join2(resolve4(bundleRoot), "manifest.json"), "Run manifest"));
    assertNoDuplicateJsonKeys(text9);
    document = JSON.parse(text9);
  } catch (error) {
    addQualificationReason(report, "attemptIdentity", "unqualified", "MANIFEST_INVALID", void 0, errorMessage(error));
    return finishQualificationReport(report);
  }
  if (!isRecord3(document) || !Array.isArray(document.evidence)) {
    addQualificationReason(report, "attemptIdentity", "unqualified", "MANIFEST_INVALID", void 0, "Run manifest is not a record with evidence.");
    return finishQualificationReport(report);
  }
  const manifest = document;
  const assessmentMode = manifest.run?.assessmentMode ?? "verified";
  report.assessmentMode = assessmentMode;
  report.attempt = structuredClone(manifest.attempt);
  report.terminal = structuredClone(manifest.terminal);
  const manifestErrors = validateArtifact("manifest.json", manifest);
  for (const error of manifestErrors) {
    const dimension = error.field.startsWith("/attempt") ? "attemptIdentity" : error.field.startsWith("/terminal") ? "terminal" : "semanticEvidence";
    addQualificationReason(
      report,
      dimension,
      "unqualified",
      dimension === "attemptIdentity" ? "ATTEMPT_IDENTITY_INVALID" : dimension === "terminal" ? "TERMINAL_CLASSIFICATION_INVALID" : "MANIFEST_INVALID",
      void 0,
      `${error.field}: ${error.message}`
    );
  }
  if (manifestErrors.length > 0) return finishQualificationReport(report);
  const states = /* @__PURE__ */ new Map();
  for (const descriptor of manifest.evidence) {
    const state = { descriptor, valid: true };
    states.set(descriptor.id, state);
    try {
      if (descriptor.kind === "workspace" && descriptor.mediaType === "application/gzip") {
        const inspected = await inspectRetainedArtifact(bundleRoot, descriptor.relativePath, MAX_WORKSPACE_SNAPSHOT_BYTES);
        if (inspected.sizeBytes !== descriptor.sizeBytes || digestString2(inspected.digest.value) !== descriptor.digest) {
          throw new Error("Workspace snapshot size or digest does not match its descriptor.");
        }
        continue;
      }
      const bytes = await readVerifiedArtifact(
        bundleRoot,
        descriptor.relativePath,
        digestValue(descriptor.digest),
        MAX_QUALIFICATION_ARTIFACT_BYTES
      );
      if (descriptor.mediaType === "application/x-ndjson") {
        const summary = parseNativeJsonl(bytes);
        state.hookNames = summary.hookNames;
        state.sessionIds = summary.sessionIds;
      } else if (descriptor.mediaType === "application/json") {
        const parsed = parseNativeJson(bytes);
        if (descriptor.kind === "session" || descriptor.kind === "hook") {
          const summary = nativeRecordSummary([parsed]);
          state.hookNames = summary.hookNames;
          state.sessionIds = summary.sessionIds;
        } else {
          state.document = descriptor.kind === "telemetry" ? telemetrySummary(parsed) : parsed;
        }
      }
      if (descriptor.kind === "workspace" && descriptor.mediaType === "text/x-diff") state.bytes = bytes;
    } catch (error) {
      state.valid = false;
      const { dimension, code } = artifactFailure(descriptor, error);
      addQualificationReason(report, dimension, "unqualified", code, descriptor.id, errorMessage(error));
    }
  }
  if (!report.reasons.some((reason) => reason.code === "ARTIFACT_TOO_LARGE")) {
    for (const error of validateRunManifestEvidence("manifest.json", manifest, bundleRoot)) {
      const descriptor = descriptorFromValidationField(manifest, error.field);
      const dimension = descriptor === void 0 ? error.field.startsWith("/terminal") ? "terminal" : "semanticEvidence" : artifactFailure(descriptor, new Error(error.message)).dimension;
      const code = dimension === "terminal" ? "TERMINAL_CLASSIFICATION_INVALID" : "ARTIFACT_INTEGRITY_INVALID";
      addQualificationReason(report, dimension, "unqualified", code, descriptor?.id, `${error.field}: ${error.message}`);
    }
  }
  const valid = (kind) => [...states.values()].filter((state) => state.descriptor.kind === kind && state.descriptor.sanitizedFrom === void 0 && state.valid);
  const sessions = valid("session");
  const hookArtifacts = valid("hook");
  const hooks = hookArtifacts.filter(({ hookNames }) => (hookNames?.length ?? 0) > 0);
  const telemetry = valid("telemetry");
  const workspaces = valid("workspace");
  const verifiers = valid("verifier");
  const captureReports = valid("capture-report");
  const captureReport = captureReports[0]?.document;
  const retainedSemanticEvidenceKinds = captureReportSemanticEvidenceKinds(captureReport);
  const semanticEvidenceKinds = retainedSemanticEvidenceKinds ?? options.semanticEvidenceKinds ?? ["session", "hook"];
  if (retainedSemanticEvidenceKinds !== void 0 && options.semanticEvidenceKinds !== void 0 && !sameStringSet(retainedSemanticEvidenceKinds, options.semanticEvidenceKinds)) {
    addQualificationReason(
      report,
      "semanticEvidence",
      "unqualified",
      "CAPTURE_REPORT_CONTRADICTS_SOURCE",
      captureReports[0]?.descriptor.id,
      "Caller semantic-evidence requirements contradict the retained capture report."
    );
  }
  const requiresSession = semanticEvidenceKinds.includes("session");
  const requiresHooks = semanticEvidenceKinds.includes("hook");
  if (requiresSession && sessions.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "SESSION_EVIDENCE_MISSING", void 0, "No valid native session evidence is retained.");
  }
  const sessionId = manifest.run?.native?.sessionId;
  if (typeof sessionId !== "string" || !sessions.some(({ descriptor }) => descriptor.nativeReference?.type === "session" && descriptor.nativeReference.id === sessionId)) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "SESSION_IDENTITY_MISSING", void 0, "Run session identity is not bound to retained session evidence.");
  }
  const nativeSessionIds = new Set(sessions.flatMap(({ sessionIds }) => sessionIds ?? []));
  const retainedRelatedSessionIds = captureReportRelatedSessionIds(captureReport);
  const relatedSessionIds2 = retainedRelatedSessionIds ?? options.relatedSessionIds ?? [];
  if (retainedRelatedSessionIds !== void 0 && options.relatedSessionIds !== void 0 && !sameStringSet(retainedRelatedSessionIds, options.relatedSessionIds)) {
    addQualificationReason(
      report,
      "semanticEvidence",
      "unqualified",
      "CAPTURE_REPORT_CONTRADICTS_SOURCE",
      captureReports[0]?.descriptor.id,
      "Caller related-session identities contradict the retained capture report."
    );
  }
  const allowedSessionIds = /* @__PURE__ */ new Set([sessionId, ...relatedSessionIds2]);
  if (typeof sessionId === "string" && (!nativeSessionIds.has(sessionId) || [...nativeSessionIds].some((id) => !allowedSessionIds.has(id)))) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "SESSION_RECORD_IDENTITY_MISMATCH", void 0, "Retained native session records do not bind exclusively to the run session ID.");
  }
  for (const hook of hookArtifacts.filter(({ hookNames }) => hookNames?.length === 0)) {
    addQualificationReason(report, "hooks", "unqualified", "HOOK_RECORDS_MISSING", hook.descriptor.id, "Hook evidence contains no recognized callback records.");
  }
  if (requiresHooks && hooks.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "HOOK_EVIDENCE_MISSING", void 0, "No valid native hook evidence is retained.");
  }
  if (requiresHooks) qualifyHooks(report, manifest, hooks, options);
  if (captureMissingEvidence(captureReport).some((entry) => entry.kind === "event-log-completeness" && entry.reason === "not-checked")) {
    addQualificationReason(
      report,
      "semanticEvidence",
      "gap",
      "EVENT_LOG_COMPLETENESS_UNPROVEN",
      captureReports[0]?.descriptor.id,
      "The pinned Agent Server API reconciliation cannot prove complete in-process EventLog delivery."
    );
  }
  qualifyTelemetry(report, telemetry, captureMissingEvidence(captureReport));
  const captureWarnings = isRecord3(captureReport) && isRecord3(captureReport.agentSdk) && isRecord3(captureReport.agentSdk.captureWarnings) ? captureReport.agentSdk.captureWarnings : void 0;
  if (typeof captureWarnings?.count === "number" && captureWarnings.count > 0) {
    addQualificationReason(
      report,
      "hooks",
      "gap",
      "HOOK_CAPTURE_WARNING",
      captureReports[0]?.descriptor.id,
      `${String(captureWarnings.count)} hook callback${captureWarnings.count === 1 ? "" : "s"} could not be retained: ${String(captureWarnings.diagnostic ?? "no diagnostic")}`
    );
  }
  if (workspaces.length === 0) {
    addQualificationReason(report, "workspace", "unqualified", "WORKSPACE_EVIDENCE_MISSING", void 0, "No valid workspace outcome is retained.");
  }
  if (captureMissingEvidence(captureReport).some((entry) => entry.kind === "workspace-omission")) {
    addQualificationReason(
      report,
      "workspace",
      "gap",
      "WORKSPACE_ENTRIES_OMITTED",
      void 0,
      "Workspace projection excludes entries listed in the capture report."
    );
  }
  for (const workspace of workspaces.filter(({ descriptor }) => descriptor.mediaType === "text/x-diff")) {
    if (options.startingWorkspacePath === void 0) {
      addQualificationReason(report, "workspace", "gap", "WORKSPACE_PATCH_NOT_CHECKED", workspace.descriptor.id, "Workspace patch applicability was not checked against its starting fixture.");
    } else if (!await workspacePatchApplies(options.startingWorkspacePath, workspace.bytes)) {
      addQualificationReason(report, "workspace", "unqualified", "WORKSPACE_PATCH_UNUSABLE", workspace.descriptor.id, "Workspace patch does not reproduce the retained outcome.");
    }
  }
  if (assessmentMode === "verified" && verifiers.length === 0) {
    addQualificationReason(report, "verifier", "unqualified", "VERIFIER_EVIDENCE_MISSING", void 0, "No valid verifier result is retained.");
  }
  for (const verifier of verifiers) {
    const status = isRecord3(verifier.document) ? verifier.document.status : void 0;
    if (status === "error") {
      addQualificationReason(report, "verifier", "unqualified", "VERIFIER_RESULT_ERROR", verifier.descriptor.id, "Verifier infrastructure returned an error result.");
      if (manifest.terminal?.failureClass === "task") {
        addQualificationReason(report, "terminal", "unqualified", "INFRASTRUCTURE_FAILURE_MISCLASSIFIED_AS_TASK", verifier.descriptor.id, "Verifier infrastructure error cannot be a model task failure.");
      }
    } else if (status === "not-run") {
      addQualificationReason(report, "verifier", "unqualified", "VERIFIER_RESULT_NOT_RUN", verifier.descriptor.id, "Verifier was not run.");
    }
  }
  if (manifest.evidence.some((descriptor) => descriptor.sharingClass === "unknown")) {
    addQualificationReason(report, "sharing", "gap", "SHARING_CLASSIFICATION_UNKNOWN", void 0, "At least one retained artifact has unknown sharing classification.");
  }
  for (const exportState of valid("export-manifest")) {
    const errors = validateExportManifest(exportState.descriptor.relativePath, exportState.document, manifest, bundleRoot);
    for (const error of errors) {
      addQualificationReason(report, "sharing", "unqualified", "EXPORT_MANIFEST_INVALID", exportState.descriptor.id, `${error.field}: ${error.message}`);
    }
  }
  if (captureReports.length === 0) {
    addQualificationReason(report, "semanticEvidence", "unqualified", "CAPTURE_REPORT_MISSING", void 0, "No valid capture report is retained.");
  } else {
    for (const error of validateArtifact(captureReports[0].descriptor.relativePath, captureReport)) {
      addQualificationReason(report, "semanticEvidence", "unqualified", "CAPTURE_REPORT_INVALID", captureReports[0].descriptor.id, `${error.field}: ${error.message}`);
    }
    crossCheckCaptureReport(report, captureReports[0].descriptor.id, captureReport, {
      semantic: (!requiresSession || sessions.length > 0) && (!requiresHooks || hooks.length > 0),
      timingResource: telemetry.length > 0 && telemetry.every(({ document: document2 }) => {
        const receipt = isRecord3(document2) && isRecord3(document2.telemetry) ? document2.telemetry.receipt : void 0;
        return isRecord3(receipt) && receipt.status === "received";
      }),
      outcome: workspaces.length > 0 && (assessmentMode === "observational" || verifiers.length > 0)
    }, assessmentMode, semanticEvidenceKinds);
  }
  return finishQualificationReport(report);
}
function emptyQualificationReport() {
  const dimension = () => ({ status: "qualified", reasonCodes: [] });
  return {
    status: "qualified",
    semanticAnalysisUsable: true,
    dimensions: {
      attemptIdentity: dimension(),
      semanticEvidence: dimension(),
      hooks: dimension(),
      telemetry: dimension(),
      workspace: dimension(),
      verifier: dimension(),
      terminal: dimension(),
      sharing: dimension()
    },
    reasons: []
  };
}
function addQualificationReason(report, dimension, status, code, evidenceId, detail) {
  if (report.reasons.some((reason) => reason.code === code && reason.dimension === dimension && reason.evidenceId === evidenceId && reason.detail === detail)) return;
  report.reasons.push({ code, dimension, ...evidenceId === void 0 ? {} : { evidenceId }, detail });
  const target = report.dimensions[dimension];
  if (!target.reasonCodes.includes(code)) target.reasonCodes.push(code);
  if (QUALIFICATION_DIMENSION_RANK[status] > QUALIFICATION_DIMENSION_RANK[target.status]) target.status = status;
}
function finishQualificationReport(report) {
  const statuses = Object.values(report.dimensions).map((dimension) => dimension.status);
  report.status = statuses.includes("unqualified") ? "unqualified" : statuses.includes("gap") ? "qualified-with-gaps" : "qualified";
  report.semanticAnalysisUsable = report.dimensions.attemptIdentity.status !== "unqualified" && report.dimensions.semanticEvidence.status !== "unqualified" && report.dimensions.hooks.status !== "unqualified";
  return report;
}
function artifactFailure(descriptor, error) {
  const dimension = descriptor.kind === "session" ? "semanticEvidence" : descriptor.kind === "hook" ? "hooks" : descriptor.kind === "telemetry" ? "telemetry" : descriptor.kind === "workspace" ? "workspace" : descriptor.kind === "verifier" || descriptor.kind === "diagnostic" ? "verifier" : descriptor.kind === "export-manifest" ? "sharing" : "semanticEvidence";
  const message = errorMessage(error);
  const code = message.includes("qualification byte limit") ? "ARTIFACT_TOO_LARGE" : descriptor.kind === "capture-report" ? "CAPTURE_REPORT_INVALID" : descriptor.kind === "export-manifest" ? "EXPORT_MANIFEST_INVALID" : descriptor.mediaType === "application/x-ndjson" && message.includes("empty") ? "NATIVE_JSONL_EMPTY" : descriptor.mediaType === "application/x-ndjson" ? "NATIVE_JSONL_MALFORMED" : descriptor.mediaType === "application/json" && ["session", "hook", "telemetry"].includes(descriptor.kind) && message.includes("empty") ? "NATIVE_JSON_EMPTY" : descriptor.mediaType === "application/json" && ["session", "hook", "telemetry"].includes(descriptor.kind) ? "NATIVE_JSON_MALFORMED" : "ARTIFACT_INTEGRITY_INVALID";
  return { dimension, code };
}
function parseNativeJson(bytes) {
  if (bytes.length === 0) throw new Error("Native JSON evidence is empty.");
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text9);
  let value;
  try {
    value = JSON.parse(text9);
  } catch (error) {
    throw new Error(`Native JSON evidence is malformed: ${errorMessage(error)}`);
  }
  if (!isRecord3(value) || Object.keys(value).length === 0) throw new Error("Native JSON evidence is empty.");
  return value;
}
function parseNativeJsonl(bytes) {
  if (bytes.length === 0) throw new Error("Native JSONL evidence is empty.");
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text9.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("Native JSONL evidence is empty.");
  return nativeRecordSummary(lines.map((line, index) => {
    try {
      assertNoDuplicateJsonKeys(line);
      const value = JSON.parse(line);
      if (!isRecord3(value) || Object.keys(value).length === 0) throw new Error("record is empty");
      return value;
    } catch (error) {
      throw new Error(`Native JSONL evidence line ${index + 1} is malformed: ${errorMessage(error)}`);
    }
  }));
}
function nativeRecordSummary(records) {
  const hookNames = [];
  const sessionIds = [];
  const factoryInitializations = records.filter((record3) => isRecord3(record3) && record3.source === "ebo-factory-client" && record3.kind === "request" && record3.method === "droid.initialize_session");
  if (factoryInitializations.length === 1 && isRecord3(factoryInitializations[0])) {
    const initialization = factoryInitializations[0];
    const responses = records.filter((record3) => isRecord3(record3) && record3.source === "factory-droid" && record3.kind === "frame" && isRecord3(record3.payload) && record3.payload.type === "response" && record3.payload.id === initialization.id);
    if (responses.length === 1 && isRecord3(responses[0]) && isRecord3(responses[0].payload) && isRecord3(responses[0].payload.result) && typeof responses[0].payload.result.sessionId === "string") sessionIds.push(responses[0].payload.result.sessionId);
  }
  for (const record3 of records) {
    if (!isRecord3(record3)) continue;
    const hook = typeof record3.hook === "string" ? record3.hook : typeof record3.hook_event_name === "string" ? record3.hook_event_name : typeof record3.type === "string" ? record3.type : void 0;
    if (hook !== void 0 && PINNED_HOOK_EVENTS.has(hook)) hookNames.push(hook);
    for (const sessionId of [
      record3.sessionId,
      record3.session_id,
      record3.schemaVersion === "ebo.protocol-observation/v1" && (record3.source === "codex-app-server" || record3.source === "devin-cli") ? record3.sourceIdentity : void 0,
      isRecord3(record3.message) ? record3.message.session_id : void 0
    ]) {
      if (typeof sessionId === "string") sessionIds.push(sessionId);
    }
  }
  return { hookNames, sessionIds };
}
function qualifyHooks(report, manifest, hooks, options) {
  const capabilities = options.hookCapabilities ?? options.agentSdkEvidence?.capabilities;
  if (capabilities === void 0) {
    addQualificationReason(report, "hooks", "gap", "HOOK_CAPABILITY_NOT_CHECKED", void 0, "Pinned TypeScript hook capabilities were not supplied.");
    return;
  }
  const runtimeVersion = manifest.run.runtime.find((component) => component.name === "agent-sdk")?.version;
  if (runtimeVersion !== capabilities.sdkVersion) {
    addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_VERSION_MISMATCH", void 0, `Retained Agent SDK ${String(runtimeVersion)} does not match capability profile ${capabilities.sdkVersion}.`);
  }
  const observed = new Set(hooks.flatMap(({ hookNames }) => hookNames ?? []));
  const supported = new Set(Object.keys(capabilities.hooks));
  const unsupported = new Set(capabilities.unsupportedHooks);
  for (const hook of options.expectedHooks ?? []) {
    if (supported.has(hook) && !observed.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_SUPPORTED_BUT_MISSING", void 0, `Pinned SDK supports expected hook ${hook}, but no callback was retained.`);
    } else if (unsupported.has(hook)) {
      addQualificationReason(report, "hooks", "unsupported", "HOOK_UNSUPPORTED_BY_PINNED_SDK", void 0, `Pinned SDK does not support expected hook ${hook}.`);
    } else if (!supported.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_CONTRADICTION", void 0, `Expected hook ${hook} is absent from the pinned capability profile.`);
    }
  }
  for (const hook of observed) {
    if (unsupported.has(hook)) {
      addQualificationReason(report, "hooks", "unqualified", "HOOK_CAPABILITY_CONTRADICTION", void 0, `Hook ${hook} was observed although the pinned profile declares it unsupported.`);
    }
  }
}
function qualifyTelemetry(report, telemetry, missing2) {
  const optionalBeta = missing2.some((entry) => entry.reason === "optional-beta-unavailable" && Array.isArray(entry.affects) && entry.affects.includes("timing-resource"));
  const unsupported = missing2.some((entry) => entry.reason === "unsupported" && Array.isArray(entry.affects) && entry.affects.includes("timing-resource"));
  if (optionalBeta) {
    addQualificationReason(report, "telemetry", "gap", "OPTIONAL_BETA_TIMING_UNAVAILABLE", void 0, "Optional detailed-beta timing is unavailable; semantic hook evidence remains usable.");
  }
  if (telemetry.length === 0) {
    if (unsupported) {
      addQualificationReason(report, "telemetry", "unsupported", "TELEMETRY_UNSUPPORTED_BY_PINNED_RUNTIME", void 0, "Pinned runtime explicitly does not support telemetry evidence.");
    } else if (!optionalBeta) {
      addQualificationReason(report, "telemetry", "unqualified", "TELEMETRY_EVIDENCE_MISSING", void 0, "No valid telemetry evidence is retained.");
    }
    return;
  }
  for (const entry of telemetry) {
    const receipt = isRecord3(entry.document) && isRecord3(entry.document.telemetry) ? entry.document.telemetry.receipt : void 0;
    if (!isRecord3(receipt) || receipt.status !== "received") {
      addQualificationReason(report, "telemetry", "gap", "TELEMETRY_RECEIPT_MISSING", void 0, `Collector receipt status is ${String(isRecord3(receipt) ? receipt.status : "absent")}.`);
    }
  }
}
function telemetrySummary(value) {
  const receipt = isRecord3(value) && isRecord3(value.telemetry) ? value.telemetry.receipt : void 0;
  return { telemetry: { ...isRecord3(receipt) ? { receipt: structuredClone(receipt) } : {} } };
}
async function workspacePatchApplies(startingWorkspacePath, patch) {
  const temporaryRoot = await mkdtemp(join2(tmpdir(), "ebo-qualification-patch-"));
  const applied = join2(temporaryRoot, "workspace");
  const patchPath = join2(temporaryRoot, "workspace.patch");
  try {
    await cp(resolve4(startingWorkspacePath), applied, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: false });
    if (patch.length > 0) {
      await writeFile(patchPath, patch, { flag: "wx", mode: 384 });
      await execFileAsync2("git", ["apply", "--check", "--binary", patchPath], { cwd: applied });
      await execFileAsync2("git", ["apply", "--binary", patchPath], { cwd: applied });
    }
    return true;
  } catch {
    return false;
  } finally {
    await rm2(temporaryRoot, { recursive: true, force: true });
  }
}
function crossCheckCaptureReport(report, evidenceId, value, actual, assessmentMode = "verified", semanticEvidenceKinds = ["session", "hook"]) {
  if (!isRecord3(value) || !isRecord3(value.capabilities)) return;
  if ((value.assessmentMode ?? "verified") !== assessmentMode) {
    addQualificationReason(report, "terminal", "unqualified", "CAPTURE_REPORT_CONTRADICTS_SOURCE", evidenceId, "Capture report assessment mode contradicts the run manifest.");
  }
  for (const [area, available] of Object.entries(actual)) {
    const capability = value.capabilities[area];
    const claimsAvailable = isRecord3(capability) && capability.status === "available";
    const claimsUnsupported = isRecord3(capability) && capability.status === "unsupported";
    if (!available && claimsAvailable || available && claimsUnsupported) {
      const dimension = area === "semantic" ? "semanticEvidence" : area === "timingResource" ? "telemetry" : "workspace";
      addQualificationReason(report, dimension, "unqualified", "CAPTURE_REPORT_CONTRADICTS_SOURCE", evidenceId, `Capture report ${area}=${String(isRecord3(capability) ? capability.status : void 0)} contradicts retained source evidence.`);
    }
  }
  const retainedKinds = /* @__PURE__ */ new Set();
  if (actual.semantic) for (const kind of semanticEvidenceKinds) retainedKinds.add(kind);
  if (actual.timingResource) retainedKinds.add("telemetry");
  if (actual.outcome) {
    retainedKinds.add("workspace");
    if (assessmentMode === "verified") retainedKinds.add("verifier");
  }
  for (const entry of captureMissingEvidence(value)) {
    if (retainedKinds.has(entry.kind) && entry.reason !== "optional-beta-unavailable") {
      const dimension = entry.kind === "telemetry" ? "telemetry" : ["workspace", "verifier"].includes(String(entry.kind)) ? "workspace" : "semanticEvidence";
      addQualificationReason(report, dimension, "unqualified", "CAPTURE_REPORT_CONTRADICTS_SOURCE", evidenceId, `Capture report marks retained ${String(entry.kind)} evidence as missing.`);
    }
  }
}
function captureMissingEvidence(value) {
  return isRecord3(value) && Array.isArray(value.missingEvidence) ? value.missingEvidence.filter(isRecord3) : [];
}
function captureReportSemanticEvidenceKinds(value) {
  if (!isRecord3(value) || !Array.isArray(value.semanticEvidenceKinds) || value.semanticEvidenceKinds.length === 0 || new Set(value.semanticEvidenceKinds).size !== value.semanticEvidenceKinds.length || !value.semanticEvidenceKinds.includes("session") || value.semanticEvidenceKinds.some((kind) => kind !== "session" && kind !== "hook")) return void 0;
  return value.semanticEvidenceKinds;
}
function captureReportRelatedSessionIds(value) {
  if (!isRecord3(value) || !Array.isArray(value.relatedSessionIds) || value.relatedSessionIds.some((id) => typeof id !== "string" || id.trim() === "") || new Set(value.relatedSessionIds).size !== value.relatedSessionIds.length) return void 0;
  return value.relatedSessionIds;
}
function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
function descriptorFromValidationField(manifest, field) {
  if (!field.startsWith("/evidence/")) return void 0;
  const id = field.slice("/evidence/".length).split("/")[0]?.replaceAll("~1", "/").replaceAll("~0", "~");
  return manifest.evidence.find((descriptor) => descriptor.id === id);
}
function digestValue(value) {
  return { algorithm: "sha256", value: value.slice("sha256:".length) };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function digestString2(value) {
  return `sha256:${value}`;
}

// src/agent-sdk-normalizer.ts
init_scheduler();
var CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID = "claude-agent-sdk/v1";
var CLAUDE_AGENT_SDK_HARNESS = "claude-agent-sdk";
var CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION = "1.0.0";
var MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
var MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
var HOOK_EVENT_SET = new Set(HOOK_EVENTS2);
var DELEGATION_SUBTYPES = /* @__PURE__ */ new Set(["task_started", "task_progress", "task_updated", "task_notification"]);
var SESSION_NATIVE_TYPES = [
  "assistant",
  "auth_status",
  "conversation_reset",
  "prompt_suggestion",
  "rate_limit_event",
  "result",
  "stream_event",
  "system",
  "tool_progress",
  "tool_use_summary",
  "user"
];
var ADAPTER_NATIVE_TYPES = [
  ...SESSION_NATIVE_TYPES,
  ...HOOK_EVENTS2,
  "agent-sdk-telemetry",
  "workspace-outcome",
  "verifier-result",
  "assessment-mode",
  "terminal-record"
];
var BASE_CAPABILITY_PROFILE = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID,
  harness: CLAUDE_AGENT_SDK_HARNESS,
  nativeTypes: ADAPTER_NATIVE_TYPES,
  families: {
    message: { status: "available" },
    "model-request": {
      status: "unsupported",
      detail: "Retained Agent SDK evidence does not expose inference-request lifecycle records."
    },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "available" },
    delegation: { status: "available" },
    artifact: { status: "available" },
    validation: { status: "available" },
    runtime: { status: "available" },
    outcome: { status: "available" }
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Session and hook streams retain independent source-local sequences." },
    nativeTime: { status: "partial", detail: "Origin timestamps are used when emitted; otherwise hook callback or EBO receipt time, labeled by nativeTimeSource." },
    parentage: { status: "partial", detail: "Relations require stable tool-use, task, agent, or workspace identifiers." },
    content: { status: "partial", detail: "Raw content remains in native evidence and is represented only by references." }
  }
};
var claudeAgentSdkNormalizationAdapter = {
  id: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_ID,
  harness: CLAUDE_AGENT_SDK_HARNESS,
  capabilityProfile: BASE_CAPABILITY_PROFILE,
  async normalize(input) {
    assertQualifiedInput(input);
    const drafts = [];
    const unmapped = [];
    const usageMessageIds = /* @__PURE__ */ new Set();
    for (const captured of input.records) {
      const mapped = [...mapRecord(input, captured), ...mapRequestUsage(input, captured, usageMessageIds)];
      drafts.push(...mapped);
      if (mapped.length === 0) {
        unmapped.push({
          reference: captured.reference,
          reason: unmappedReason(captured.record)
        });
      }
    }
    const capabilityProfile = capabilityProfileFor(input.records);
    assertValidCapabilityProfile(capabilityProfile);
    return {
      events: resolveRelations(drafts),
      unmapped,
      capabilityProfile
    };
  }
};
async function readQualifiedClaudeAgentSdkCapture(bundleRoot) {
  const manifest = readManifest(resolve5(bundleRoot));
  if (!manifest.run.runtime.some(({ source, name }) => source === "anthropic" && ["agent-sdk", CLAUDE_AGENT_SDK_HARNESS].includes(name))) {
    throw new Error("Run bundle is not an Agent SDK capture.");
  }
  const capture = await readQualifiedRunCapture(bundleRoot);
  assertQualifiedInput(capture);
  return capture;
}
async function readQualifiedRunCapture(bundleRoot) {
  const root = resolve5(bundleRoot);
  const manifest = readManifest(root);
  await assertPersistedStructuralQualification(root, manifest);
  const qualification = await qualifyRunBundle(root);
  if (!qualification.semanticAnalysisUsable || Object.entries(qualification.dimensions).some(([dimension, result]) => dimension !== "workspace" && result.status === "unqualified")) {
    const reasons = qualification.reasons.map(({ code }) => code).join(", ") || "unknown qualification failure";
    throw new Error(`Agent SDK normalization requires capture-qualified evidence: ${reasons}.`);
  }
  const records = [];
  for (const [evidenceIndex, descriptor] of manifest.evidence.entries()) {
    if (descriptor.sanitizedFrom !== void 0 || descriptor.kind === "export-manifest") continue;
    if (descriptor.kind === "workspace" || descriptor.kind === "diagnostic") {
      records.push({
        reference: { artifactId: "manifest", recordLocator: `#/evidence/${evidenceIndex}` },
        record: { kind: descriptor.kind, document: structuredClone(descriptor) }
      });
      continue;
    }
    const bytes = await readVerifiedArtifact(root, descriptor.relativePath, digestFrom(descriptor.digest), MAX_EVIDENCE_BYTES);
    if ((descriptor.kind === "session" || descriptor.kind === "hook") && descriptor.mediaType === "application/x-ndjson") {
      for (const { line, document } of parseJsonl(bytes)) {
        records.push({
          reference: { artifactId: descriptor.id, recordLocator: `line:${line}` },
          record: { kind: descriptor.kind, document }
        });
      }
    } else if ((descriptor.kind === "session" || descriptor.kind === "hook") && descriptor.mediaType === "application/json") {
      records.push({
        reference: { artifactId: descriptor.id, recordLocator: "#" },
        record: { kind: descriptor.kind, document: parseJson2(bytes) }
      });
    } else if (["telemetry", "verifier", "capture-report"].includes(descriptor.kind)) {
      records.push({
        reference: { artifactId: descriptor.id, recordLocator: "#" },
        record: { kind: descriptor.kind, document: parseJson2(bytes) }
      });
    }
  }
  if (manifest.run.assessmentMode !== void 0) {
    records.push({
      reference: { artifactId: "manifest", recordLocator: "#/run/assessmentMode" },
      record: { kind: "assessment-mode", document: manifest.run.assessmentMode }
    });
  }
  records.push({
    reference: { artifactId: "manifest", recordLocator: "#/terminal" },
    record: {
      kind: "manifest",
      document: structuredClone(manifest.terminal)
    }
  });
  const input = {
    runId: manifest.run.id,
    attemptId: manifest.attempt.id,
    qualification: qualification.status === "qualified" ? "qualified" : "qualified-with-gaps",
    records
  };
  return input;
}
function createAgentSdkNativeEvidenceResolver(input) {
  const resolved = (digest5) => ({
    runId: input.runId,
    attemptId: input.attemptId,
    digest: digest5
  });
  const records = new Map(input.records.map((captured) => [referenceKey3(captured.reference), {
    captured,
    resolution: resolved(`sha256:${digestMetadata(captured.record).value}`)
  }]));
  const manifestArtifacts = new Map(input.records.flatMap(({ record: record3, reference }) => {
    if (record3.kind !== "workspace" && record3.kind !== "diagnostic") return [];
    if (reference.artifactId !== "manifest" || !/^#\/evidence\/(0|[1-9][0-9]*)$/u.test(reference.recordLocator)) return [];
    const descriptor = asRecord(record3.document);
    const id = text2(descriptor?.id);
    const digest5 = text2(descriptor?.digest);
    return id === void 0 || digest5 === void 0 || !/^sha256:[a-f0-9]{64}$/u.test(digest5) ? [] : [[referenceKey3({ artifactId: id, recordLocator: "#" }), resolved(digest5)]];
  }));
  return {
    resolve(reference) {
      const exact = records.get(referenceKey3(reference))?.resolution ?? manifestArtifacts.get(referenceKey3(reference));
      if (exact !== void 0) return exact;
      const derived = splitDerivedLocator(reference.recordLocator);
      if (derived === void 0) return false;
      const record3 = records.get(referenceKey3({ artifactId: reference.artifactId, recordLocator: derived.base }));
      return record3 !== void 0 && resolvesJsonPointer2(record3.captured.record.document, derived.pointer) ? record3.resolution : false;
    }
  };
}
function mapRecord(input, captured) {
  switch (captured.record.kind) {
    case "session":
      return mapSessionRecord(input, captured);
    case "hook":
      return mapHookRecord(input, captured);
    case "telemetry":
      return mapTelemetryRecord(input, captured);
    case "workspace":
      return mapWorkspaceRecord(input, captured);
    case "verifier":
      return mapVerifierRecord(input, captured);
    case "assessment-mode":
      return mapAssessmentModeRecord(input, captured);
    case "manifest":
      return mapManifestRecord(input, captured);
    case "diagnostic":
    case "capture-report":
      return [];
  }
}
function mapSessionRecord(input, captured) {
  const wrapper = asRecord(captured.record.document);
  const nativeType = text2(wrapper?.nativeType);
  const message = asRecord(wrapper?.message);
  if (wrapper === void 0 || message === void 0 || nativeType === void 0) return [];
  const drafts = [];
  const subtype = text2(wrapper.nativeSubtype) ?? text2(message.subtype);
  const sessionId = text2(wrapper.sessionId) ?? text2(message.session_id);
  const nativeOrder = sourceOrder(wrapper, orderDomain("session", captured.reference.artifactId));
  const { nativeTime, timeSource } = sessionTime(wrapper, message);
  const common = { input, captured, nativeType, nativeOrder, nativeTime, timeSource, sessionId };
  const base = sessionEventShape(nativeType, subtype, message);
  if (base !== void 0) {
    const stableToolId = text2(message.tool_use_id);
    const stableTaskId = text2(message.task_id);
    drafts.push(draftEvent({
      ...common,
      discriminator: "record",
      family: base.family,
      phase: base.phase,
      actor: base.actor,
      scope: base.scope ?? (sessionId === void 0 ? { kind: "attempt", id: input.attemptId } : { kind: "session", id: sessionId }),
      attributes: sessionAttributes(nativeType, subtype, message),
      content: sessionContent(captured.reference, nativeType, subtype, message),
      relationKeys: [
        ...stableToolId === void 0 ? [] : [`tool:${stableToolId}`],
        ...stableTaskId === void 0 ? [] : [`task:${stableTaskId}`]
      ],
      anchors: nativeType === "system" && subtype === "task_started" && stableTaskId !== void 0 ? [{ key: `task:${stableTaskId}`, rank: 1 }] : [],
      parentKey: parentToolKey(message)
    }));
  }
  if (nativeType === "result") drafts.push(...mapResultResources(common, message));
  if (nativeType === "assistant" || nativeType === "user") {
    drafts.push(...mapToolBlocks(common, message));
  }
  return drafts;
}
function mapRequestUsage(input, captured, seen) {
  if (captured.record.kind !== "session") return [];
  const wrapper = asRecord(captured.record.document);
  const message = asRecord(wrapper?.message);
  const inner = asRecord(message?.message);
  const usage = asRecord(inner?.usage);
  const messageId = text2(inner?.id);
  if (wrapper === void 0 || message === void 0 || text2(wrapper.nativeType) !== "assistant" || usage === void 0 || messageId === void 0 || seen.has(messageId)) return [];
  seen.add(messageId);
  const sessionId = text2(wrapper.sessionId) ?? text2(message.session_id);
  const { nativeTime, timeSource } = sessionTime(wrapper, message);
  return [draftEvent({
    input,
    captured,
    discriminator: "request-usage",
    nativeType: "assistant",
    nativeOrder: sourceOrder(wrapper, orderDomain("session", captured.reference.artifactId)),
    nativeTime,
    timeSource,
    family: "runtime",
    phase: "after",
    actor: { kind: "model", ...text2(inner?.model) === void 0 ? {} : { id: text2(inner?.model) } },
    scope: sessionId === void 0 ? { kind: "attempt", id: input.attemptId } : { kind: "session", id: sessionId },
    attributes: compactAttributes({
      requestId: scalar(message.request_id),
      providerMessageId: messageId,
      model: scalar(inner?.model),
      inputTokens: tokenCount(usage.input_tokens),
      cacheReadInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheCreationInputTokens: tokenCount(usage.cache_creation_input_tokens),
      outputTokenCoverage: "unavailable-per-request",
      resourceSemantics: "increment",
      usageScope: parentToolKey(message) === void 0 ? "assistant" : "subagent"
    }),
    content: knownContent(contentReference(captured.reference, "/message/message/usage", "request-usage")),
    parentKey: parentToolKey(message)
  })];
}
function tokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function mapResultResources(common, message) {
  const modelUsage = asRecord(message.modelUsage);
  if (modelUsage === void 0 && typeof message.total_cost_usd !== "number") return [];
  return [draftEvent({
    ...common,
    discriminator: "resources",
    family: "runtime",
    phase: "after",
    actor: { kind: "harness" },
    scope: common.sessionId === void 0 ? { kind: "attempt", id: common.input.attemptId } : { kind: "session", id: common.sessionId },
    attributes: compactAttributes({
      inputTokens: summedModelUsage(modelUsage, "inputTokens"),
      outputTokens: summedModelUsage(modelUsage, "outputTokens"),
      cacheReadInputTokens: summedModelUsage(modelUsage, "cacheReadInputTokens"),
      cacheCreationInputTokens: summedModelUsage(modelUsage, "cacheCreationInputTokens"),
      totalCostUsd: scalar(message.total_cost_usd),
      resourceSemantics: "cumulative-final"
    }),
    content: { status: "unknown", reason: "Native resource details remain in the Agent SDK result record" }
  })];
}
function summedModelUsage(modelUsage, field) {
  const records = Object.values(modelUsage ?? {}).map(asRecord);
  const values = records.map((record3) => record3?.[field]);
  return records.length > 0 && values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ? values.reduce((total, value) => total + value, 0) : void 0;
}
function sessionEventShape(nativeType, subtype, message) {
  switch (nativeType) {
    case "assistant":
      return { family: "message", phase: "instant", actor: { kind: "model" } };
    case "user":
      return { family: "message", phase: "instant", actor: { kind: message.isSynthetic === true ? "harness" : "user" } };
    case "result":
      return { family: "outcome", phase: "after", actor: { kind: "harness" } };
    case "stream_event":
      return { family: "message", phase: "during", actor: { kind: "model" } };
    case "tool_progress":
      return { family: "tool", phase: "during", actor: { kind: "tool", ...text2(message.tool_name) === void 0 ? {} : { id: text2(message.tool_name) } } };
    case "tool_use_summary":
      return { family: "tool", phase: "after", actor: { kind: "harness" } };
    case "auth_status":
    case "rate_limit_event":
      return { family: "runtime", phase: "instant", actor: { kind: "harness" } };
    case "conversation_reset":
      return { family: "context", phase: "after", actor: { kind: "harness" } };
    case "prompt_suggestion":
      return { family: "message", phase: "after", actor: { kind: "harness" } };
    case "system":
      return systemEventShape(subtype);
    default:
      return void 0;
  }
}
function systemEventShape(subtype) {
  if (subtype === "compact_boundary") return { family: "context", phase: "after", actor: { kind: "harness" } };
  if (["task_started", "task_progress", "task_updated", "task_notification", "worker_shutting_down"].includes(subtype ?? "")) {
    return { family: "delegation", phase: subtype === "task_started" ? "before" : "during", actor: { kind: "agent" } };
  }
  if (subtype === "files_persisted") return { family: "artifact", phase: "after", actor: { kind: "harness" } };
  if (subtype === "permission_denied") return { family: "permission", phase: "after", actor: { kind: "harness" } };
  if ([
    "init",
    "status",
    "hook_started",
    "hook_progress",
    "hook_response",
    "background_tasks_changed",
    "thinking_tokens",
    "session_state_changed",
    "commands_changed",
    "notification",
    "informational",
    "local_command_output",
    "memory_recall",
    "elicitation_complete"
  ].includes(subtype ?? "")) return { family: "runtime", phase: "instant", actor: { kind: "harness" } };
  return void 0;
}
function mapToolBlocks(common, message) {
  const payload = asRecord(message.message);
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content.flatMap((value, index) => {
    const block = asRecord(value);
    if (block?.type === "tool_use") {
      const toolUseId = text2(block.id);
      const toolName = text2(block.name);
      if (toolUseId === void 0 || toolName === void 0) return [];
      return [draftEvent({
        ...common,
        discriminator: `tool-use:${index}`,
        family: "tool",
        phase: "before",
        actor: { kind: "model" },
        scope: { kind: "operation", id: toolUseId },
        attributes: {
          toolName,
          toolUseId,
          ...block.input === void 0 ? {} : { inputDigest: digestAttribute(block.input) }
        },
        content: knownContent(contentReference(common.captured.reference, `/message/message/content/${index}`, "tool-input")),
        anchors: [{ key: `tool:${toolUseId}`, rank: 0 }]
      })];
    }
    if (block?.type === "tool_result") {
      const toolUseId = text2(block.tool_use_id);
      if (toolUseId === void 0) return [];
      return [draftEvent({
        ...common,
        discriminator: `tool-result:${index}`,
        family: "tool",
        phase: "after",
        actor: { kind: "tool" },
        scope: { kind: "operation", id: toolUseId },
        attributes: { toolUseId, ...typeof block.is_error === "boolean" ? { isError: block.is_error } : {} },
        content: knownContent(contentReference(common.captured.reference, `/message/message/content/${index}`, "tool-result")),
        relationKeys: [`tool:${toolUseId}`]
      })];
    }
    return [];
  });
}
function mapHookRecord(input, captured) {
  const wrapper = asRecord(captured.record.document);
  const hook = text2(wrapper?.hook);
  const payload = asRecord(wrapper?.nativePayload);
  if (wrapper === void 0 || payload === void 0 || hook === void 0 || !HOOK_EVENT_SET.has(hook)) return [];
  const shape = hookEventShape(hook);
  if (shape === void 0) return [];
  const toolUseId = text2(wrapper.toolUseId) ?? text2(payload.tool_use_id);
  const agentId = text2(wrapper.agentId) ?? text2(payload.agent_id);
  const taskId = text2(payload.task_id);
  const stable = toolUseId === void 0 ? taskId === void 0 ? agentId === void 0 ? void 0 : `agent:${agentId}` : `task:${taskId}` : `tool:${toolUseId}`;
  const batchToolUseIds = hook === "PostToolBatch" && Array.isArray(payload.tool_calls) ? payload.tool_calls.flatMap((call) => text2(asRecord(call)?.tool_use_id) ?? []) : [];
  const anchorRank = hook === "PreToolUse" ? 1 : hook === "SubagentStart" || hook === "TaskCreated" ? 0 : void 0;
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: hook,
    nativeOrder: sourceOrder(wrapper, orderDomain("hooks", captured.reference.artifactId)),
    nativeTime: originTime(wrapper.callbackAt, "Hook callback record has no callback timestamp"),
    ...originTime(wrapper.callbackAt, "").status === "known" ? { timeSource: "hook-callback" } : {},
    family: shape.family,
    phase: shape.phase,
    actor: hookActor(shape.family, hook, payload),
    scope: hookScope(shape.family, input.attemptId, wrapper, payload, toolUseId, agentId, taskId),
    attributes: {
      ...hookAttributes(hook, payload, toolUseId, agentId, taskId),
      ...batchToolUseIds.length > 0 && batchToolUseIds.length <= 16 ? { batchToolUseIds } : {}
    },
    content: hookContent(captured.reference, hook, payload),
    anchors: stable === void 0 || anchorRank === void 0 ? [] : [{ key: stable, rank: anchorRank }],
    relationKeys: [...stable === void 0 ? [] : [stable], ...batchToolUseIds.map((id) => `tool:${id}`)]
  })];
}
function hookEventShape(hook) {
  if (["PreToolUse"].includes(hook)) return { family: "tool", phase: "before" };
  if (["PostToolUse", "PostToolUseFailure", "PostToolBatch"].includes(hook)) return { family: "tool", phase: "after" };
  if (["UserPromptSubmit", "UserPromptExpansion"].includes(hook)) return { family: "message", phase: "before" };
  if (hook === "MessageDisplay") return { family: "message", phase: "after" };
  if (hook === "PreCompact") return { family: "context", phase: "before" };
  if (["PostCompact", "InstructionsLoaded"].includes(hook)) return { family: "context", phase: "after" };
  if (hook === "PreModelSwitch") return { family: "runtime", phase: "before" };
  if (hook === "PostModelSwitch") return { family: "runtime", phase: "after" };
  if (["PermissionRequest", "Elicitation"].includes(hook)) return { family: "permission", phase: "before" };
  if (["PermissionDenied", "ElicitationResult"].includes(hook)) return { family: "permission", phase: "after" };
  if (["SubagentStart", "TaskCreated"].includes(hook)) return { family: "delegation", phase: "before" };
  if (["SubagentStop", "TaskCompleted"].includes(hook)) return { family: "delegation", phase: "after" };
  if (hook === "TeammateIdle") return { family: "delegation", phase: "instant" };
  if (["WorktreeCreate"].includes(hook)) return { family: "artifact", phase: "before" };
  if (["WorktreeRemove"].includes(hook)) return { family: "artifact", phase: "after" };
  if (["FileChanged", "DirectoryAdded"].includes(hook)) return { family: "artifact", phase: "instant" };
  if (["SessionStart", "Setup"].includes(hook)) return { family: "runtime", phase: "before" };
  if (["SessionEnd", "Stop", "StopFailure"].includes(hook)) return { family: "runtime", phase: "after" };
  if (["Notification", "ConfigChange", "CwdChanged"].includes(hook)) return { family: "runtime", phase: "instant" };
  return void 0;
}
function mapTelemetryRecord(input, captured) {
  const document = asRecord(captured.record.document);
  if (document?.schemaVersion !== "ebo.agent-sdk-telemetry/v1") return [];
  const telemetry = asRecord(document.telemetry);
  const receipt = asRecord(telemetry?.receipt);
  const usage = asRecord(document.usage);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "agent-sdk-telemetry",
    nativeOrder: { status: "unknown", reason: "Telemetry artifact has no cross-signal native order" },
    nativeTime: { status: "unknown", reason: "Telemetry summary has no native occurrence timestamp" },
    family: "runtime",
    phase: "during",
    actor: { kind: "system", id: "otlp" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      receiptStatus: scalar(receipt?.status),
      receivedSignals: scalarList(receipt?.signals),
      totalCostUsd: scalar(usage?.totalCostUsd),
      numTurns: scalar(usage?.numTurns)
    }),
    content: { status: "unknown", reason: "Telemetry payload remains in native evidence" }
  })];
}
function mapWorkspaceRecord(input, captured) {
  const descriptor = asRecord(captured.record.document);
  if (descriptor?.kind !== "workspace" || captured.reference.artifactId !== "manifest" || !/^#\/evidence\/(0|[1-9][0-9]*)$/u.test(captured.reference.recordLocator)) return [];
  const mediaType = text2(descriptor.mediaType);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "workspace-outcome",
    nativeOrder: { status: "unknown", reason: "Workspace artifact has no native event order" },
    nativeTime: { status: "unknown", reason: "Workspace artifact has no native occurrence timestamp" },
    family: "artifact",
    phase: "after",
    actor: { kind: "system", id: "ebo-workspace" },
    scope: { kind: "workspace", id: descriptor.id },
    attributes: compactAttributes({ mediaType: descriptor.mediaType, fingerprint: descriptor.fingerprint }),
    content: knownContent({
      nativeReference: { artifactId: descriptor.id, recordLocator: "#" },
      ...mediaType === void 0 ? {} : { mediaType },
      role: "workspace-outcome"
    }),
    anchors: [{ key: `artifact:${descriptor.id}`, rank: 0 }]
  })];
}
function mapVerifierRecord(input, captured) {
  const document = asRecord(captured.record.document);
  if (!isVerifierRecord(captured) || document === void 0) return [];
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "verifier-result",
    nativeOrder: { status: "unknown", reason: "Verifier artifact has no native event order" },
    nativeTime: { status: "unknown", reason: "Verifier result has no native occurrence timestamp" },
    family: "validation",
    phase: "after",
    actor: { kind: "system", id: "ebo-verifier" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      status: scalar(document.status),
      exitCode: scalar(document.exitCode),
      assertionCount: Array.isArray(document.assertions) ? document.assertions.length : void 0
    }),
    content: Array.isArray(document.assertions) ? knownContent(contentReference(captured.reference, "/assertions", "assertions")) : { status: "unknown", reason: "Verifier assertions were not retained" }
  })];
}
function mapManifestRecord(input, captured) {
  const terminal = asRecord(captured.record.document);
  if (terminal === void 0 || typeof terminal.state !== "string" || captured.reference.artifactId !== "manifest" || captured.reference.recordLocator !== "#/terminal") return [];
  const workspaceId = text2(terminal.workspaceArtifactId);
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "terminal-record",
    nativeOrder: { status: "unknown", reason: "Run manifest has no native event order" },
    nativeTime: { status: "unknown", reason: "Terminal record has no native occurrence timestamp" },
    family: "outcome",
    phase: "after",
    actor: { kind: "system", id: "ebo" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: compactAttributes({
      state: scalar(terminal.state),
      failureClass: scalar(terminal.failureClass),
      stopReason: scalar(terminal.stopReason)
    }),
    content: workspaceId === void 0 ? { status: "unknown", reason: "Terminal record does not identify a workspace artifact" } : knownContent({ nativeReference: { artifactId: workspaceId, recordLocator: "#" }, role: "final-workspace" }),
    relationKeys: workspaceId === void 0 ? [] : [`artifact:${workspaceId}`]
  })];
}
function mapAssessmentModeRecord(input, captured) {
  const assessmentMode = assessmentModeOf(captured);
  if (assessmentMode === void 0) return [];
  return [draftEvent({
    input,
    captured,
    discriminator: "record",
    nativeType: "assessment-mode",
    nativeOrder: { status: "unknown", reason: "Run assessment mode has no native event order" },
    nativeTime: { status: "unknown", reason: "Run assessment mode has no native occurrence timestamp" },
    family: "outcome",
    phase: "instant",
    actor: { kind: "system", id: "ebo" },
    scope: { kind: "attempt", id: input.attemptId },
    attributes: { assessmentMode },
    content: { status: "known", value: [] }
  })];
}
function draftEvent(input) {
  return {
    event: {
      schemaVersion: "ebo.uniform-event/v1",
      id: stableEventId(input.input, input.captured.reference, input.discriminator),
      runId: input.input.runId,
      attemptId: input.input.attemptId,
      source: {
        harness: CLAUDE_AGENT_SDK_HARNESS,
        nativeType: input.nativeType,
        nativeReference: input.captured.reference
      },
      nativeOrder: input.nativeOrder,
      nativeTime: input.nativeTime,
      actor: input.actor,
      family: input.family,
      phase: input.phase,
      scope: input.scope,
      relations: { parent: { status: "unknown", reason: "Native record does not establish an emitted parent" }, known: [] },
      attributes: input.timeSource === void 0 || input.nativeTime.status !== "known" ? input.attributes : { ...input.attributes, nativeTimeSource: input.timeSource },
      content: input.content
    },
    anchors: input.anchors ?? [],
    relationKeys: input.relationKeys ?? [],
    ...input.parentKey === void 0 ? {} : { parentKey: input.parentKey }
  };
}
function resolveRelations(drafts) {
  const candidates = /* @__PURE__ */ new Map();
  for (const draft of drafts) {
    for (const anchor of draft.anchors) {
      const entries = candidates.get(anchor.key) ?? [];
      entries.push({ id: draft.event.id, rank: anchor.rank });
      candidates.set(anchor.key, entries);
    }
  }
  const anchors = /* @__PURE__ */ new Map();
  for (const [key, entries] of candidates) {
    const minimum = Math.min(...entries.map(({ rank }) => rank));
    const preferred = entries.filter(({ rank }) => rank === minimum);
    if (preferred.length === 1) anchors.set(key, preferred[0].id);
  }
  return drafts.map((draft) => {
    const known2 = [...new Set(draft.relationKeys.map((key) => anchors.get(key)))].filter((id) => id !== void 0 && id !== draft.event.id).map((eventId) => ({ kind: "correlates-with", eventId }));
    const parent = draft.parentKey === void 0 ? draft.event.relations.parent : anchors.has(draft.parentKey) ? { status: "known", value: anchors.get(draft.parentKey) } : { status: "unknown", reason: "Stable parent tool ID has no uniquely mapped tool-call event" };
    return { ...draft.event, relations: { parent, known: known2 } };
  });
}
function capabilityProfileFor(records) {
  const retainedCapabilities = records.flatMap(({ record: record3 }) => {
    if (record3.kind !== "capture-report") return [];
    const agentSdk = asRecord(asRecord(record3.document)?.agentSdk);
    const capabilities = asRecord(agentSdk?.capabilities);
    return capabilities === void 0 ? [] : [capabilities];
  })[0];
  const sdkVersion = text2(retainedCapabilities?.sdkVersion);
  const detailedBetaConfigured = records.some(({ record: record3 }) => {
    if (record3.kind !== "telemetry") return false;
    const telemetry = asRecord(asRecord(record3.document)?.telemetry);
    return asRecord(telemetry?.hookSpans)?.status === "enabled";
  });
  return {
    ...structuredClone(BASE_CAPABILITY_PROFILE),
    families: {
      ...structuredClone(BASE_CAPABILITY_PROFILE.families),
      "model-request": {
        status: "unsupported",
        detail: sdkVersion === void 0 ? "Retained Agent SDK evidence does not establish inference-request lifecycle coverage." : `Retained Agent SDK ${sdkVersion} exposes model-switch callbacks, not inference-request lifecycle records.`
      }
    },
    evidence: {
      ...structuredClone(BASE_CAPABILITY_PROFILE.evidence),
      nativeTime: {
        status: "partial",
        detail: detailedBetaConfigured ? "Origin timestamps are used when emitted; otherwise hook callback or EBO receipt time, labeled by nativeTimeSource. Detailed-beta hook spans are configured but are not substituted for native semantic events." : "Origin timestamps are used when emitted; otherwise hook callback or EBO receipt time, labeled by nativeTimeSource. Detailed-beta hook span timing is unavailable."
      }
    }
  };
}
function assertQualifiedInput(input) {
  if (!["qualified", "qualified-with-gaps"].includes(input.qualification)) {
    throw new Error("Agent SDK normalization requires capture-qualified evidence.");
  }
  if (text2(input.runId) === void 0 || text2(input.attemptId) === void 0 || !Array.isArray(input.records)) {
    throw new Error("Agent SDK normalization input identity is invalid.");
  }
  const kinds = new Set(input.records.map(({ record: record3 }) => record3.kind));
  for (const required3 of ["session", "hook", "manifest"]) {
    if (!kinds.has(required3)) throw new Error(`Capture-qualified Agent SDK input is missing required ${required3} evidence.`);
  }
  const assessmentMode = input.records.map(assessmentModeOf).find((value) => value !== void 0);
  if (assessmentMode !== "observational" && !kinds.has("workspace")) {
    throw new Error("Capture-qualified verified input is missing required workspace evidence.");
  }
  if (assessmentMode !== "observational" && !input.records.some(isVerifierRecord)) {
    throw new Error("Capture-qualified verified input is missing required verifier evidence.");
  }
}
function assessmentModeOf(captured) {
  return captured.record.kind === "assessment-mode" && captured.reference.artifactId === "manifest" && captured.reference.recordLocator === "#/run/assessmentMode" && (captured.record.document === "observational" || captured.record.document === "verified") ? captured.record.document : void 0;
}
function isVerifierRecord(captured) {
  return captured.record.kind === "verifier" && captured.reference.recordLocator === "#" && asRecord(captured.record.document)?.schemaVersion === "verifier-result/v1";
}
function assertValidCapabilityProfile(profile2) {
  const errors = validateArtifact("Agent SDK adapter capability profile", profile2);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
}
function readManifest(root) {
  const bytes = readBoundedFile(resolve5(root, "manifest.json"), "Run manifest", void 0, MAX_MANIFEST_BYTES);
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(textValue);
  const document = JSON.parse(textValue);
  const errors = validateArtifact("manifest.json", document);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  return document;
}
async function assertPersistedStructuralQualification(root, manifest) {
  const descriptor = manifest.evidence.find(({ kind, sanitizedFrom }) => kind === "capture-report" && sanitizedFrom === void 0);
  if (descriptor === void 0) return;
  const report = asRecord(parseJson2(await readVerifiedArtifact(
    root,
    descriptor.relativePath,
    digestFrom(descriptor.digest),
    MAX_EVIDENCE_BYTES
  )));
  const structural = asRecord(report?.structuralQualification);
  if (structural?.semanticAnalysisUsable === false || structural?.status === "unqualified" && structural?.semanticAnalysisUsable !== true) {
    throw new Error("Agent SDK normalization rejects the persisted unqualified structural capture report.");
  }
}
function parseJsonl(bytes) {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return textValue.split(/\r?\n/u).map((value, index) => ({ value, line: index + 1 })).filter(({ value }) => value.trim() !== "").map(({ value, line }) => {
    assertNoDuplicateJsonKeys(value);
    return { line, document: JSON.parse(value) };
  });
}
function parseJson2(bytes) {
  const textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(textValue);
  return JSON.parse(textValue);
}
function digestFrom(value) {
  return { algorithm: "sha256", value: value.replace(/^sha256:/u, "") };
}
function sourceOrder(document, domain) {
  const sequence = document.sequence;
  return Number.isSafeInteger(sequence) && Number(sequence) >= 0 ? { status: "known", value: Number(sequence), domain } : { status: "unknown", reason: `${domain} record has no valid source-local sequence` };
}
function orderDomain(kind, artifactId) {
  const readable = `${kind}:${artifactId}`;
  return [...readable].length <= 256 ? readable : `${kind}:sha256:${createHash3("sha256").update(artifactId).digest("hex")}`;
}
function sessionTime(wrapper, message) {
  const origin = originTime(message.timestamp, "Agent SDK message has no originating timestamp");
  if (message.timestamp !== void 0) return { nativeTime: origin };
  const receipt = originTime(wrapper.capturedAt, "Agent SDK message has no originating or receipt timestamp");
  return receipt.status === "known" ? { nativeTime: receipt, timeSource: "capture-receipt" } : { nativeTime: receipt };
}
function originTime(value, reason) {
  if (typeof value === "string" && isRfc3339DateTime(value)) return { status: "known", value };
  return { status: "unknown", reason };
}
function isRfc3339DateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/iu.exec(value);
  if (match === null) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === void 0 ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === void 0 ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1] && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}
function sessionAttributes(nativeType, subtype, message) {
  const rateLimit = asRecord(message.rate_limit_info);
  const delegation = nativeType === "system" && DELEGATION_SUBTYPES.has(subtype ?? "");
  return compactAttributes({
    subtype,
    messageId: scalar(message.uuid),
    model: scalar(asRecord(message.message)?.model),
    isSynthetic: scalar(message.isSynthetic),
    isError: scalar(message.is_error),
    stopReason: scalar(message.stop_reason),
    numTurns: scalar(message.num_turns),
    toolName: scalar(message.tool_name),
    elapsedSeconds: scalar(message.elapsed_time_seconds),
    durationMs: scalar(message.duration_ms),
    apiDurationMs: scalar(message.duration_api_ms),
    unprojectedToolBlockCount: unprojectedToolBlockCount(message),
    resourceSemantics: nativeType === "result" && typeof message.duration_ms === "number" ? "cumulative-final" : void 0,
    taskId: delegation ? scalar(message.task_id) : void 0,
    toolUseId: delegation ? scalar(message.tool_use_id) : void 0,
    taskType: delegation ? scalar(message.task_type) : void 0,
    taskStatus: delegation ? scalar(message.status) : void 0,
    isBackgrounded: delegation ? scalar(message.is_backgrounded) : void 0,
    rateLimitStatus: nativeType === "rate_limit_event" ? scalar(rateLimit?.status) : void 0,
    rateLimitType: nativeType === "rate_limit_event" ? scalar(rateLimit?.rateLimitType) : void 0,
    utilization: nativeType === "rate_limit_event" ? scalar(rateLimit?.utilization) : void 0
  });
}
function unprojectedToolBlockCount(message) {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return void 0;
  const count2 = content.filter((value) => {
    const block = asRecord(value);
    return block?.type === "tool_use" && (text2(block.id) === void 0 || text2(block.name) === void 0) || block?.type === "tool_result" && text2(block.tool_use_id) === void 0;
  }).length;
  return count2 === 0 ? void 0 : count2;
}
function sessionContent(reference, nativeType, subtype, message) {
  const inner = asRecord(message.message);
  if ((nativeType === "assistant" || nativeType === "user") && inner?.content !== void 0) {
    return knownContent(contentReference(reference, "/message/message/content", `${nativeType}-message`));
  }
  if (nativeType === "result" && (message.result !== void 0 || message.errors !== void 0)) {
    return knownContent(contentReference(reference, message.result !== void 0 ? "/message/result" : "/message/errors", "result"));
  }
  if (nativeType === "prompt_suggestion" && message.suggestion !== void 0) {
    return knownContent(contentReference(reference, "/message/suggestion", "suggestion"));
  }
  if (nativeType === "system" && ["local_command_output", "informational"].includes(subtype ?? "") && message.content !== void 0) {
    return knownContent(contentReference(reference, "/message/content", "system-message"));
  }
  if (nativeType === "system" && DELEGATION_SUBTYPES.has(subtype ?? "")) {
    const fields = [["description", "task-description"], ["summary", "task-summary"], ["patch", "task-patch"]];
    const present = fields.filter(([field]) => message[field] !== void 0);
    if (present.length > 0) return knownContent(...present.map(([field, role]) => contentReference(reference, `/message/${field}`, role)));
  }
  return { status: "unknown", reason: "Native message content remains in the source record" };
}
function hookActor(family, hook, payload) {
  if (family === "tool") return { kind: "tool", ...text2(payload.tool_name) === void 0 ? {} : { id: text2(payload.tool_name) } };
  if (family === "delegation") return { kind: "agent", ...text2(payload.agent_id) === void 0 ? {} : { id: text2(payload.agent_id) } };
  if (hook === "UserPromptSubmit" || hook === "UserPromptExpansion") return { kind: "user" };
  if (hook === "MessageDisplay") return { kind: "model" };
  if (family === "artifact") return { kind: "agent" };
  return { kind: "harness" };
}
function hookScope(family, attemptId, wrapper, payload, toolUseId, agentId, taskId) {
  if ((family === "tool" || family === "permission") && toolUseId !== void 0) return { kind: "operation", id: toolUseId };
  if (family === "delegation" && (taskId ?? agentId) !== void 0) return { kind: "operation", id: taskId ?? agentId };
  if (family === "artifact") return { kind: "workspace" };
  const turnId = text2(payload.turn_id);
  if (family === "message" && turnId !== void 0) return { kind: "turn", id: turnId };
  const sessionId = text2(wrapper.sessionId) ?? text2(payload.session_id);
  return sessionId === void 0 ? { kind: "attempt", id: attemptId } : { kind: "session", id: sessionId };
}
function hookAttributes(hook, payload, toolUseId, agentId, taskId) {
  return compactAttributes({
    hook,
    mutation: hook === "FileChanged" ? true : void 0,
    toolUseId,
    toolName: scalar(payload.tool_name),
    inputDigest: hook === "PreToolUse" && payload.tool_input !== void 0 ? digestAttribute(payload.tool_input) : void 0,
    agentId,
    agentType: scalar(payload.agent_type),
    taskId,
    trigger: scalar(payload.trigger),
    source: scalar(payload.source),
    fromModel: scalar(payload.from_model),
    toModel: scalar(payload.to_model),
    requestedModel: scalar(payload.requested_model),
    decision: hook === "PermissionDenied" ? "denied" : scalar(payload.action),
    event: scalar(payload.event),
    notificationType: scalar(payload.notification_type),
    mcpServerName: scalar(payload.mcp_server_name)
  });
}
function hookContent(reference, hook, payload) {
  const fields = {
    UserPromptSubmit: { field: "prompt", role: "user-prompt" },
    UserPromptExpansion: { field: "prompt", role: "expanded-prompt" },
    MessageDisplay: { field: "delta", role: "display-message" },
    Notification: { field: "message", role: "notification" },
    PreCompact: { field: "custom_instructions", role: "compaction-instructions" },
    PostCompact: { field: "compact_summary", role: "compaction-summary" },
    Elicitation: { field: "message", role: "elicitation" },
    PreToolUse: { field: "tool_input", role: "tool-input" },
    PostToolUse: { field: "tool_response", role: "tool-result" },
    PostToolUseFailure: { field: "error", role: "tool-error" },
    PostToolBatch: { field: "tool_calls", role: "tool-batch" }
  };
  const selected = fields[hook];
  return selected !== void 0 && payload[selected.field] !== void 0 ? knownContent(contentReference(reference, `/nativePayload/${selected.field}`, selected.role)) : { status: "unknown", reason: "Hook payload content remains in the source record" };
}
function parentToolKey(message) {
  const parent = text2(message.parent_tool_use_id);
  return parent === void 0 ? void 0 : `tool:${parent}`;
}
function stableEventId(input, reference, discriminator) {
  const digest5 = createHash3("sha256").update(JSON.stringify([
    input.runId,
    input.attemptId,
    reference.artifactId,
    reference.recordLocator,
    discriminator
  ])).digest("hex");
  return `agent-sdk-${digest5.slice(0, 32)}`;
}
function contentReference(reference, pointer, role) {
  return {
    nativeReference: {
      artifactId: reference.artifactId,
      recordLocator: reference.recordLocator === "#" ? `#${pointer}` : `${reference.recordLocator}#${pointer}`
    },
    role
  };
}
function knownContent(...content) {
  return { status: "known", value: content };
}
function compactAttributes(values) {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== void 0 && validAttributeValue(entry[1])));
}
function scalar(value) {
  return validAttributeScalar(value) ? value : void 0;
}
function scalarList(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(validAttributeScalar) ? value : void 0;
}
function digestAttribute(value) {
  return `sha256:${digestMetadata(value).value}`;
}
function validAttributeValue(value) {
  return Array.isArray(value) ? value.length <= 16 && value.every(validAttributeScalar) : validAttributeScalar(value);
}
function validAttributeScalar(value) {
  return value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && [...value].length <= 512;
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text2(value) {
  return typeof value === "string" && value.trim() !== "" && [...value].length <= 256 ? value : void 0;
}
function unmappedReason(record3) {
  if (record3.kind === "capture-report") return "Capture qualification metadata informs the capability report and is not a semantic event";
  if (record3.kind === "diagnostic") return "Diagnostic sidecar remains native outcome evidence";
  if (record3.kind === "session") return "Unrecognized Agent SDK message type remains in the native session artifact";
  if (record3.kind === "hook") return "Unrecognized Agent SDK hook record remains in the native hook artifact";
  return `Unrecognized ${record3.kind} record remains in native evidence`;
}
function referenceKey3(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
function splitDerivedLocator(locator) {
  if (locator.startsWith("#/")) return { base: "#", pointer: locator.slice(1) };
  const marker = locator.indexOf("#/");
  return marker === -1 ? void 0 : { base: locator.slice(0, marker), pointer: locator.slice(marker + 1) };
}
function resolvesJsonPointer2(document, pointer) {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  let current = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment) || Number(segment) >= current.length) return false;
      current = current.at(Number(segment));
    } else {
      const record3 = asRecord(current);
      const property = record3 === void 0 ? void 0 : Object.getOwnPropertyDescriptor(record3, segment);
      if (property === void 0 || !("value" in property)) return false;
      current = property.value;
    }
  }
  return true;
}

// src/behavior-assertions.ts
import { readFileSync as readFileSync2 } from "node:fs";

// src/evidence-projection.ts
init_artifacts();

// src/exports.ts
import { createHash as createHash4 } from "node:crypto";
import { homedir, userInfo } from "node:os";
init_artifacts();

// src/redaction.ts
var SECRET_PLACEHOLDER = "[REDACTED_SECRET]";
var TOKEN_PATTERNS = [
  {
    kind: "private-key",
    pattern: /()(?:-----BEGIN (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END (?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|$))/gu
  },
  { kind: "aws-access-key", pattern: /()\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { kind: "github-token", pattern: /()\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/gu },
  { kind: "anthropic-api-key", pattern: /()\bsk-ant-[A-Za-z0-9_-]{12,}/gu },
  { kind: "openai-style-api-key", pattern: /()\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu },
  { kind: "fireworks-api-key", pattern: /()\bfw_[A-Za-z0-9]{20,}/gu },
  { kind: "slack-token", pattern: /()\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { kind: "google-api-key", pattern: /()\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/gu },
  { kind: "jwt", pattern: /()\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu },
  { kind: "authorization-header", pattern: /(\bauthorization\s*[:=])(?!\s*\[REDACTED_)\s*[^\r\n]+/giu },
  { kind: "bearer-token", pattern: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{20,}/giu }
];
var SECRET_NAME = /(api[_-]?key|(?:access|oauth|refresh|id|auth)?[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?)?key)?|private[_-]?key|access[_-]?key|credentials?(?:[_-]?json)?|database[_-]?url|connection[_-]?string|passwd|password)(\\?["']?)([ \t]*)(:=|[:=](?![=>~]))([ \t]*)/giu;
var QUOTES = /* @__PURE__ */ new Set(['"', "'", "`"]);
var IDENTIFIER_CHAR = /[A-Za-z0-9_$.-]/u;
var UNQUOTED_VALUE = /^(?:Bearer\s+)?[^\s,;"'`)}\]]+/iu;
var CALL_EXPRESSION = /^(?:new\s+)?[A-Za-z_$][\w$.]*\(/u;
var KEYWORD = /^(?:null|undefined|true|false|none|nil|string|number|boolean|bigint|object|any|unknown|str|bytes|int|float|bool)$/iu;
var ENVIRONMENT_REFERENCE = /^(?:process\.env\b|os\.environ\b|os\.getenv\b|import\.meta\.env\b|Deno\.env\b|env\.|getenv\b|secrets\.)/u;
var QUOTED_PLACEHOLDER = /^(?:|\[[A-Z_]+(?::[^\]]*)?\]|<[^<>]*>|\{\{[^}]*\}\}|\*+|x{3,}|\.{3})$/iu;
var EBO_PLACEHOLDER_PREFIX = /^\[(?:REDACTED|LOCAL)_/u;
var CONSTANT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
var IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+(?:\(\))?$/u;
function normalizeFieldName(value) {
  return value.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
}
var SECRET_FIELDS = /* @__PURE__ */ new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authorization",
  "blobencryptionkey",
  "clientsecret",
  "connectionstring",
  "credential",
  "credentials",
  "credentialsjson",
  "databaseurl",
  "idtoken",
  "oauthtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "token"
]);
function isSecretFieldName(key) {
  return SECRET_FIELDS.has(normalizeFieldName(key));
}
function redactSecrets(text9, onFinding) {
  let output = text9;
  let redacted = 0;
  for (const { kind, pattern } of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (_match, prefix) => {
      redacted += 1;
      onFinding?.({ kind, disposition: "redacted" });
      return `${prefix}${SECRET_PLACEHOLDER}`;
    });
  }
  const assignments = scanAssignments(output);
  let rebuilt = "";
  let cursor = 0;
  for (const assignment of assignments) {
    onFinding?.(assignment.finding);
    if (assignment.finding.disposition !== "redacted") continue;
    for (const { start, end } of assignment.redactions) {
      rebuilt += `${output.slice(cursor, start)}${SECRET_PLACEHOLDER}`;
      cursor = end;
    }
    redacted += 1;
  }
  return { text: cursor === 0 ? output : rebuilt + output.slice(cursor), redacted };
}
function containsSecret(text9) {
  for (const { pattern } of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    const matched = pattern.test(text9);
    pattern.lastIndex = 0;
    if (matched) return true;
  }
  return scanAssignments(text9).some(({ finding }) => finding.disposition === "redacted");
}
function scanAssignments(text9) {
  const assignments = [];
  SECRET_NAME.lastIndex = 0;
  for (let match = SECRET_NAME.exec(text9); match !== null; match = SECRET_NAME.exec(text9)) {
    const name = identifierAround(text9, match.index, match.index + match[1].length);
    const shell = match[2] === "" && match[3] === "" && match[4] === "=" && match[5] === "";
    const start = match.index + match[0].length;
    const escaped = text9[start] === "\\" && QUOTES.has(text9[start + 1] ?? "");
    if (!escaped && (shell || /^[$%]/u.test(text9[start] ?? ""))) {
      const word = scanShellWord(text9, start, lineEnd(text9, start), "top");
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, word.end);
      const assignment = classifyWord(word, name, start);
      if (assignment !== void 0) assignments.push(assignment);
      continue;
    }
    const quote = text9[escaped ? start + 1 : start] ?? "";
    if (QUOTES.has(quote)) {
      const valueStart = start + (escaped ? 2 : 1);
      const close = escaped ? escapedClosingQuote(text9, valueStart, quote) : closingQuote(text9, valueStart, quote);
      const valueEnd = close === -1 ? lineEnd(text9, valueStart) : close;
      const value2 = text9.slice(valueStart, valueEnd);
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, valueEnd);
      if (!escaped && quote !== "'" && /[$%]/u.test(value2)) {
        const assignment = classifyWord(scanShellWord(text9, valueStart, valueEnd, "double"), name, valueStart);
        if (assignment !== void 0) assignments.push(assignment);
        continue;
      }
      const rest2 = escaped ? [] : expressionLiterals(text9, valueEnd + 1);
      SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, rest2.end ?? valueEnd);
      if (EBO_PLACEHOLDER_PREFIX.test(value2) && rest2.length === 0) continue;
      const own2 = EBO_PLACEHOLDER_PREFIX.test(value2) || QUOTED_PLACEHOLDER.test(value2) ? [] : [{ start: valueStart, end: valueEnd }];
      assignments.push(own2.length + rest2.length === 0 ? { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] } : { finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions: [...own2, ...rest2] });
      continue;
    }
    const raw = UNQUOTED_VALUE.exec(text9.slice(start, start + 4096))?.[0];
    if (raw === void 0) continue;
    const bearer = /^Bearer\s+/iu.exec(raw)?.[0] ?? "";
    const value = raw.slice(bearer.length);
    SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, start + raw.length);
    if (EBO_PLACEHOLDER_PREFIX.test(value)) continue;
    const reason = notSecretReason(value);
    const rest = expressionLiterals(text9, start + raw.length);
    SECRET_NAME.lastIndex = Math.max(SECRET_NAME.lastIndex, rest.end ?? start + raw.length);
    const own = reason === void 0 ? [{ start: start + bearer.length, end: start + raw.length }] : [];
    assignments.push(own.length + rest.length > 0 ? { finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions: [...own, ...rest] } : { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason }, redactions: [] });
  }
  SECRET_NAME.lastIndex = 0;
  return assignments;
}
function expressionLiterals(text9, from) {
  const literals = [];
  const opened = text9[from - 1] === "(" || text9[from - 1] === "[";
  let depth = opened ? 1 : 0;
  let index = from;
  const lookup = (opened ? /^\s*/u : /^\s*[[(]\s*/u).exec(text9.slice(from, from + 64));
  const keyAt = lookup === null ? -1 : from + lookup[0].length;
  for (; index < text9.length; index += 1) {
    const character = text9[index];
    if (character === "\n" || character === "\r") break;
    if (QUOTES.has(character)) {
      const close = closingQuote(text9, index + 1, character);
      const end = close === -1 ? lineEnd(text9, index + 1) : close;
      const content = text9.slice(index + 1, end);
      if (index !== keyAt && /[A-Za-z0-9]/u.test(content) && !EBO_PLACEHOLDER_PREFIX.test(content) && !QUOTED_PLACEHOLDER.test(content)) literals.push({ start: index + 1, end });
      index = end;
      continue;
    }
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      if (depth === 0) break;
      depth -= 1;
    } else if ((character === ";" || character === ",") && depth === 0) break;
  }
  literals.end = index;
  return literals;
}
function scanShellWord(text9, start, limit, mode) {
  const word = { source: text9, start, end: start, literals: [], references: 0, incomplete: false };
  word.end = scanWordPart(text9, start, limit, word, mode);
  return word;
}
function scanWordPart(text9, from, limit, word, mode) {
  let index = from;
  let literalStart = from;
  const quoted = mode === "double";
  const flush = (end) => {
    if (end > literalStart) word.literals.push({ start: literalStart, end, quoted });
  };
  while (index < limit) {
    const character = text9[index];
    if (mode === "top" && /[\s;&|<>()`]/u.test(character)) break;
    if (mode === "brace" && character === "}") break;
    if (mode === "double" && character === '"') break;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (!quoted && character === "'") {
      flush(index);
      const close = text9.indexOf("'", index + 1);
      const end = close === -1 || close >= limit ? limit : close;
      word.literals.push({ start: index + 1, end, quoted: true });
      if (end === limit) word.incomplete = true;
      index = end + 1;
      literalStart = index;
      continue;
    }
    if (!quoted && character === '"') {
      flush(index);
      const end = scanWordPart(text9, index + 1, limit, word, "double");
      if (end >= limit) word.incomplete = true;
      index = end + 1;
      literalStart = index;
      continue;
    }
    if (character === "%" || character === "$") {
      const rest = text9.slice(index, Math.min(limit, index + 256));
      const simple = character === "%" ? /^%[A-Za-z_][A-Za-z0-9_]*%/u.exec(rest) : /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/u.exec(rest);
      if (simple !== null) {
        flush(index);
        word.references += 1;
        index += simple[0].length;
        literalStart = index;
        continue;
      }
      const braced = /^\$\{[#!]?[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
      if (braced !== null) {
        flush(index);
        word.references += 1;
        let cursor = index + braced[0].length;
        const operator = /^:?[-=+?]/u.exec(text9.slice(cursor, cursor + 2))?.[0];
        if (operator !== void 0) cursor += operator.length;
        if (text9[cursor] !== "}") {
          const before = word.literals.length;
          cursor = scanWordPart(text9, cursor, limit, word, "brace");
          if (operator?.endsWith("?") === true) word.literals.length = before;
        }
        if (cursor >= limit || text9[cursor] !== "}") word.incomplete = true;
        index = cursor + 1;
        literalStart = index;
        continue;
      }
      if (rest.startsWith("$(")) {
        flush(index);
        let depth = 0;
        let cursor = index + 1;
        for (; cursor < limit; cursor += 1) {
          if (text9[cursor] === "(") depth += 1;
          else if (text9[cursor] === ")" && --depth === 0) break;
        }
        word.literals.push({ start: index + 2, end: Math.min(cursor, limit), quoted: false });
        if (cursor >= limit) word.incomplete = true;
        index = cursor + 1;
        literalStart = index;
        continue;
      }
    }
    index += 1;
  }
  flush(Math.min(index, limit));
  return Math.min(index, limit);
}
function classifyWord(word, name, valueStart) {
  if (word.end <= valueStart) return void 0;
  const redacted = (redactions) => ({ finding: { kind: "secret-assignment", disposition: "redacted", name }, redactions });
  if (word.incomplete) return redacted([{ start: word.start, end: word.end }]);
  const slice = ({ start, end }) => word.source.slice(start, end);
  const literals = word.literals.filter((literal) => /[A-Za-z0-9]/u.test(slice(literal)) && !EBO_PLACEHOLDER_PREFIX.test(slice(literal)));
  if (literals.length === 0) {
    if (word.references > 0) return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "environment-reference" }, redactions: [] };
    return word.literals.length > 0 ? void 0 : { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] };
  }
  const joined = literals.map(slice).join("");
  if (word.references === 0 && QUOTED_PLACEHOLDER.test(joined)) {
    return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "placeholder" }, redactions: [] };
  }
  if (word.references === 0 && literals.every(({ quoted }) => !quoted) && joined.length < 8) {
    return { finding: { kind: "secret-assignment", disposition: "not-secret", name, reason: "too-short" }, redactions: [] };
  }
  return redacted(literals.map(({ start, end }) => ({ start, end })));
}
function notSecretReason(value) {
  if (value === "" || QUOTED_PLACEHOLDER.test(value) || /^[[<{(`]/u.test(value)) return "placeholder";
  if (ENVIRONMENT_REFERENCE.test(value)) return "environment-reference";
  if (CONSTANT_NAME.test(value)) return "constant-name";
  if (IDENTIFIER_PATH.test(value)) return "identifier-path";
  if (CALL_EXPRESSION.test(value)) return "expression";
  if (KEYWORD.test(value)) return "keyword";
  return value.length < 8 ? "too-short" : void 0;
}
function identifierAround(text9, start, end) {
  let left = start;
  while (left > 0 && IDENTIFIER_CHAR.test(text9[left - 1])) left -= 1;
  return text9.slice(left, end).replace(/^[.-]+/u, "");
}
function closingQuote(text9, from, quote) {
  for (let index = from; index < text9.length; index += 1) {
    if (text9[index] === "\\") index += 1;
    else if (text9[index] === quote) return index;
    else if (text9[index] === "\n" || text9[index] === "\r") return -1;
  }
  return -1;
}
function escapedClosingQuote(text9, from, quote) {
  const end = lineEnd(text9, from);
  const index = text9.indexOf(`\\${quote}`, from);
  return index === -1 || index > end ? -1 : index;
}
function lineEnd(text9, from) {
  const index = text9.slice(from).search(/[\r\n]/u);
  return index === -1 ? text9.length : from + index;
}

// src/exports.ts
function sanitizeDerivedExport(value, policy, correlations = [], onFinding) {
  validatePolicy(policy);
  const sensitive = effectiveSensitiveValues(policy);
  const replacements = new Map(correlations.map((source) => [source, `ref-${createHash4("sha256").update(source).digest("hex").slice(0, 20)}`]));
  const bytes = sanitizeArtifact(
    Buffer.from(canonicalizeMetadata(value)),
    "application/json",
    policy,
    replacements,
    sensitive,
    [homedir(), userInfo().username],
    /* @__PURE__ */ new Map(),
    "session",
    /* @__PURE__ */ new Map(),
    onFinding
  );
  scanPortableTree([{ bytes, mediaType: "application/json" }], sensitive, correlations);
  return JSON.parse(bytes.toString("utf8"));
}
var MAX_SOURCE_ARTIFACT_BYTES = 64 * 1024 * 1024;
var HIDDEN_FIELDS = /* @__PURE__ */ new Set([
  "prompttokenids",
  "completiontokenids",
  "chainofthought",
  "extendedthinking",
  "hiddenreasoning",
  "encryptedreasoning",
  "encryptedthinking",
  "rawapibody",
  "rawrequestbody",
  "rawresponsebody",
  "reasoning",
  "reasoningcontent",
  "reasoningdetails",
  "reasoningsignature",
  "thinking",
  "thinkingcontent",
  "thinkingsignature",
  "textsignature",
  "thoughtsignature"
]);
var CODEX_REASONING_DELTA_METHOD = "item/reasoning/textDelta";
var DEVIN_THOUGHT_UPDATE = "agent_thought_chunk";
var CODEX_REASONING_CONTENT_FIELDS = /* @__PURE__ */ new Set(["content", "delta", "encryptedcontent", "summary", "text"]);
var CURSOR_REASONING_TYPES = /* @__PURE__ */ new Set(["thinking", "thinkingdelta", "thinkingcompleted", "thinkingmessage"]);
var PI_PRIVATE_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "thinking",
  "thinkingstart",
  "thinkingdelta",
  "thinkingend",
  "reasoning",
  "reasoningstart",
  "reasoningdelta",
  "reasoningend"
]);
var PI_PRIVATE_CONTENT_FIELDS = /* @__PURE__ */ new Set(["content", "delta", "encryptedcontent", "reasoning", "signature", "summary", "text", "thinking", "thinkingsignature"]);
var PI_PRIVATE_FIELDS = /* @__PURE__ */ new Set(["encryptedreasoning", "encryptedthinking", "reasoningcontent", "reasoningdetails", "reasoningsignature", "thinkingcontent", "thinkingsignature", "textsignature", "thoughtsignature"]);
var CORRELATION_FIELDS = /* @__PURE__ */ new Set(["attemptid", "bundleid", "id", "runid", "sessionid", "traceid", "eborunid", "eboattemptid"]);
var LOCAL_IDENTIFIER_FIELDS = /* @__PURE__ */ new Set(["login", "owner", "user", "username"]);
var TRUNCATABLE_FIELDS = /* @__PURE__ */ new Set([
  "exceptionmessage",
  "exceptiontraceback",
  "body",
  "commandoutput",
  "content",
  "diff",
  "filecontent",
  "input",
  "output",
  "patch",
  "prompt",
  "stderr",
  "stdout",
  "text",
  "toolinput",
  "toolresult"
]);
var LOCAL_IDENTIFIER_PATTERNS = [
  // Code embedded in strings often escapes its quotes: user=\"root\".
  /((?:user(?:name)?|owner|login)\s*[:=]\s*\\")(?!\[LOCAL_USER\]\\")(?:(?!\\")[^\r\n])*(\\")/giu,
  /((?:user(?:name)?|owner|login)\s*[:=]\s*\\')(?!\[LOCAL_USER\]\\')(?:(?!\\')[^\r\n])*(\\')/giu,
  /((?:user(?:name)?|owner|login)\s*[:=]\s*")(?!\[LOCAL_USER\]")(?:\\.|[^"\\])*(")/giu,
  /((?:user(?:name)?|owner|login)\s*[:=]\s*')(?!\[LOCAL_USER\]')(?:\\.|[^'\\])*(')/giu,
  /((?:user(?:name)?|owner|login)\s*[:=])(?!(?:\s*)\[LOCAL_USER\])\s*[^\s,"'}\]\\]+()/giu
];
var LOCAL_PATH = /(^|[\s"'=:(+\-])(?:[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*|\/(?!\/)[^\s"']+)/gu;
function sanitizeArtifact(bytes, mediaType, policy, replacements, sensitiveValues, localIdentifiers, counts, kind, portableDiagnostics = /* @__PURE__ */ new Map(), onFinding) {
  if (mediaType === "application/json") {
    increment(counts, "canonicalized");
    const output = Buffer.from(canonicalizeMetadata(sanitizeValue(
      kind === "verifier" ? rewriteVerifierDiagnosticReferences(parseJson3(bytes, "JSON evidence"), portableDiagnostics) : stripDevinRawTelemetryBodies(stripNativeReasoning(parseJson3(bytes, "JSON evidence"), kind, counts), kind, counts),
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      void 0,
      false,
      "",
      onFinding
    )));
    if (output.length > policy.maxArtifactBytes) throw new Error("Sanitized JSON evidence exceeds the configured artifact limit.");
    return output;
  }
  if (mediaType === "application/x-ndjson") {
    const lines = decode(bytes, "JSONL evidence").split(/\r?\n/gu).filter((line) => line.trim() !== "");
    if (lines.length === 0) throw new Error("JSONL evidence is empty.");
    increment(counts, "canonicalized", lines.length);
    const sanitized2 = lines.map((line) => canonicalizeMetadata(sanitizeValue(
      stripNativeReasoning(parseJson3(Buffer.from(line), "JSONL evidence record"), kind, counts),
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts
    )));
    const retained = [];
    for (const line of sanitized2) {
      if (Buffer.byteLength(`${[...retained, line].join("\n")}
`) > policy.maxArtifactBytes) break;
      retained.push(line);
    }
    if (retained.length === 0) throw new Error("Sanitized JSONL record exceeds the configured artifact limit.");
    if (retained.length !== sanitized2.length) increment(counts, "truncated", sanitized2.length - retained.length);
    return Buffer.from(`${retained.join("\n")}
`);
  }
  const sanitized = rewriteString(
    decode(bytes, "text evidence"),
    policy,
    replacements,
    sensitiveValues,
    localIdentifiers,
    counts,
    false,
    true,
    true
  );
  const bounded = truncateUtf8(sanitized, policy.maxArtifactBytes);
  if (bounded !== sanitized) increment(counts, "truncated");
  return Buffer.from(bounded);
}
function rewriteVerifierDiagnosticReferences(value, diagnostics) {
  if (diagnostics.size === 0 || !isRecord4(value) || !Array.isArray(value.diagnostics)) return value;
  const output = structuredClone(value);
  for (const diagnostic of output.diagnostics) {
    if (!isRecord4(diagnostic) || typeof diagnostic.locator !== "string") {
      throw new Error("Verifier diagnostic reference is invalid.");
    }
    const portable = diagnostics.get(diagnostic.locator);
    if (portable === void 0) throw new Error(`Verifier diagnostic ${diagnostic.locator} was not exported.`);
    diagnostic.locator = portable.artifact.relativePath;
    diagnostic.digest = portable.artifact.digest;
    diagnostic.sizeBytes = portable.artifact.sizeBytes;
    diagnostic.truncated = portable.truncated;
    delete diagnostic.source;
  }
  return output;
}
function sanitizeValue(value, policy, replacements, sensitiveValues, localIdentifiers, counts, fieldName, truncatable = false, path = "", onFinding) {
  const normalizedField = fieldName === void 0 ? void 0 : normalizeFieldName(fieldName);
  if (typeof value === "string") {
    return rewriteString(
      value,
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      normalizedField !== void 0 && CORRELATION_FIELDS.has(normalizedField),
      truncatable,
      true,
      normalizedField !== void 0 && LOCAL_IDENTIFIER_FIELDS.has(normalizedField),
      onFinding === void 0 ? void 0 : (finding) => onFinding({ ...finding, path })
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(
      entry,
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      fieldName,
      truncatable,
      `${path}/${String(index)}`,
      onFinding
    ));
  }
  if (!isRecord4(value)) return value;
  const attributeName = otlpAttributeName(value);
  if (attributeName !== void 0 && isSecretFieldName(attributeName)) {
    increment(counts, "redacted-secret");
    onFinding?.({ kind: "secret-field", disposition: "redacted", name: attributeName, path: `${path}/value` });
    return { ...value, value: REDACTED_ANY_VALUE };
  }
  const sourceFieldCount = Object.keys(value).length;
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (HIDDEN_FIELDS.has(normalizeFieldName(key))) {
      increment(counts, "removed-field");
      continue;
    }
    if (isSecretFieldName(key)) {
      output[key] = SECRET_PLACEHOLDER;
      increment(counts, "redacted-secret");
      onFinding?.({ kind: "secret-field", disposition: "redacted", name: key, path: `${path}/${pointerToken(key)}` });
      continue;
    }
    output[key] = sanitizeValue(
      entry,
      policy,
      replacements,
      sensitiveValues,
      localIdentifiers,
      counts,
      key,
      truncatable || TRUNCATABLE_FIELDS.has(normalizeFieldName(key)),
      `${path}/${pointerToken(key)}`,
      onFinding
    );
  }
  if (sourceFieldCount > 0 && Object.keys(output).length === 0) {
    throw new Error("Sanitization removed every field from an evidence record.");
  }
  return output;
}
function stripCodexReasoning(value, kind, counts) {
  if (kind !== "session") return value;
  if (Array.isArray(value)) return value.map((entry) => stripCodexReasoning(entry, kind, counts));
  if (!isRecord4(value)) return value;
  const reasoningItem = value.type === "reasoning" || value.channel === "analysis";
  const reasoningDelta = value.method === CODEX_REASONING_DELTA_METHOD;
  const cursorReasoning = typeof value.type === "string" && CURSOR_REASONING_TYPES.has(normalizeFieldName(value.type));
  const cursorCheckpoint = typeof value.agentId === "string" && typeof value.blobId === "string" && typeof value.dataBase64 === "string";
  const payloadContainsReasoning = containsCodexReasoning(value.payload);
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (reasoningItem && key !== "type" && key !== "id") {
      increment(counts, "removed-field");
      continue;
    }
    if (cursorReasoning && (CODEX_REASONING_CONTENT_FIELDS.has(normalized) || normalized === "thinkingdurationms" || normalized === "message")) {
      increment(counts, "removed-field");
      continue;
    }
    if (cursorCheckpoint && normalized === "database64") {
      increment(counts, "removed-field");
      continue;
    }
    if (key === "raw" && (reasoningDelta || payloadContainsReasoning || rawContainsCodexReasoning(entry))) {
      increment(counts, "removed-field");
      continue;
    }
    if (reasoningDelta && CODEX_REASONING_CONTENT_FIELDS.has(normalized)) {
      increment(counts, "removed-field");
      continue;
    }
    if (reasoningDelta && (key === "params" || key === "payload")) {
      output[key] = stripCodexReasoningEnvelope(entry, kind, counts);
      continue;
    }
    output[key] = stripCodexReasoning(entry, kind, counts);
  }
  return output;
}
function visibleEvidence(value) {
  return stripNativeReasoning(value, "session", /* @__PURE__ */ new Map());
}
function stripNativeReasoning(value, kind, counts) {
  return stripFactoryReasoning(stripDevinReasoning(stripPiReasoning(stripCodexReasoning(value, kind, counts), kind, counts), kind, counts), counts);
}
var FACTORY_THINKING_TYPES = /* @__PURE__ */ new Set(["thinkingtextdelta", "thinkingtextcomplete", "thinking", "redactedthinking"]);
var FACTORY_PRIVATE_FIELDS = /* @__PURE__ */ new Set([
  "signature",
  "thoughtsignature",
  "geminithoughtsignature",
  "openaiencryptedcontent",
  "openaireasoningid",
  "openaireasoningsummary",
  "chatcompletionreasoningcontent",
  "chatcompletionreasoningfield"
]);
function stripFactoryReasoning(value, counts, factory = false) {
  if (Array.isArray(value)) return value.map((entry) => stripFactoryReasoning(entry, counts, factory));
  if (!isRecord4(value)) return value;
  factory ||= value.source === "factory-droid" || value.source === "ebo-factory-client" || value.schemaVersion === "ebo.factory-runtime/v1";
  const privateBlock = typeof value.type === "string" && FACTORY_THINKING_TYPES.has(normalizeFieldName(value.type));
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (privateBlock && !["type", "messageId", "blockIndex", "id"].includes(key) || FACTORY_PRIVATE_FIELDS.has(normalized) && (normalized !== "signature" || factory || privateBlock) || key === "raw" && (factory || typeof entry === "string" && rawContainsFactoryReasoning(entry))) {
      increment(counts, "removed-field");
      continue;
    }
    output[key] = stripFactoryReasoning(entry, counts, factory);
  }
  return output;
}
function rawContainsFactoryReasoning(raw) {
  try {
    return valueContainsFactoryReasoning(JSON.parse(raw));
  } catch {
    return /thinking[_-]?text|openaiEncryptedContent|chatCompletionReasoningContent/iu.test(raw);
  }
}
function valueContainsFactoryReasoning(value, factory = false) {
  if (Array.isArray(value)) return value.some((entry) => valueContainsFactoryReasoning(entry, factory));
  if (!isRecord4(value)) return false;
  factory ||= value.source === "factory-droid" || value.source === "ebo-factory-client" || value.schemaVersion === "ebo.factory-runtime/v1";
  const privateBlock = typeof value.type === "string" && FACTORY_THINKING_TYPES.has(normalizeFieldName(value.type));
  return Object.entries(value).some(([key, entry]) => privateBlock && !["type", "messageId", "blockIndex", "id"].includes(key) || FACTORY_PRIVATE_FIELDS.has(normalizeFieldName(key)) && (normalizeFieldName(key) !== "signature" || factory || privateBlock) || key === "raw" && (factory || typeof entry === "string" && rawContainsFactoryReasoning(entry)) || valueContainsFactoryReasoning(entry, factory));
}
function containsFactoryReasoningContent(text9, mediaType) {
  if (mediaType === "application/json") return valueContainsFactoryReasoning(parseJson3(Buffer.from(text9), "Factory reasoning scan"));
  if (mediaType === "application/x-ndjson") return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsFactoryReasoning(parseJson3(Buffer.from(line), "Factory reasoning scan")));
  return false;
}
var DEVIN_TELEMETRY_SCHEMA = "ebo.devin-telemetry/v1";
function stripDevinRawTelemetryBodies(value, kind, counts) {
  if (kind !== "telemetry" || !isRecord4(value) || value.schemaVersion !== DEVIN_TELEMETRY_SCHEMA) return value;
  const telemetry = value.telemetry;
  if (!isRecord4(telemetry) || !Array.isArray(telemetry.records)) return value;
  const records = telemetry.records.map((record3) => {
    if (!isRecord4(record3) || !("body" in record3)) return record3;
    const { body: _body, ...rest } = record3;
    increment(counts, "removed-field");
    return rest;
  });
  return { ...value, telemetry: { ...telemetry, records } };
}
function stripDevinReasoning(value, kind, counts) {
  if (kind !== "session") return value;
  if (Array.isArray(value)) return value.map((entry) => stripDevinReasoning(entry, kind, counts));
  if (!isRecord4(value)) return value;
  const thought = value.sessionUpdate === DEVIN_THOUGHT_UPDATE;
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (thought && key === "content") {
      increment(counts, "removed-field");
      continue;
    }
    if (key === "raw" && typeof entry === "string" && rawContainsDevinReasoning(entry)) {
      increment(counts, "removed-field");
      continue;
    }
    output[key] = stripDevinReasoning(entry, kind, counts);
  }
  return output;
}
function containsDevinReasoning(value) {
  if (Array.isArray(value)) return value.some(containsDevinReasoning);
  if (!isRecord4(value)) return false;
  return value.sessionUpdate === DEVIN_THOUGHT_UPDATE || Object.values(value).some(containsDevinReasoning);
}
function rawContainsDevinReasoning(value) {
  try {
    return containsDevinReasoning(JSON.parse(value));
  } catch {
    return false;
  }
}
function stripPiReasoning(value, kind, counts) {
  if (kind !== "session") return value;
  if (Array.isArray(value)) return value.map((entry) => stripPiReasoning(entry, kind, counts));
  if (!isRecord4(value)) return value;
  const privateContent = value.thought === true || typeof value.type === "string" && PI_PRIVATE_CONTENT_TYPES.has(normalizeFieldName(value.type));
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (HIDDEN_FIELDS.has(normalized) || PI_PRIVATE_FIELDS.has(normalized) || privateContent && PI_PRIVATE_CONTENT_FIELDS.has(normalized)) {
      increment(counts, "removed-field");
      continue;
    }
    output[key] = stripPiReasoning(entry, kind, counts);
  }
  return output;
}
function stripCodexReasoningEnvelope(value, kind, counts) {
  if (Array.isArray(value)) return value.map((entry) => stripCodexReasoningEnvelope(entry, kind, counts));
  if (!isRecord4(value)) return value;
  const output = /* @__PURE__ */ Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (CODEX_REASONING_CONTENT_FIELDS.has(normalizeFieldName(key))) {
      increment(counts, "removed-field");
      continue;
    }
    output[key] = stripCodexReasoning(entry, kind, counts);
  }
  return output;
}
function containsCodexReasoning(value) {
  if (Array.isArray(value)) return value.some(containsCodexReasoning);
  if (!isRecord4(value)) return false;
  return value.type === "reasoning" || value.channel === "analysis" || value.method === CODEX_REASONING_DELTA_METHOD || Object.values(value).some(containsCodexReasoning);
}
function rawContainsCodexReasoning(value) {
  if (typeof value !== "string") return false;
  try {
    return containsCodexReasoning(JSON.parse(value));
  } catch {
    return false;
  }
}
function rewriteString(input, policy, replacements, sensitiveValues, localIdentifiers, counts, rewriteCorrelation, truncateContent, rewriteTextCorrelations = false, rewriteLocalIdentifier = false, onFinding) {
  let output = input;
  for (const secret of sensitiveValues) {
    const occurrences = countOccurrences(output, secret);
    if (occurrences > 0) {
      output = output.replaceAll(secret, "[REDACTED_SECRET]");
      increment(counts, "redacted-secret", occurrences);
    }
  }
  const correlation = rewriteCorrelation ? replacements.get(output) : void 0;
  if (correlation !== void 0) {
    output = correlation;
    increment(counts, "rewritten-correlation");
  }
  if (rewriteTextCorrelations) {
    for (const [source, replacement] of replacements) {
      if (source.length < 8) continue;
      const occurrences = countOccurrences(output, source);
      if (occurrences > 0) {
        output = output.replaceAll(source, replacement);
        increment(counts, "rewritten-correlation", occurrences);
      }
    }
  }
  const secrets = redactSecrets(output, onFinding);
  output = secrets.text;
  if (secrets.redacted > 0) increment(counts, "redacted-secret", secrets.redacted);
  output = output.replace(LOCAL_PATH, (_match, prefix) => {
    increment(counts, "redacted-local-identifier");
    return `${typeof prefix === "string" ? prefix : ""}[LOCAL_PATH]`;
  });
  for (const pattern of LOCAL_IDENTIFIER_PATTERNS) {
    output = output.replace(pattern, (_match, prefix, suffix) => {
      increment(counts, "redacted-local-identifier");
      return `${typeof prefix === "string" ? prefix : ""}[LOCAL_USER]${typeof suffix === "string" ? suffix : ""}`;
    });
  }
  if (rewriteLocalIdentifier) {
    for (const identifier of localIdentifiers.filter((value) => value !== homedir())) {
      if (output === identifier) {
        output = "[LOCAL_USER]";
        increment(counts, "redacted-local-identifier");
      }
    }
  }
  if (!truncateContent) return output;
  const bounded = truncateUtf8(output, policy.maxStringBytes);
  if (bounded !== output) increment(counts, "truncated");
  return bounded;
}
function scanPortableTree(buffers, sensitiveValues, sourceCorrelations) {
  for (const [index, { bytes, mediaType }] of buffers.entries()) {
    const text9 = decode(bytes, "portable export");
    const failure = [
      ["known sensitive value", sensitiveValues.some((value) => text9.includes(value))],
      ["secret pattern", containsPortableSecretPattern(text9, mediaType)],
      ["absolute path", containsLocalPath(text9, mediaType)],
      ["local identifier", containsLocalIdentifier(text9, mediaType)],
      ["source correlation", sourceCorrelations.filter((value) => value.length >= 8).some((value) => text9.includes(value))],
      ["hidden content field", /"(?:chain[_-]?of[_-]?thought|extended[_-]?thinking|hidden[_-]?reasoning|encrypted[_-]?(?:reasoning|thinking)|reasoning(?:[_-]?(?:content|details|signature))?|thinking(?:[_-]?(?:content|signature))?|text[_-]?signature|thought[_-]?signature|raw[_-]?(?:api|request|response)[_-]?body)"\s*:/iu.test(text9)],
      ["Codex reasoning content", containsCodexReasoningContent(text9, mediaType)],
      ["Pi private reasoning content", containsPiReasoningContent(text9, mediaType)],
      ["Devin thought content", containsDevinReasoningContent(text9, mediaType)],
      ["Factory private reasoning content", containsFactoryReasoningContent(text9, mediaType)]
    ].find(([, matched]) => matched);
    if (failure !== void 0) {
      resetPatterns();
      throw new Error(`Portable export buffer ${index} failed the final secret scan: ${String(failure[0])}.`);
    }
    resetPatterns();
  }
}
function containsPiReasoningContent(text9, mediaType) {
  if (mediaType === "application/json") return valueContainsPiReasoningContent(parseJson3(Buffer.from(text9), "Portable JSON Pi reasoning scan"));
  if (mediaType === "application/x-ndjson") return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsPiReasoningContent(parseJson3(Buffer.from(line), "Portable JSONL Pi reasoning scan")));
  return false;
}
function valueContainsPiReasoningContent(value) {
  if (Array.isArray(value)) return value.some(valueContainsPiReasoningContent);
  if (!isRecord4(value)) return false;
  if (Object.keys(value).some((key) => PI_PRIVATE_FIELDS.has(normalizeFieldName(key)))) return true;
  if ((value.thought === true || typeof value.type === "string" && PI_PRIVATE_CONTENT_TYPES.has(normalizeFieldName(value.type))) && Object.keys(value).some((key) => PI_PRIVATE_CONTENT_FIELDS.has(normalizeFieldName(key)))) return true;
  return Object.values(value).some(valueContainsPiReasoningContent);
}
function containsCodexReasoningContent(text9, mediaType) {
  if (mediaType === "application/json") {
    return valueContainsCodexReasoningContent(parseJson3(Buffer.from(text9), "Portable JSON reasoning scan"));
  }
  if (mediaType === "application/x-ndjson") {
    return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsCodexReasoningContent(parseJson3(Buffer.from(line), "Portable JSONL reasoning scan")));
  }
  return false;
}
function containsDevinReasoningContent(text9, mediaType) {
  if (mediaType === "application/json") return valueContainsDevinReasoningContent(parseJson3(Buffer.from(text9), "Portable JSON Devin reasoning scan"));
  if (mediaType === "application/x-ndjson") return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsDevinReasoningContent(parseJson3(Buffer.from(line), "Portable JSONL Devin reasoning scan")));
  return false;
}
function valueContainsDevinReasoningContent(value) {
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return valueContainsDevinReasoningContent(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(valueContainsDevinReasoningContent);
  if (!isRecord4(value)) return false;
  if (value.sessionUpdate === DEVIN_THOUGHT_UPDATE && "content" in value) return true;
  return Object.values(value).some(valueContainsDevinReasoningContent);
}
function valueContainsCodexReasoningContent(value) {
  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
    try {
      return valueContainsCodexReasoningContent(JSON.parse(trimmed));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(valueContainsCodexReasoningContent);
  if (!isRecord4(value)) return false;
  if ((value.type === "reasoning" || value.channel === "analysis") && Object.keys(value).some((key) => CODEX_REASONING_CONTENT_FIELDS.has(normalizeFieldName(key)))) return true;
  if (value.method === CODEX_REASONING_DELTA_METHOD) {
    for (const container of [value.params, value.payload]) {
      if (isRecord4(container) && Object.keys(container).some((key) => CODEX_REASONING_CONTENT_FIELDS.has(normalizeFieldName(key)))) return true;
    }
  }
  return Object.values(value).some(valueContainsCodexReasoningContent);
}
function containsPortableSecretPattern(text9, mediaType) {
  if (mediaType === "application/json") {
    return valueContainsSecretPattern(parseJson3(Buffer.from(text9), "Portable JSON final scan"));
  }
  if (mediaType === "application/x-ndjson") {
    return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsSecretPattern(parseJson3(Buffer.from(line), "Portable JSONL final scan")));
  }
  return stringContainsSecretPattern(text9);
}
function otlpAttributeName(value) {
  return typeof value.key === "string" && "value" in value ? value.key : void 0;
}
var REDACTED_ANY_VALUE = Object.freeze({ stringValue: SECRET_PLACEHOLDER });
function isRedactedAnyValue(value) {
  return value === SECRET_PLACEHOLDER || isRecord4(value) && Object.keys(value).length === 1 && value.stringValue === SECRET_PLACEHOLDER;
}
function valueContainsSecretPattern(value) {
  if (typeof value === "string") return stringContainsSecretPattern(value);
  if (Array.isArray(value)) return value.some(valueContainsSecretPattern);
  if (!isRecord4(value)) return false;
  const attributeName = otlpAttributeName(value);
  if (attributeName !== void 0 && isSecretFieldName(attributeName) && !isRedactedAnyValue(value.value)) return true;
  return Object.entries(value).some(([key, entry]) => isSecretFieldName(key) && entry !== SECRET_PLACEHOLDER || stringContainsSecretPattern(key) || valueContainsSecretPattern(entry));
}
function stringContainsSecretPattern(value) {
  return containsSecret(value);
}
function containsLocalIdentifier(text9, mediaType) {
  if (mediaType === "application/json") {
    return valueContainsLocalIdentifier(parseJson3(Buffer.from(text9), "Portable JSON final scan"));
  }
  if (mediaType === "application/x-ndjson") {
    return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsLocalIdentifier(parseJson3(Buffer.from(line), "Portable JSONL final scan")));
  }
  return stringContainsLocalIdentifier(text9);
}
function valueContainsLocalIdentifier(value) {
  if (typeof value === "string") return stringContainsLocalIdentifier(value);
  if (Array.isArray(value)) return value.some(valueContainsLocalIdentifier);
  if (!isRecord4(value)) return false;
  return Object.entries(value).some(([key, entry]) => stringContainsLocalIdentifier(key) || valueContainsLocalIdentifier(entry));
}
function stringContainsLocalIdentifier(value) {
  const matched = LOCAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value));
  for (const pattern of LOCAL_IDENTIFIER_PATTERNS) pattern.lastIndex = 0;
  return matched;
}
function containsLocalPath(text9, mediaType) {
  if (mediaType === "application/json") {
    return valueContainsLocalPath(parseJson3(Buffer.from(text9), "Portable JSON final scan"));
  }
  if (mediaType === "application/x-ndjson") {
    return text9.split(/\r?\n/gu).filter(Boolean).some((line) => valueContainsLocalPath(parseJson3(Buffer.from(line), "Portable JSONL final scan")));
  }
  return stringContainsLocalPath(text9);
}
function valueContainsLocalPath(value) {
  if (typeof value === "string") return stringContainsLocalPath(value);
  if (Array.isArray(value)) return value.some(valueContainsLocalPath);
  if (!isRecord4(value)) return false;
  return Object.entries(value).some(([key, entry]) => stringContainsLocalPath(key) || valueContainsLocalPath(entry));
}
function stringContainsLocalPath(value) {
  const matched = LOCAL_PATH.test(value);
  LOCAL_PATH.lastIndex = 0;
  return matched;
}
function parseJson3(bytes, label) {
  const text9 = decode(bytes, label);
  assertNoDuplicateJsonKeys(text9);
  try {
    return JSON.parse(text9);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${errorMessage2(error)}`);
  }
}
function effectiveSensitiveValues(policy) {
  return [.../* @__PURE__ */ new Set([...(policy.sensitiveValues ?? []).filter((value) => value !== ""), ...environmentSensitiveValues()])].sort((left, right) => right.length - left.length);
}
function environmentSensitiveValues(env = process.env) {
  return [...new Set(Object.entries(env).filter(([key, value]) => value !== void 0 && value.length >= 8 && !["logname", "user", "username"].includes(normalizeFieldName(key))).map(([, value]) => value))].sort((left, right) => right.length - left.length);
}
function validatePolicy(policy) {
  if (!["partner", "public"].includes(policy.sharingClass)) throw new Error("Portable export sharing class is invalid.");
  for (const [name, value] of [["artifact", policy.maxArtifactBytes], ["string", policy.maxStringBytes]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Portable export ${name} limit must be a positive safe integer.`);
  }
  if (policy.maxStringBytes > policy.maxArtifactBytes) throw new Error("Portable export string limit cannot exceed the artifact limit.");
}
function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}
function countOccurrences(value, search) {
  if (search === "") return 0;
  let count2 = 0;
  for (let index = value.indexOf(search); index !== -1; index = value.indexOf(search, index + search.length)) count2 += 1;
  return count2;
}
function increment(counts, action, count2 = 1) {
  counts.set(action, (counts.get(action) ?? 0) + count2);
}
function decode(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}
function pointerToken(key) {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
function resetPatterns() {
  LOCAL_PATH.lastIndex = 0;
  for (const pattern of LOCAL_IDENTIFIER_PATTERNS) pattern.lastIndex = 0;
}
function errorMessage2(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/evidence-projection.ts
function evidenceWorkspaces(value) {
  const found = /* @__PURE__ */ new Set();
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (["cwd", "workdir", "workingDirectory", "working_directory", "workspaceCwd"].includes(key) && typeof child === "string") found.add(child);
      visit(child);
    }
  };
  visit(visibleEvidence(value));
  return [...found].sort();
}

// src/behavior-assertions.ts
init_artifacts();
var DEFAULT_BEHAVIOR_VOCABULARY = loadDefaultVocabulary();
async function validateBehaviorAssertion(assertion, dataset, resolver, vocabulary = DEFAULT_BEHAVIOR_VOCABULARY, capture) {
  assertValid("behavior assertion", assertion);
  assertVocabulary(vocabulary);
  await validateNormalizedDataset(dataset, resolver);
  const datasetDigest = digest2(dataset);
  if (assertion.dataset.schemaVersion !== dataset.schemaVersion || assertion.dataset.digest !== datasetDigest) {
    throw new Error("Behavior assertion normalized dataset version or digest does not match.");
  }
  if (assertion.runId !== dataset.runId || assertion.attemptId !== dataset.attemptId) {
    throw new Error("Behavior assertion belongs to the wrong run or attempt.");
  }
  if (assertion.behavior.vocabularyVersion !== vocabulary.version) {
    throw new Error("Behavior assertion uses the wrong vocabulary version.");
  }
  const category = vocabulary.categories.find(({ id }) => id === assertion.behavior.categoryId);
  if (category === void 0 || !category.dimensions.some(({ id }) => id === assertion.behavior.dimensionId)) {
    throw new Error("Behavior assertion does not identify one declared behavior dimension.");
  }
  const eventIds = /* @__PURE__ */ new Set();
  const events = new Map(dataset.events.map((event) => [event.id, event]));
  const records = new Map(dataset.nativeRecords.map((record3) => [referenceKey4(record3.reference), record3]));
  const resolved = [];
  for (const citation of assertion.judgment.citations) {
    if (eventIds.has(citation.eventId)) throw new Error(`Behavior assertion cites event "${citation.eventId}" more than once.`);
    eventIds.add(citation.eventId);
    const event = events.get(citation.eventId);
    if (event === void 0) throw new Error(`Behavior assertion cites unknown normalized event "${citation.eventId}".`);
    if (referenceKey4(citation.nativeReference) !== referenceKey4(event.source.nativeReference)) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" does not match its native source.`);
    }
    const nativeRecord = records.get(referenceKey4(citation.nativeReference));
    if (nativeRecord === void 0) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" has no captured native record.`);
    }
    const resolution = await resolver.resolve(citation.nativeReference);
    if (typeof resolution !== "object" || resolution.runId !== dataset.runId || resolution.attemptId !== dataset.attemptId || resolution.digest !== nativeRecord.digest) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" is stale or belongs to another attempt.`);
    }
    resolved.push({ ...structuredClone(citation), resolution });
  }
  validateClaimCitations(assertion);
  validateClaimWorkspaces(assertion, capture);
  return resolved;
}
function validateClaimWorkspaces(assertion, capture) {
  for (const claim of assertion.judgment.claims ?? []) {
    if (claim.workspace === null) continue;
    if (capture === void 0) throw new Error("Validating a claim workspace needs the native capture.");
    const scopes = claim.citations.flatMap(({ nativeReference }) => {
      const native = capture.records.find(({ reference }) => reference.artifactId === nativeReference.artifactId && reference.recordLocator === nativeReference.recordLocator);
      return native === void 0 ? [] : evidenceWorkspaces(native.record);
    });
    if (!scopes.includes(claim.workspace) || scopes.some((scope) => scope !== claim.workspace)) {
      throw new Error(`Claim "${claim.id}" names a workspace its cited records do not state unambiguously; use null for unknown scope.`);
    }
  }
}
function validateClaimCitations(assertion) {
  const seen = /* @__PURE__ */ new Set();
  const citations2 = new Set(assertion.judgment.citations.map((citation) => canonicalizeMetadata(citation)));
  for (const claim of assertion.judgment.claims ?? []) {
    if (seen.has(claim.id)) throw new Error("Claim ids must be unique.");
    seen.add(claim.id);
    const own = claim.citations.map((citation) => canonicalizeMetadata(citation));
    if (new Set(own).size !== own.length || own.some((citation) => !citations2.has(citation))) {
      throw new Error(`Claim "${claim.id}" citations must be unique and among the assertion's citations.`);
    }
  }
}
function validateBehaviorReview(assertion, review) {
  assertValid("behavior assertion", assertion);
  assertValid("behavior review", review);
  if (review.assertion.id !== assertion.id || review.assertion.schemaVersion !== assertion.schemaVersion || review.assertion.digest !== digest2(assertion)) {
    throw new Error("Behavior review assertion identity or digest does not match.");
  }
}
async function createAgentSdkBehaviorEvidence(bundleRoot) {
  const capture = await readQualifiedClaudeAgentSdkCapture(bundleRoot);
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: normalization.capabilityProfile,
    adapterVersion: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
    nativeType: agentSdkNativeType,
    contentDigest: (reference) => agentSdkContentDigest(capture, reference)
  });
  const resolver = createAgentSdkNativeEvidenceResolver(capture);
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, dataset, resolver, coverage };
}
async function validateRetainedBehaviorAssertion(bundleRoot, assertion, review) {
  const { dataset, resolver, capture } = await createRetainedBehaviorEvidence(bundleRoot);
  const citations2 = await validateBehaviorAssertion(assertion, dataset, resolver, void 0, capture);
  if (review !== void 0) validateBehaviorReview(assertion, review);
  return citations2;
}
function assertVocabulary(vocabulary) {
  assertValid("behavior vocabulary", vocabulary);
  const categoryIds = vocabulary.categories.map(({ id }) => id);
  if (new Set(categoryIds).size !== categoryIds.length) throw new Error("Behavior vocabulary category IDs must be unique.");
  for (const category of vocabulary.categories) {
    const dimensionIds = category.dimensions.map(({ id }) => id);
    if (new Set(dimensionIds).size !== dimensionIds.length) {
      throw new Error(`Behavior vocabulary dimension IDs in category "${category.id}" must be unique.`);
    }
  }
}
function loadDefaultVocabulary() {
  const vocabulary = JSON.parse(readFileSync2(
    new URL("../../ontology/behavior-categories.v1.json", import.meta.url),
    "utf8"
  ));
  assertVocabulary(vocabulary);
  return vocabulary;
}
function digest2(value) {
  return `sha256:${digestMetadata(value).value}`;
}
function referenceKey4(reference) {
  return canonicalizeMetadata(reference);
}
function assertValid(label, value) {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}
function agentSdkNativeType(record3) {
  const document = asRecord2(record3.document);
  if (record3.kind === "session") return text3(document?.nativeType) ?? "session";
  if (record3.kind === "hook") return text3(document?.hook) ?? "hook";
  return {
    telemetry: "agent-sdk-telemetry",
    workspace: "workspace-outcome",
    verifier: "verifier-result",
    "assessment-mode": "assessment-mode",
    manifest: "terminal-record"
  }[record3.kind] ?? record3.kind;
}
function agentSdkContentDigest(capture, reference) {
  for (const { record: record3 } of capture.records) {
    if (record3.kind !== "workspace" && record3.kind !== "diagnostic") continue;
    const descriptor = asRecord2(record3.document);
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest;
  }
  return void 0;
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function text3(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}

// src/codex.ts
init_artifacts();
var CODEX_APP_SERVER_VERSION = "0.162.1";
var RETAINED_CODEX_APP_SERVER_VERSIONS = [CODEX_APP_SERVER_VERSION, "0.157.0", "0.153.4", "0.150.1"];
var CODEX_ADAPTER_VERSION = "0.1.0";
var CODEX_HARNESS = "codex-app-server";
var CODEX_0_150_1_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "ebo-codex-app-server-v0.150.1",
  harness: CODEX_HARNESS,
  nativeTypes: [
    "item/completed",
    "turn/completed",
    "turn/plan/updated",
    "thread/compacted",
    "thread/tokenUsage/updated",
    "model/rerouted",
    "hook/completed",
    "server-request"
  ],
  families: {
    message: { status: "partial", detail: "Completed user and agent message items are projected." },
    "model-request": { status: "unsupported", detail: "Inference requests are not inferred from turns or model changes." },
    tool: { status: "partial", detail: "Only completed native tool items are projected; deltas stay native." },
    context: { status: "partial", detail: "Plans and compaction are projected when emitted." },
    permission: { status: "partial", detail: "Server requests and unattended decisions stay native; request events are projected." },
    delegation: { status: "partial", detail: "Completed exposed collaboration items are projected when present." },
    artifact: { status: "partial", detail: "Completed file-change items are projected." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Codex native normalizer." },
    runtime: { status: "partial", detail: "Usage, reroutes, and completed hooks are projected when emitted." },
    outcome: { status: "available", detail: "Matching turn/completed is authoritative for turn outcome." }
  },
  evidence: {
    nativeOrder: { status: "available", detail: "The retained receive/write sequence is one stdio ordering domain." },
    nativeTime: { status: "partial", detail: "Item lifecycle timestamps are native; other records use EBO observation time, labeled by nativeTimeSource." },
    parentage: { status: "partial", detail: "Thread and turn scopes are retained; item relations remain source-specific." },
    content: { status: "partial", detail: "Mapped content references retained native payloads without copying bodies." }
  }
};
var CODEX_0_153_4_CAPABILITIES = {
  ...CODEX_0_150_1_CAPABILITIES,
  adapterId: "ebo-codex-app-server-v0.153.4"
};
var CODEX_0_157_0_CAPABILITIES = {
  ...CODEX_0_153_4_CAPABILITIES,
  adapterId: "ebo-codex-app-server-v0.157.0"
};
var CODEX_APP_SERVER_CAPABILITIES = {
  ...CODEX_0_153_4_CAPABILITIES,
  adapterId: `ebo-codex-app-server-v${CODEX_APP_SERVER_VERSION}`
};
async function normalizeCodexCapture(capture) {
  const events = [];
  const mapped = /* @__PURE__ */ new Set();
  for (const captured of capture.records) {
    const event = mapCodexRecord(capture, captured);
    if (event === void 0) continue;
    events.push(event, ...requestUsage(event, captured.record));
    mapped.add(captured.record.sequence);
  }
  await validateUniformEvents(events, {
    resolve: (reference) => resolvesCaptureReference(capture, reference)
  });
  return {
    events,
    unmapped: capture.records.filter(({ record: record3 }) => !mapped.has(record3.sequence)).map(({ reference }) => ({ reference, reason: "native record has no supported uniform mapping" }))
  };
}
async function describeAndValidateCodexDataset(capture, runtimeVersion = capture.telemetry?.runtime?.version ?? CODEX_APP_SERVER_VERSION) {
  if (!RETAINED_CODEX_APP_SERVER_VERSIONS.includes(runtimeVersion)) throw new Error(`Unsupported retained Codex runtime ${runtimeVersion}.`);
  const normalization = await normalizeCodexCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: runtimeVersion === "0.150.1" ? CODEX_0_150_1_CAPABILITIES : runtimeVersion === "0.153.4" ? CODEX_0_153_4_CAPABILITIES : runtimeVersion === "0.157.0" ? CODEX_0_157_0_CAPABILITIES : CODEX_APP_SERVER_CAPABILITIES,
    adapterVersion: CODEX_ADAPTER_VERSION,
    nativeType: codexNativeType
  });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}
function mapCodexRecord(capture, captured) {
  const record3 = captured.record;
  const method = record3.method;
  if (method === void 0) return void 0;
  const payload = isRecord5(record3.payload) ? record3.payload : {};
  let family;
  let actor = "harness";
  let phase = "instant";
  let scope = { kind: "attempt", id: capture.attemptId };
  let contentPath;
  if (record3.kind === "request" && record3.source === CODEX_HARNESS && isPermissionRequest(method) && matchesOwnedScope(capture, payload)) {
    family = "permission";
    actor = "harness";
    phase = "before";
    scope = scopedTurn(payload);
  } else if (record3.kind !== "notification" || record3.source !== CODEX_HARNESS) return void 0;
  else if (method === "item/completed") {
    if (!matchesOwnedScope(capture, payload)) return void 0;
    const item = isRecord5(payload.item) ? payload.item : {};
    const type = text4(item.type);
    family = itemFamily(type);
    if (family === void 0) return void 0;
    actor = family === "message" && type === "userMessage" ? "user" : family === "message" ? "agent" : family === "tool" ? "tool" : "agent";
    phase = "after";
    scope = { kind: "turn", id: text4(payload.turnId) };
    contentPath = "#/payload/item";
  } else if (method === "turn/completed") {
    const turn = isRecord5(payload.turn) ? payload.turn : {};
    if (!matchesOwnedScope(capture, { threadId: payload.threadId, turnId: turn.id })) return void 0;
    family = "outcome";
    actor = "harness";
    phase = "after";
    scope = { kind: "turn", id: text4(turn.id) };
    contentPath = "#/payload/turn";
  } else if (method === "turn/plan/updated" || method === "thread/compacted") {
    if (!matchesOwnedScope(capture, payload)) return void 0;
    family = "context";
    actor = "agent";
    scope = scopedTurn(payload);
    contentPath = "#/payload";
  } else if (method === "thread/tokenUsage/updated" || method === "model/rerouted" || method === "hook/completed") {
    if (!matchesOwnedScope(capture, payload, method === "hook/completed")) return void 0;
    family = "runtime";
    scope = scopedTurn(payload);
    contentPath = "#/payload";
  } else return void 0;
  const attributes = { method };
  if (method === "turn/completed" && isRecord5(payload.turn)) copyScalar(attributes, "status", payload.turn.status);
  if (method === "item/completed" && isRecord5(payload.item)) {
    copyScalar(attributes, "itemType", payload.item.type);
    copyScalar(attributes, "itemId", payload.item.id);
    copyScalar(attributes, "status", payload.item.status);
    if (payload.item.type === "fileChange" && payload.item.status === "completed") attributes.mutation = true;
    if (family === "tool") {
      copyScalar(attributes, "toolName", typeof payload.item.tool === "string" ? payload.item.tool : payload.item.type);
      copyScalar(attributes, "exitCode", payload.item.exitCode);
      const input = payload.item.command ?? payload.item.arguments ?? payload.item.query;
      if (input !== void 0) attributes.inputDigest = `sha256:${digestMetadata(input).value}`;
    }
  }
  if (method === "thread/tokenUsage/updated" && isRecord5(payload.tokenUsage)) {
    const total = numberRecord(payload.tokenUsage.total);
    if (total !== void 0) {
      for (const key of TOKEN_USAGE_FIELDS) copyScalar(attributes, key, total[key]);
      attributes.resourceSemantics = "cumulative-snapshot";
    }
  }
  const nativeTime = nativeTimestamp(method, payload);
  const receipt = method === "item/completed" && payload.completedAtMs !== void 0 ? void 0 : observationTime(record3.observedAt);
  if (receipt !== void 0) attributes.nativeTimeSource = "capture-receipt";
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: `codex:${record3.sequence}:${method.replaceAll("/", "-")}`,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: CODEX_HARNESS,
      nativeType: codexNativeType(record3),
      nativeReference: captured.reference
    },
    nativeOrder: { status: "known", value: record3.sequence, domain: "codex-app-server-stdio" },
    nativeTime: receipt ?? nativeTime,
    actor: { kind: actor },
    family,
    phase,
    scope,
    relations: {
      parent: { status: "unknown", reason: "Codex native records retain scope IDs but no uniform parent event identity." },
      known: []
    },
    attributes,
    content: contentPath === void 0 ? { status: "unknown", reason: "This mapped record has no projected content body." } : {
      status: "known",
      value: [{
        nativeReference: {
          artifactId: captured.reference.artifactId,
          recordLocator: `${captured.reference.recordLocator}${contentPath}`
        },
        mediaType: "application/json"
      }]
    }
  };
}
var TOKEN_USAGE_FIELDS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];
function requestUsage(snapshot, record3) {
  const payload = isRecord5(record3.payload) ? record3.payload : {};
  const last = record3.method === "thread/tokenUsage/updated" && isRecord5(payload.tokenUsage) ? numberRecord(payload.tokenUsage.last) : void 0;
  if (last === void 0) return [];
  const attributes = { method: record3.method };
  for (const key of TOKEN_USAGE_FIELDS) copyScalar(attributes, key, last[key]);
  attributes.resourceSemantics = "increment";
  attributes.usageScope = "assistant";
  if (typeof snapshot.attributes.nativeTimeSource === "string") attributes.nativeTimeSource = snapshot.attributes.nativeTimeSource;
  return [{
    ...snapshot,
    id: `${snapshot.id}:request`,
    attributes,
    content: snapshot.content.status === "known" ? { status: "known", value: [{ ...snapshot.content.value[0], nativeReference: { ...snapshot.content.value[0].nativeReference, recordLocator: `${snapshot.source.nativeReference.recordLocator}#/payload/tokenUsage/last` } }] } : snapshot.content
  }];
}
function codexNativeType(record3) {
  if (record3.kind === "request" && record3.source === CODEX_HARNESS) return "server-request";
  return record3.method ?? record3.kind;
}
function captureIdentity(capture) {
  const value = capture;
  const threadId = text4(value.threadId);
  const turnId = text4(value.turnId);
  return {
    ...threadId === void 0 ? {} : { threadId },
    ...turnId === void 0 ? {} : { turnId }
  };
}
function matchesOwnedScope(capture, payload, allowSessionScope = false) {
  const owned = captureIdentity(capture);
  if (owned.threadId === void 0 || owned.turnId === void 0 || text4(payload.threadId) !== owned.threadId) return false;
  const recordTurnId = text4(payload.turnId);
  return recordTurnId === owned.turnId || allowSessionScope && (payload.turnId === null || payload.turnId === void 0);
}
function itemFamily(type) {
  if (type === "userMessage" || type === "agentMessage") return "message";
  if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "webSearch") return "tool";
  if (type === "fileChange") return "artifact";
  if (type === "collabAgentToolCall") return "delegation";
  return void 0;
}
function nativeTimestamp(method, payload) {
  const milliseconds = method === "item/completed" ? payload.completedAtMs : void 0;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds)) {
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return { status: "known", value: date.toISOString() };
  }
  return milliseconds === void 0 ? { status: "unknown", reason: "Native record omitted a lifecycle timestamp." } : { status: "unknown", reason: "Native lifecycle timestamp is invalid or outside the supported range." };
}
function observationTime(value) {
  if (typeof value !== "string") return void 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? void 0 : { status: "known", value: date.toISOString() };
}
function scopedTurn(payload) {
  return text4(payload.turnId) === void 0 ? { kind: "session", id: text4(payload.threadId) } : { kind: "turn", id: text4(payload.turnId) };
}
function copyScalar(target, key, value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[key] = value;
}
function resolvesCaptureReference(capture, reference) {
  return capture.records.some(({ reference: base }) => base.artifactId === reference.artifactId && (reference.recordLocator === base.recordLocator || reference.recordLocator.startsWith(`${base.recordLocator}#`)));
}
function isPermissionRequest(method) {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval"
  ].includes(method);
}
function numberRecord(value) {
  if (!isRecord5(value)) return void 0;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "number" || !Number.isFinite(item))) return void 0;
  return Object.fromEntries(entries);
}
function text4(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/devin.ts
init_artifacts();

// src/otlp-protobuf.ts
var ANY_VALUE = {};
var KEY_VALUE = {
  1: { name: "key", kind: "string" },
  2: { name: "value", kind: "message", schema: ANY_VALUE }
};
var ARRAY_VALUE = { 1: { name: "values", kind: "message", schema: ANY_VALUE, repeated: true } };
var KEY_VALUE_LIST = { 1: { name: "values", kind: "message", schema: KEY_VALUE, repeated: true } };
Object.assign(ANY_VALUE, {
  1: { name: "stringValue", kind: "string" },
  2: { name: "boolValue", kind: "bool" },
  3: { name: "intValue", kind: "int" },
  4: { name: "doubleValue", kind: "double" },
  5: { name: "arrayValue", kind: "message", schema: ARRAY_VALUE },
  6: { name: "kvlistValue", kind: "message", schema: KEY_VALUE_LIST },
  7: { name: "bytesValue", kind: "bytes" }
});

// src/devin.ts
var DEVIN_CLI_VERSION = "3000.11.3";
var RETAINED_DEVIN_CLI_VERSIONS = [DEVIN_CLI_VERSION];
var DEVIN_ADAPTER_VERSION = "0.1.0";
var DEVIN_HARNESS = "devin-cli";
var DEVIN_CLIENT = "ebo-devin-client";
var PROMPT_USAGE_FIELDS = ["totalTokens", "inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"];
var PERMISSION_REQUEST = "session/request_permission";
var AGENT_STOPPED = "_cognition.ai/agent_stopped";
var DEVIN_CLI_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: `ebo-devin-cli-v${DEVIN_CLI_VERSION}`,
  harness: DEVIN_HARNESS,
  nativeTypes: [
    "session/update:agent_message_chunk",
    "session/update:user_message_chunk",
    "session/update:tool_call",
    "session/update:tool_call_update",
    "session/update:usage_update",
    "session/update:plan",
    AGENT_STOPPED,
    "server-request",
    "session/prompt",
    "session/prompt:response"
  ],
  families: {
    message: { status: "partial", detail: "The owned session/prompt request is the user message; agent messages arrive only as chunks, so each chunk is projected." },
    "model-request": { status: "unsupported", detail: "Inference requests are not inferred from ACP updates; OTLP api_request records stay telemetry evidence." },
    tool: { status: "partial", detail: "tool_call starts and completed/failed tool_call_update records are projected; progress updates stay native." },
    context: { status: "partial", detail: "ACP plan updates are projected when emitted." },
    permission: { status: "partial", detail: "session/request_permission requests are projected; the unattended decision stays a native response record." },
    delegation: { status: "unsupported", detail: "Subagent context appears only in usage metadata; no native child session identity is exposed over ACP." },
    artifact: { status: "unsupported", detail: "ACP tool calls do not report completed file changes; workspace outcome is packaged separately." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Devin native normalizer." },
    runtime: { status: "partial", detail: "usage_update context snapshots and agent_stopped turn statistics are projected with native values only." },
    outcome: { status: "available", detail: "The matching session/prompt response stopReason is authoritative for turn outcome." }
  },
  evidence: {
    nativeOrder: { status: "available", detail: "The retained receive/write sequence is one stdio ordering domain." },
    nativeTime: { status: "partial", detail: "ACP frames carry no native timestamps; events use EBO observation time labeled nativeTimeSource capture-receipt. OTLP log timestamps stay in telemetry evidence." },
    parentage: { status: "partial", detail: "Terminal tool_call_update events reference their tool_call event; other relations remain source-specific." },
    content: { status: "partial", detail: "Mapped content references retained native payloads without copying bodies." }
  }
};
async function normalizeDevinCapture(capture) {
  const events = [];
  const mapped = /* @__PURE__ */ new Set();
  const toolCalls = { events: /* @__PURE__ */ new Map(), terminalExits: /* @__PURE__ */ new Map() };
  for (const captured of capture.records) {
    const event = mapDevinRecord(capture, captured, toolCalls);
    if (event === void 0) continue;
    events.push(event);
    mapped.add(captured.record.sequence);
  }
  await validateUniformEvents(events, { resolve: (reference) => resolvesCaptureReference2(capture, reference) });
  return {
    events,
    unmapped: capture.records.filter(({ record: record3 }) => !mapped.has(record3.sequence)).map(({ reference }) => ({ reference, reason: "native record has no supported uniform mapping" }))
  };
}
async function describeAndValidateDevinDataset(capture, runtimeVersion = capture.telemetry?.runtime?.version ?? DEVIN_CLI_VERSION) {
  if (!RETAINED_DEVIN_CLI_VERSIONS.includes(runtimeVersion)) throw new Error(`Unsupported retained Devin runtime ${runtimeVersion}.`);
  const normalization = await normalizeDevinCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: DEVIN_CLI_CAPABILITIES,
    adapterVersion: DEVIN_ADAPTER_VERSION,
    nativeType: devinNativeType
  });
  const coverage = await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture));
  return { dataset, coverage };
}
function qualifyRetainedDevinCapture(capture, options) {
  if (!RETAINED_DEVIN_CLI_VERSIONS.includes(options.harnessVersion)) throw new Error(`Unsupported retained Devin runtime ${options.harnessVersion}.`);
  if (options.runtimeVersions.length === 0 || options.runtimeVersions.some((version) => version !== options.harnessVersion)) {
    throw new Error("Retained Devin native runtime version differs from the run manifest.");
  }
  const records = capture.records.map(({ record: record3 }) => record3);
  for (const record3 of records) {
    if (record3.source !== DEVIN_HARNESS && record3.source !== DEVIN_CLIENT) throw new Error(`Retained Devin capture contains a foreign source ${record3.source}.`);
  }
  let acceptedSequence = 0;
  const owned = (method) => {
    const sent = records.filter((record3) => record3.kind === "request" && record3.source === DEVIN_CLIENT && record3.method === method);
    if (sent.length > 1 || options.expectsCompletion && sent.length !== 1) throw new Error(`Retained Devin ${method} requires one owned request.`);
    const request = sent[0];
    if (request === void 0) return void 0;
    const responses = records.filter((record3) => record3.kind === "response" && record3.source === DEVIN_HARNESS && record3.id === request.id);
    if (request.id === void 0 || request.id === null || request.sequence <= acceptedSequence || responses.length > 1 || responses.some((response2) => response2.sequence <= request.sequence)) {
      throw new Error(`Retained Devin ${method} requires a unique ordered owned request/response pair.`);
    }
    const response = responses[0];
    if (options.expectsCompletion && (response === void 0 || !isRecord6(response.payload) || response.payload.error !== void 0)) {
      throw new Error(`Completed retained Devin capture lacks a successful owned ${method} response.`);
    }
    acceptedSequence = response?.sequence ?? request.sequence;
    return { request, ...response === void 0 ? {} : { response } };
  };
  owned("initialize");
  const session = owned("session/new");
  const sessionResult = session?.response?.payload;
  const sessionId = isRecord6(sessionResult) && sessionResult.error === void 0 ? text5(sessionResult.sessionId) : void 0;
  if (sessionId !== options.sessionId) throw new Error("Retained Devin session identity differs from the run manifest.");
  const prompt = owned("session/prompt");
  if (prompt !== void 0 && (sessionId === void 0 || !isRecord6(prompt.request.payload) || prompt.request.payload.sessionId !== sessionId || typeof prompt.request.id !== "number")) {
    throw new Error("Retained Devin session/prompt is not bound to the owned session.");
  }
  for (const record3 of records) {
    const payload = isRecord6(record3.payload) ? record3.payload : {};
    if (record3.sourceIdentity !== void 0 && record3.sourceIdentity !== sessionId || record3.kind === "notification" && record3.method === "session/update" && payload.sessionId !== sessionId) {
      throw new Error("Retained Devin stream identity differs from the owned session.");
    }
  }
  const completions = records.filter((record3) => record3.kind === "completion" && record3.source === DEVIN_HARNESS && record3.method === "session/prompt");
  if (completions.length > 1 || completions.length === 1 && (prompt?.response === void 0 || completions[0].sequence <= prompt.response.sequence)) {
    throw new Error("Retained Devin capture requires unambiguous matching owned terminal evidence.");
  }
  if (options.expectsCompletion) {
    const result = prompt?.response?.payload;
    if (!isRecord6(result) || result.error !== void 0 || result.stopReason !== "end_turn" || completions[0]?.status !== "end_turn") {
      throw new Error("Completed retained Devin capture lacks matching owned end_turn terminal evidence.");
    }
  }
  return {
    ...capture,
    ...sessionId === void 0 ? {} : { sessionId },
    ...prompt === void 0 ? {} : { promptRequestId: prompt.request.id }
  };
}
function mapDevinRecord(capture, captured, toolCalls) {
  const record3 = captured.record;
  const owned = captureIdentity2(capture);
  if (owned.sessionId === void 0 || record3.method === void 0) return void 0;
  const payload = isRecord6(record3.payload) ? record3.payload : {};
  const attributes = { method: record3.method };
  let family;
  let actor = "harness";
  let phase = "instant";
  let contentPath;
  let parent;
  let label = record3.method.replaceAll("/", "-");
  if (record3.kind === "request" && record3.source === DEVIN_CLIENT && record3.method === "session/prompt") {
    if (owned.promptRequestId === void 0 || record3.id !== owned.promptRequestId) return void 0;
    family = "message";
    actor = "user";
    phase = "before";
    contentPath = "#/payload/prompt";
    label = "session-prompt";
  } else if (record3.kind === "request" && record3.source === DEVIN_HARNESS && record3.method === PERMISSION_REQUEST) {
    if (text5(payload.sessionId) !== owned.sessionId) return void 0;
    family = "permission";
    phase = "before";
    contentPath = "#/payload";
    if (isRecord6(payload.toolCall)) copyScalar2(attributes, "toolCallId", payload.toolCall.toolCallId);
    if (Array.isArray(payload.options)) attributes.optionCount = payload.options.length;
  } else if (record3.kind === "response" && record3.source === DEVIN_HARNESS && record3.method === "session/prompt") {
    if (owned.promptRequestId === void 0 || record3.id !== owned.promptRequestId) return void 0;
    family = "outcome";
    phase = "after";
    contentPath = "#/payload";
    label = "session-prompt-response";
    copyScalar2(attributes, "stopReason", payload.stopReason);
    if (isRecord6(payload.error)) {
      attributes.error = true;
      copyScalar2(attributes, "errorCode", payload.error.code);
    }
    if (isRecord6(payload.usage)) {
      for (const key of PROMPT_USAGE_FIELDS) copyScalar2(attributes, key, payload.usage[key]);
      attributes.usageSemantics = "final-request";
    }
  } else if (record3.kind === "notification" && record3.source === DEVIN_HARNESS && text5(payload.sessionId) === owned.sessionId) {
    if (record3.method === "session/update") {
      const update = isRecord6(payload.update) ? payload.update : {};
      const type = text5(update.sessionUpdate);
      if (type === void 0) return void 0;
      label = type;
      attributes.sessionUpdate = type;
      const meta = isRecord6(update._meta) ? update._meta : {};
      if (type === "agent_message_chunk" || type === "user_message_chunk") {
        family = "message";
        actor = type === "user_message_chunk" ? "user" : "agent";
        contentPath = "#/payload/update/content";
      } else if (type === "plan") {
        family = "context";
        actor = "agent";
        contentPath = "#/payload/update";
      } else if (type === "tool_call") {
        family = "tool";
        actor = "agent";
        phase = "before";
        contentPath = "#/payload/update";
        copyScalar2(attributes, "toolCallId", update.toolCallId);
        copyScalar2(attributes, "kind", update.kind);
        copyScalar2(attributes, "title", update.title);
        copyScalar2(attributes, "toolName", meta["cognition.ai/inferenceToolName"]);
        if (update.rawInput !== void 0) attributes.inputDigest = `sha256:${digestMetadata(update.rawInput).value}`;
      } else if (type === "tool_call_update") {
        const status = text5(update.status);
        const toolCallId = text5(update.toolCallId);
        if (toolCallId !== void 0 && isRecord6(meta.terminal_exit)) toolCalls.terminalExits.set(toolCallId, meta.terminal_exit);
        if (status !== "completed" && status !== "failed") return void 0;
        family = "tool";
        actor = "tool";
        phase = "after";
        contentPath = "#/payload/update";
        attributes.status = status;
        copyScalar2(attributes, "toolCallId", update.toolCallId);
        copyScalar2(attributes, "toolName", meta["cognition.ai/inferenceToolName"]);
        if (meta["cognition.ai/canceled"] === true) attributes.canceled = true;
        const terminalExit = isRecord6(meta.terminal_exit) ? meta.terminal_exit : toolCallId === void 0 ? void 0 : toolCalls.terminalExits.get(toolCallId);
        if (terminalExit !== void 0) {
          copyScalar2(attributes, "exitCode", terminalExit.exit_code);
          copyScalar2(attributes, "signal", terminalExit.signal);
        }
        if (toolCallId !== void 0) parent = toolCalls.events.get(toolCallId);
      } else if (type === "usage_update") {
        family = "runtime";
        contentPath = "#/payload/update";
        copyScalar2(attributes, "used", update.used);
        copyScalar2(attributes, "size", update.size);
        copyScalar2(attributes, "inputTokens", meta["cognition.ai/inputTokens"]);
        copyScalar2(attributes, "outputTokens", meta["cognition.ai/outputTokens"]);
        copyScalar2(attributes, "cachedReadTokens", meta["cognition.ai/cachedReadTokens"]);
        attributes.usageSemantics = "request-context-snapshot";
      } else return void 0;
    } else if (record3.method === AGENT_STOPPED) {
      family = "runtime";
      contentPath = "#/payload";
      copyScalar2(attributes, "cause", payload.cause);
      const stats = isRecord6(payload.stats) ? payload.stats : {};
      for (const key of ["modelLabel", "toolCalls", "filesChanged", "commandsRun", "ttftMs", "totalTimeMs"]) copyScalar2(attributes, key, stats[key]);
      const cumulative = cumulativeTokenDimensions(stats.responseDimensions);
      if (cumulative !== void 0) {
        Object.assign(attributes, cumulative);
        attributes.resourceSemantics = "cumulative-final";
      }
    } else return void 0;
  } else return void 0;
  const nativeTime = observationTime2(record3.observedAt);
  if (nativeTime !== void 0) attributes.nativeTimeSource = "capture-receipt";
  const id = `devin:${record3.sequence}:${label}`;
  if (label === "tool_call") {
    const toolCallId = text5(attributes.toolCallId);
    if (toolCallId !== void 0 && !toolCalls.events.has(toolCallId)) toolCalls.events.set(toolCallId, id);
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: { harness: DEVIN_HARNESS, nativeType: devinNativeType(record3), nativeReference: captured.reference },
    nativeOrder: { status: "known", value: record3.sequence, domain: "devin-acp-stdio" },
    nativeTime: nativeTime ?? { status: "unknown", reason: "ACP frames carry no native timestamp and the observation time was invalid." },
    actor: { kind: actor },
    family,
    phase,
    scope: { kind: "session", id: owned.sessionId },
    relations: {
      parent: parent === void 0 ? { status: "unknown", reason: "Devin ACP records retain the session scope but no uniform parent event identity." } : { status: "known", value: parent },
      known: []
    },
    attributes,
    content: {
      status: "known",
      value: [{
        nativeReference: { artifactId: captured.reference.artifactId, recordLocator: `${captured.reference.recordLocator}${contentPath}` },
        mediaType: "application/json"
      }]
    }
  };
}
function devinNativeType(record3) {
  if (record3.kind === "request" && record3.source === DEVIN_HARNESS) return "server-request";
  if (record3.kind === "response" && record3.source === DEVIN_HARNESS && record3.method === "session/prompt") return "session/prompt:response";
  if (record3.kind === "notification" && record3.method === "session/update" && isRecord6(record3.payload) && isRecord6(record3.payload.update)) {
    const type = text5(record3.payload.update.sessionUpdate);
    if (type !== void 0) return `session/update:${type}`;
  }
  return record3.method ?? record3.kind;
}
function captureIdentity2(capture) {
  const value = capture;
  const sessionId = text5(value.sessionId);
  return {
    ...sessionId === void 0 ? {} : { sessionId },
    ...typeof value.promptRequestId === "number" ? { promptRequestId: value.promptRequestId } : {}
  };
}
function cumulativeTokenDimensions(value) {
  if (!Array.isArray(value)) return void 0;
  const names = { input_tokens: "inputTokens", output_tokens: "outputTokens", cached_input_tokens: "cachedInputTokens" };
  const output = {};
  for (const dimension of value) {
    if (!isRecord6(dimension) || !isRecord6(dimension.kind) || dimension.kind.type !== "cumulativeMetric") continue;
    const name = names[String(dimension.uid)];
    if (name === void 0 || typeof dimension.kind.value !== "number" || !Number.isFinite(dimension.kind.value)) continue;
    output[name] = dimension.kind.value;
  }
  return Object.keys(output).length === 0 ? void 0 : output;
}
function resolvesCaptureReference2(capture, reference) {
  return capture.records.some(({ reference: base }) => base.artifactId === reference.artifactId && (reference.recordLocator === base.recordLocator || reference.recordLocator.startsWith(`${base.recordLocator}#`)));
}
function observationTime2(value) {
  if (typeof value !== "string") return void 0;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? void 0 : { status: "known", value: date.toISOString() };
}
function copyScalar2(target, key, value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") target[key] = value;
}
function text5(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/openhands.ts
var OPENHANDS_AGENT_SERVER_VERSION = "1.54.0";
var RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS = [OPENHANDS_AGENT_SERVER_VERSION, "1.46.0", "1.44.1"];
var OPENHANDS_DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
var OPENHANDS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
var OPENHANDS_DEFAULT_MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
var OPENHANDS_MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;
var OPENHANDS_AGENT_SERVER_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: "openhands-agent-server-v1.54.0",
  harness: "openhands-agent-server",
  nativeTypes: [
    "MessageEvent",
    "SystemPromptEvent",
    "ActionEvent",
    "ObservationEvent",
    "AgentErrorEvent",
    "UserRejectObservation",
    "CondensationRequest",
    "Condensation",
    "CondensationSummaryEvent",
    "ConversationErrorEvent",
    "ServerErrorEvent",
    "HookExecutionEvent",
    "ConversationStateUpdateEvent",
    "InterruptEvent",
    "PauseEvent",
    "conversation-final"
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "unsupported", detail: "The pinned public event boundary does not expose model requests." },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported", detail: "Hook blocking is retained natively but is not projected as a permission event." },
    delegation: { status: "unsupported", detail: "Nested delegate actions remain source-specific tool evidence." },
    artifact: { status: "unsupported", detail: "Workspace outcome is packaged outside the Agent Server event normalizer." },
    validation: { status: "unsupported", detail: "Verifier evidence is packaged outside the Agent Server event normalizer." },
    runtime: { status: "available" },
    outcome: { status: "partial", detail: "Final conversation state is available when the run reaches the final REST read." }
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "REST page and WebSocket receipt order remain separate source domains." },
    nativeTime: { status: "partial", detail: "Event timestamps are available; control records may omit native time." },
    parentage: { status: "partial", detail: "Event parent_id and selected action associations are projected when their targets are captured." },
    content: { status: "partial", detail: "Supported content stays in native records and is referenced rather than copied." }
  }
};
function openHandsCapabilityProfile(version) {
  if (!RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS.includes(version)) {
    throw new Error(`Unsupported retained OpenHands runtime ${version}.`);
  }
  return { ...OPENHANDS_AGENT_SERVER_CAPABILITIES, adapterId: `openhands-agent-server-v${version}` };
}
async function normalizeOpenHandsCapture(capture) {
  const conversationId = capture.records.find(({ record: record3 }) => record3.session_id !== void 0)?.record.session_id;
  if (conversationId === void 0) {
    return {
      events: [],
      unmapped: capture.records.map(({ reference }) => ({
        reference,
        reason: "capture ended before the Agent Server assigned a conversation identity"
      }))
    };
  }
  const canonical = /* @__PURE__ */ new Map();
  for (const captured of capture.records) {
    if (captured.record.channel !== "rest-event") continue;
    const id = nativeEventId(captured.record.payload);
    if (id !== void 0) canonical.set(id, captured);
  }
  for (const captured of capture.records) {
    if (captured.record.channel !== "websocket-event") continue;
    const id = nativeEventId(captured.record.payload);
    if (id !== void 0 && !canonical.has(id)) canonical.set(id, captured);
  }
  const events = [];
  const mappedReferences = /* @__PURE__ */ new Set();
  const eventIdByNativeId = /* @__PURE__ */ new Map();
  for (const [id, captured] of canonical) {
    const native = captured.record.payload;
    const kind = typeof native.kind === "string" ? native.kind : "";
    const eventId = uniformEventId(id);
    if (mappedEvent(kind) !== void 0 && nativeEventSource(native.source) !== void 0 && eventId !== void 0) {
      eventIdByNativeId.set(id, eventId);
    }
  }
  for (const [nativeId, captured] of canonical) {
    if (!eventIdByNativeId.has(nativeId)) continue;
    const mapped = mapOpenHandsEvent(capture, conversationId, captured, nativeId, eventIdByNativeId);
    if (mapped === void 0) continue;
    events.push(mapped);
    mappedReferences.add(referenceKey5(captured.reference));
  }
  for (const captured of capture.records.filter(({ record: record3 }) => record3.channel === "conversation-final")) {
    events.push(mapOpenHandsOutcome(capture, conversationId, captured));
    mappedReferences.add(referenceKey5(captured.reference));
  }
  return {
    events,
    unmapped: capture.records.filter(({ reference }) => !mappedReferences.has(referenceKey5(reference))).map(({ reference, record: record3 }) => ({
      reference,
      reason: record3.channel === "websocket-event" && canonical.has(nativeEventId(record3.payload) ?? "") ? "reconciled duplicate; final REST event is canonical" : "native record has no uniform mapping"
    }))
  };
}
function mapOpenHandsOutcome(capture, conversationId, captured) {
  const native = captured.record.payload;
  const attributes = {};
  copyScalar3(attributes, "executionStatus", native.execution_status);
  if (isRecord7(native.workspace)) {
    copyScalar3(attributes, "workspaceKind", native.workspace.kind ?? native.workspace.type);
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: `openhands:control:conversation-final:${captured.record.sequence}`,
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: "openhands-agent-server",
      nativeType: "conversation-final",
      nativeReference: captured.reference
    },
    nativeOrder: { status: "unknown", reason: "Conversation status records have no native sequence." },
    nativeTime: isOffsetDateTime(native.updated_at) ? { status: "known", value: native.updated_at } : { status: "unknown", reason: "Final conversation record omitted an RFC 3339 update time with an explicit offset." },
    actor: { kind: "harness", id: "openhands-agent-server" },
    family: "outcome",
    phase: "after",
    scope: { kind: "session", id: conversationId },
    relations: {
      parent: { status: "unknown", reason: "Agent Server does not relate final conversation state to one event." },
      known: []
    },
    attributes,
    content: {
      status: "known",
      value: [{
        nativeReference: {
          artifactId: captured.reference.artifactId,
          recordLocator: `${captured.reference.recordLocator}#/payload`
        },
        mediaType: "application/json"
      }]
    }
  };
}
function mapOpenHandsEvent(capture, conversationId, captured, nativeId, eventIdByNativeId) {
  const native = captured.record.payload;
  const kind = typeof native.kind === "string" ? native.kind : void 0;
  if (kind === void 0) return void 0;
  const mapping = mappedEvent(kind);
  if (mapping === void 0) return void 0;
  const source = nativeEventSource(native.source);
  if (source === void 0) return void 0;
  const parentId = typeof native.parent_id === "string" ? eventIdByNativeId.get(native.parent_id) : void 0;
  const knownRelations = [];
  if (kind === "ObservationEvent" && typeof native.action_id === "string") {
    const actionId = eventIdByNativeId.get(native.action_id);
    if (actionId !== void 0) knownRelations.push({ kind: "caused-by", eventId: actionId });
  }
  if (kind === "HookExecutionEvent") {
    const relatedId = typeof native.action_id === "string" ? native.action_id : typeof native.message_id === "string" ? native.message_id : void 0;
    const eventId = relatedId === void 0 ? void 0 : eventIdByNativeId.get(relatedId);
    if (eventId !== void 0) knownRelations.push({ kind: "correlates-with", eventId });
  }
  return {
    schemaVersion: "ebo.uniform-event/v1",
    id: eventIdByNativeId.get(nativeId),
    runId: capture.runId,
    attemptId: capture.attemptId,
    source: {
      harness: "openhands-agent-server",
      nativeType: kind,
      nativeReference: captured.reference
    },
    nativeOrder: captured.record.channelSequence === void 0 ? { status: "unknown", reason: "Agent Server record has no native sequence." } : {
      status: "known",
      value: captured.record.channelSequence,
      domain: captured.record.channel === "rest-event" ? "agent-server-rest" : "agent-server-websocket"
    },
    nativeTime: isOffsetDateTime(native.timestamp) ? { status: "known", value: native.timestamp } : { status: "unknown", reason: "Agent Server event omitted an RFC 3339 timestamp with an explicit offset." },
    actor: { kind: actorForSource(source), id: source },
    family: mapping.family,
    phase: mapping.phase,
    scope: { kind: "session", id: conversationId },
    relations: {
      parent: parentId === void 0 ? { status: "unknown", reason: "No captured mapped parent event is available." } : { status: "known", value: parentId },
      known: knownRelations
    },
    attributes: eventAttributes(kind, source, native),
    content: eventContent(kind, captured)
  };
}
function mappedEvent(kind) {
  if (kind === "MessageEvent" || kind === "SystemPromptEvent") return { family: "message", phase: "instant" };
  if (kind === "ActionEvent") return { family: "tool", phase: "before" };
  if (["ObservationEvent", "AgentErrorEvent", "UserRejectObservation"].includes(kind)) return { family: "tool", phase: "after" };
  if (kind === "CondensationRequest") return { family: "context", phase: "before" };
  if (kind === "Condensation") return { family: "context", phase: "during" };
  if (kind === "CondensationSummaryEvent") return { family: "context", phase: "after" };
  if (["ConversationErrorEvent", "ServerErrorEvent", "HookExecutionEvent", "ConversationStateUpdateEvent", "InterruptEvent", "PauseEvent"].includes(kind)) {
    return { family: "runtime", phase: "instant" };
  }
  return void 0;
}
function eventAttributes(kind, source, native) {
  const attributes = {
    nativeSource: source
  };
  copyScalar3(attributes, "toolName", native.tool_name);
  copyScalar3(attributes, "toolCallId", native.tool_call_id);
  copyScalar3(attributes, "actionId", native.action_id);
  copyScalar3(attributes, "llmResponseId", native.llm_response_id);
  if (kind === "AgentErrorEvent") attributes.errorScope = "agent-tool";
  if (kind === "ConversationErrorEvent") attributes.errorScope = "conversation";
  if (kind === "ServerErrorEvent") attributes.errorScope = "server";
  if (["ConversationErrorEvent", "ServerErrorEvent"].includes(kind)) copyScalar3(attributes, "errorCode", native.code);
  if (kind === "HookExecutionEvent") {
    copyScalar3(attributes, "hookEventType", native.hook_event_type);
    copyScalar3(attributes, "success", native.success);
    copyScalar3(attributes, "exitCode", native.exit_code);
    copyScalar3(attributes, "blocked", native.blocked);
  }
  if (kind === "ConversationStateUpdateEvent") {
    copyScalar3(attributes, "stateKey", native.key);
    copyScalar3(attributes, "stateValue", native.value);
  }
  if (kind === "Condensation" && Array.isArray(native.forgotten_event_ids) && native.forgotten_event_ids.length <= 16 && native.forgotten_event_ids.every((value) => typeof value === "string" && value.length <= 512)) {
    attributes.forgottenEventIds = native.forgotten_event_ids;
  }
  return attributes;
}
function copyScalar3(target, name, value) {
  if (typeof value === "string" && value.length <= 512 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) target[name] = value;
}
function eventContent(kind, captured) {
  const native = captured.record.payload;
  const llmMessage = isRecord7(native.llm_message) ? native.llm_message : void 0;
  const pointer = kind === "MessageEvent" && llmMessage !== void 0 && Object.hasOwn(llmMessage, "content") ? "/payload/llm_message/content" : kind === "SystemPromptEvent" && Object.hasOwn(native, "system_prompt") ? "/payload/system_prompt" : kind === "ActionEvent" && Object.hasOwn(native, "action") ? "/payload/action" : ["ObservationEvent", "UserRejectObservation"].includes(kind) && Object.hasOwn(native, "observation") ? "/payload/observation" : kind === "AgentErrorEvent" && Object.hasOwn(native, "error") ? "/payload/error" : ["ConversationErrorEvent", "ServerErrorEvent"].includes(kind) && Object.hasOwn(native, "detail") ? "/payload/detail" : kind === "Condensation" || kind === "HookExecutionEvent" ? "/payload" : kind === "CondensationSummaryEvent" && Object.hasOwn(native, "summary") ? "/payload/summary" : void 0;
  return pointer === void 0 ? { status: "unknown", reason: "Pinned Agent Server event has no mapped content field." } : {
    status: "known",
    value: [{
      nativeReference: {
        artifactId: captured.reference.artifactId,
        recordLocator: `${captured.reference.recordLocator}#${pointer}`
      },
      mediaType: "application/json"
    }]
  };
}
function nativeEventSource(value) {
  return typeof value === "string" && ["user", "agent", "environment", "hook"].includes(value) ? value : void 0;
}
function actorForSource(source) {
  if (source === "user") return "user";
  if (source === "agent") return "agent";
  return "harness";
}
function nativeEventId(event) {
  return typeof event.id === "string" && event.id.length > 0 ? event.id : void 0;
}
function uniformEventId(nativeId) {
  const eventId = `openhands:native:${nativeId}`;
  return eventId.length <= 255 ? eventId : void 0;
}
function isOffsetDateTime(value) {
  return typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
}
function referenceKey5(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/deepseek-adapter.ts
init_artifacts();
import { readFileSync as readFileSync3 } from "node:fs";
import { resolve as resolve6 } from "node:path";
import {
  HarnessClient
} from "@deepseek-ai/dsh-sdk-client";
var DEEPSEEK_SDK_VERSION = "0.2.0-rc.2";
var RETAINED_DEEPSEEK_SDK_VERSIONS = [DEEPSEEK_SDK_VERSION, "0.1.7-rc.2", "0.1.1-rc.2"];
var DEEPSEEK_ADAPTER_ID = "deepseek-harness-sdk";
var DEEPSEEK_HARNESS_ID = "deepseek-harness";
function deepSeekCapabilities(composition) {
  return {
    protocolVersionNegotiation: "unsupported",
    promptCancellation: "unsupported",
    sessionClose: "unsupported",
    promptResult: "unsupported",
    sessionEvents: "available",
    sessionStatus: "available",
    subagentNotifications: "available",
    telemetry: composition.telemetry.status === "enabled" ? "available" : "unsupported",
    nativeSpans: composition.telemetry.nativeSpans,
    completionEvidence: "agent/inbox/spliced-to-session.status:idle"
  };
}
async function executeDeepSeekHarness(context, configuration, capture) {
  validateConfiguration(configuration, context);
  const composition = structuredClone(configuration.composition);
  const capabilities = deepSeekCapabilities(composition);
  const client = new HarnessClient(clientOptions(configuration));
  const subscription = client.subscribeSessionTree(configuration.sessionId);
  const sensitiveValues = composition.environment.secretKeys.flatMap((key) => configuration.env[key] ?? []);
  let status = "failed";
  let serverInfo;
  let messageId;
  let receiptSequence;
  let idleSequence;
  let failure;
  let nativeTurnError;
  let stderr;
  let captureError;
  let shutdownResult = { status: "completed" };
  context.registerShutdown(() => client.close());
  const closeOnAbort = () => {
    void client.close().catch(() => void 0);
  };
  if (!context.signal.aborted) context.signal.addEventListener("abort", closeOnAbort, { once: true });
  const retainNotification = async (notification) => {
    const sourceIdentity = notificationIdentity(notification);
    let retained;
    try {
      retained = await capture.record({
        kind: "notification",
        method: notification.method,
        sessionId: notificationSessionId(notification, configuration.sessionId),
        ...sourceIdentity === void 0 ? {} : { sourceIdentity },
        payload: notification.params
      });
    } catch (error) {
      captureError ??= sanitizedError(error, sensitiveValues);
      throw error;
    }
    if (receiptSequence === void 0 && messageId !== void 0 && isInboxReceipt(notification, configuration.sessionId, messageId)) {
      receiptSequence = retained.sequence;
    }
    if (receiptSequence !== void 0 && isRootIdle(notification, configuration.sessionId)) {
      idleSequence = retained.sequence;
    }
  };
  await capture.record({ kind: "composition", payload: composition });
  await capture.record({ kind: "capability", payload: capabilities });
  try {
    throwIfAborted(context.signal);
    const initialize = {
      cwd: composition.workspaceCwd,
      provider: composition.route.provider,
      model: composition.route.model,
      ...composition.route.maxTokens === void 0 ? {} : { maxTokens: composition.route.maxTokens }
    };
    await capture.record({ kind: "request", method: "initialize", payload: initialize });
    client.start();
    ({ serverInfo } = await client.initialize(initialize));
    await capture.record({ kind: "response", method: "initialize", payload: { serverInfo } });
    throwIfAborted(context.signal);
    const contentBlocks = typeof configuration.input === "string" ? [{ type: "text", text: configuration.input }] : configuration.input;
    await capture.record({ kind: "request", method: "session/prompt", sessionId: configuration.sessionId, payload: { contentBlocks } });
    throwIfAborted(context.signal);
    messageId = await client.prompt(configuration.sessionId, contentBlocks);
    await capture.record({ kind: "response", method: "session/prompt", sessionId: configuration.sessionId, sourceIdentity: messageId, payload: { messageId } });
    const inactivityMs = configuration.activityTimeoutMs ?? context.budgetMs ?? 6e4;
    const totalDeadline = context.budgetMs === void 0 ? void 0 : Date.now() + context.budgetMs;
    while (idleSequence === void 0) {
      const inactivityDeadline = Date.now() + inactivityMs;
      const deadline = totalDeadline === void 0 ? inactivityDeadline : Math.min(inactivityDeadline, totalDeadline);
      await retainNotification(await nextNotification(subscription, context.signal, deadline));
    }
    nativeTurnError = deepSeekTerminalError(capture.report(), configuration.sessionId);
    if (nativeTurnError !== void 0) throw new Error(`DeepSeek native turn failed: ${nativeTurnError}`);
    status = "completed";
  } catch (error) {
    failure = error;
    status = context.signal.aborted || error instanceof DeepSeekInterruptedError ? "interrupted" : error instanceof DeepSeekActivityTimeoutError ? "stopped" : "failed";
    const diagnostic = sanitizedError(error, sensitiveValues);
    stderr = extractStderr(diagnostic);
    try {
      await capture.record({ kind: "error", payload: { name: errorName(error), message: withoutStderr(diagnostic) } });
      if (stderr !== void 0) await capture.record({ kind: "diagnostic", stream: "stderr", payload: { text: stderr } });
    } catch (recordError) {
      captureError = sanitizedError(recordError, sensitiveValues);
    }
  } finally {
    context.signal.removeEventListener("abort", closeOnAbort);
    try {
      await capture.record({ kind: "request", method: "client.close" });
    } catch (error) {
      captureError ??= sanitizedError(error, sensitiveValues);
    }
    let closeFailure;
    try {
      await client.close();
    } catch (error) {
      closeFailure = error;
    }
    for (let notification = subscription.tryNext(); notification !== void 0; notification = subscription.tryNext()) {
      try {
        await retainNotification(notification);
      } catch (error) {
        captureError ??= sanitizedError(error, sensitiveValues);
      }
    }
    subscription.close();
    if (closeFailure === void 0) {
      try {
        await capture.record({ kind: "response", method: "client.close", payload: { status: "runtime-reaped" } });
      } catch (error) {
        captureError ??= sanitizedError(error, sensitiveValues);
      }
    } else {
      const error = closeFailure;
      const message = sanitizedError(error, sensitiveValues);
      shutdownResult = { status: "failed", error: message };
      try {
        await capture.record({ kind: "error", method: "client.close", payload: { name: errorName(error), message: withoutStderr(message) } });
      } catch (recordError) {
        captureError ??= sanitizedError(recordError, sensitiveValues);
      }
      const tail = extractStderr(message);
      if (tail !== void 0) {
        stderr = tail;
        try {
          await capture.record({ kind: "diagnostic", method: "client.close", stream: "stderr", payload: { text: tail } });
        } catch (recordError) {
          captureError ??= sanitizedError(recordError, sensitiveValues);
        }
      }
      if (status === "completed") {
        status = "failed";
        failure = error;
      }
    }
  }
  const report = {
    status,
    composition,
    capabilities,
    records: capture.report(),
    relatedSessionIds: relatedSessionIds(capture.report(), configuration.sessionId),
    ...serverInfo === void 0 ? {} : { serverInfo },
    ...messageId === void 0 ? {} : { messageId },
    ...receiptSequence === void 0 ? {} : { receiptSequence },
    ...idleSequence === void 0 ? {} : { idleSequence },
    ...failure === void 0 ? {} : { error: sanitizedError(failure, sensitiveValues) },
    ...captureError === void 0 ? {} : { captureError },
    ...stderr === void 0 ? {} : { stderr }
  };
  return {
    status,
    // A native turn error is the task failing; other failures are the harness or its transport.
    ...status === "failed" ? { failureClass: nativeTurnError === void 0 ? "infrastructure" : "task" } : {},
    ...status === "stopped" ? { stopReason: "budget" } : {},
    ...report.error === void 0 ? {} : { error: report.error },
    ...captureError === void 0 ? {} : { captureError },
    completionEvidence: {
      authority: "durable-receipt-to-whole-agent-idle",
      ...messageId === void 0 ? {} : { messageId },
      ...receiptSequence === void 0 ? {} : { receiptSequence },
      ...idleSequence === void 0 ? {} : { idleSequence },
      promptResult: { status: "unsupported" }
    },
    evidence: report,
    shutdownResult
  };
}
function qualifiedDeepSeekCapture(runId, attemptId, report, artifactId = "deepseek-session") {
  const qualification = deepSeekCaptureQualification(
    report.records,
    report.status === "completed",
    report.receiptSequence,
    report.idleSequence,
    report.captureError
  );
  return {
    runId,
    attemptId,
    qualification,
    records: report.records.map((record3) => ({
      reference: { artifactId, recordLocator: `line:${record3.sequence}` },
      record: record3
    }))
  };
}
function deepSeekTerminalError(records, sessionId) {
  for (const observation2 of records) {
    if (observation2.kind !== "notification" || observation2.method !== "session.event" || nativeSessionId(observation2) !== sessionId) continue;
    const event = nativeSessionEvent(observation2);
    const reason = record2(record2(event?.data)?.reason);
    if (event?.type === "turn/end" && reason?.kind === "error") return JSON.stringify(reason.error ?? reason).slice(0, 4096);
  }
  return void 0;
}
function qualifyRetainedDeepSeekCapture(input, sessionId, completed, manifestVersion) {
  const rootSessionId = required2(sessionId ?? "", "Retained DeepSeek root session ID");
  const records = input.records.map(({ record: record3 }) => record3);
  const children = /* @__PURE__ */ new Map();
  for (const observation2 of records) {
    const payload = record2(observation2.payload) ?? {};
    if (observation2.kind === "composition" && (!RETAINED_DEEPSEEK_SDK_VERSIONS.includes(String(record2(payload.runtime)?.clientVersion)) || record2(payload.runtime)?.clientVersion !== manifestVersion)) {
      throw new Error("Retained DeepSeek capture is unqualified: native client version differs from the run manifest or is not a supported retained runtime.");
    }
    if (observation2.kind === "notification" && ["subagent.started", "subagent.finished"].includes(observation2.method ?? "") && typeof payload.parentSessionId === "string" && typeof payload.childSessionId === "string") {
      children.set(payload.parentSessionId, [...children.get(payload.parentSessionId) ?? [], payload.childSessionId]);
    }
  }
  const allowed = /* @__PURE__ */ new Set([rootSessionId]);
  const pending = [rootSessionId];
  for (const parent of pending) for (const child of children.get(parent) ?? []) {
    if (!allowed.has(child)) {
      allowed.add(child);
      pending.push(child);
    }
  }
  for (const observation2 of records) {
    const payload = record2(observation2.payload) ?? {};
    if ([observation2.sessionId, payload.sessionId, payload.parentSessionId, payload.childSessionId].some((id) => typeof id === "string" && !allowed.has(id)) || typeof payload.sessionId === "string" && observation2.sessionId !== payload.sessionId) {
      throw new Error("Retained DeepSeek capture is unqualified: unrelated or contradictory native session identity.");
    }
  }
  let messageId;
  let receiptSequence;
  let idleSequence;
  for (const observation2 of records) {
    const payload = record2(observation2.payload) ?? {};
    if (observation2.kind === "response" && observation2.method === "session/prompt" && observation2.sessionId === rootSessionId) {
      messageId = typeof payload.messageId === "string" && payload.messageId.trim() !== "" ? payload.messageId : void 0;
    }
    if (observation2.kind !== "notification") continue;
    const notification = { method: observation2.method, params: payload };
    if (receiptSequence === void 0 && messageId !== void 0 && isInboxReceipt(notification, rootSessionId, messageId)) receiptSequence = observation2.sequence;
    if (receiptSequence !== void 0 && isRootIdle(notification, rootSessionId)) idleSequence = observation2.sequence;
  }
  if (messageId === void 0 || !records.some((observation2) => observation2.kind === "notification" && observation2.method === "session.event" && allowed.has(nativeSessionId(observation2) ?? ""))) {
    throw new Error("Retained DeepSeek capture is unqualified: root prompt receipt or related durable session evidence is missing.");
  }
  const qualification = deepSeekCaptureQualification(records, completed, receiptSequence, idleSequence);
  return { ...input, qualification: input.qualification === "qualified-with-gaps" ? input.qualification : qualification };
}
function deepSeekCaptureQualification(records, completed, receiptSequence, idleSequence, captureError) {
  if (captureError !== void 0) throw new Error(`DeepSeek capture is unqualified: ${captureError}`);
  const hasSessionEvent = records.some((record3) => record3.method === "session.event");
  const has = (kind, method) => records.some((record3) => record3.kind === kind && (method === void 0 || record3.method === method));
  const requiredBoundary = has("composition") && has("capability") && has("response", "initialize") && has("response", "session/prompt") && hasSessionEvent;
  if (!requiredBoundary) throw new Error("DeepSeek capture is unqualified: runtime, prompt receipt, or durable session evidence is missing.");
  const reap = records.find((observation2) => observation2.kind === "response" && observation2.method === "client.close" && record2(observation2.payload)?.status === "runtime-reaped");
  const complete = receiptSequence !== void 0 && idleSequence !== void 0 && reap !== void 0 && reap.sequence > idleSequence;
  if (completed && !complete) throw new Error("Completed DeepSeek capture lacks durable receipt-to-idle or clean runtime-reap evidence.");
  return complete ? "qualified" : "qualified-with-gaps";
}
var DEEPSEEK_CAPABILITY_PROFILE = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: DEEPSEEK_ADAPTER_ID,
  harness: DEEPSEEK_HARNESS_ID,
  nativeTypes: [
    "composition",
    "capability",
    "diagnostic",
    "error",
    "initialize",
    "session/prompt",
    "session.event",
    "session.status",
    "subagent.started",
    "subagent.finished",
    "client.close"
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "available" },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported" },
    delegation: { status: "available" },
    artifact: { status: "partial" },
    validation: { status: "partial" },
    runtime: { status: "available" },
    outcome: { status: "available" }
  },
  evidence: {
    nativeOrder: { status: "partial" },
    nativeTime: { status: "partial" },
    parentage: { status: "partial" },
    content: { status: "partial" }
  }
};
function normalizeDeepSeekCapture(input) {
  const eventBySessionSequence = /* @__PURE__ */ new Map();
  const mapped = input.records.flatMap(({ reference, record: record3 }) => {
    const family = eventFamily(record3);
    if (family === void 0) return [];
    const id = `${input.attemptId}-deepseek-${record3.sequence}`;
    const event = nativeSessionEvent(record3);
    const sessionId = nativeSessionId(record3);
    const nativeSequence = nativeSessionSequence(event);
    if (sessionId !== void 0 && nativeSequence !== void 0) {
      eventBySessionSequence.set(`${sessionId}:${nativeSequence}`, id);
    }
    return [{ reference, record: record3, family, id, event, sessionId, nativeSequence }];
  });
  const events = mapped.flatMap(({ reference, record: record3, family, id, event, sessionId, nativeSequence }) => {
    const sourceSequences = nativeSourceSequences(event);
    const known2 = sessionId === void 0 ? [] : sourceSequences.flatMap((sequence) => {
      const eventId = eventBySessionSequence.get(`${sessionId}:${sequence}`);
      return eventId === void 0 ? [] : [{ kind: "caused-by", eventId }];
    });
    const base = {
      schemaVersion: "ebo.uniform-event/v1",
      id,
      runId: input.runId,
      attemptId: input.attemptId,
      source: {
        harness: DEEPSEEK_HARNESS_ID,
        nativeType: record3.method ?? record3.kind,
        nativeReference: reference
      },
      nativeOrder: nativeSequence === void 0 || sessionId === void 0 ? { status: "known", value: record3.sequence, domain: "deepseek-sdk-observations" } : { status: "known", value: nativeSequence, domain: `deepseek-session:${sessionId}` },
      nativeTime: nativeSessionTime(event),
      actor: { kind: actorKind(record3, event) },
      family,
      phase: eventPhase(record3, event),
      scope: sessionId === void 0 ? { kind: "attempt", id: input.attemptId } : { kind: "session", id: sessionId },
      relations: {
        parent: { status: "unknown", reason: "native record does not declare a uniform parent event" },
        known: known2
      },
      attributes: eventAttributes2(record3, event),
      content: hasReferencedContent(record3, event) ? { status: "known", value: [{ nativeReference: { ...reference, recordLocator: `${reference.recordLocator}#/payload` } }] } : { status: "unknown", reason: "native record carries no mapped content" }
    };
    return [base, ...requestUsage2(base, event)];
  });
  const mappedReferences = new Set(mapped.map(({ reference }) => referenceKey6(reference)));
  return {
    events,
    unmapped: input.records.flatMap(({ reference, record: record3 }) => mappedReferences.has(referenceKey6(reference)) ? [] : [{ reference, reason: `native record ${record3.method ?? record3.kind} has no uniform mapping` }])
  };
}
function createDeepSeekHarnessAdapter() {
  return {
    capture: {
      id: DEEPSEEK_ADAPTER_ID,
      harness: DEEPSEEK_HARNESS_ID,
      capture: async ({ context, configuration, capture }) => {
        const result = await executeDeepSeekHarness(context, configuration, capture);
        return qualifiedDeepSeekCapture(context.run.id, context.attempt.id, result.evidence);
      }
    },
    normalization: {
      id: DEEPSEEK_ADAPTER_ID,
      harness: DEEPSEEK_HARNESS_ID,
      capabilityProfile: DEEPSEEK_CAPABILITY_PROFILE,
      normalize: async (input) => normalizeDeepSeekCapture(input)
    }
  };
}
function clientOptions(configuration) {
  const composition = configuration.composition;
  return {
    dshBin: composition.launch.runtimeArtifact.locator,
    profile: composition.launch.profile,
    patches: composition.patches.map(({ locator }) => locator),
    processCwd: composition.launch.processCwd,
    ...composition.launch.dshHome === void 0 ? {} : { dshHome: composition.launch.dshHome },
    env: {
      ...structuredClone(configuration.env),
      ...composition.launch.dshHome === void 0 ? {} : { DSH_HOME: composition.launch.dshHome }
    },
    ...configuration.requestTimeoutMs === void 0 ? {} : { requestTimeoutMs: configuration.requestTimeoutMs },
    ...configuration.shutdownTimeoutMs === void 0 ? {} : { shutdownTimeoutMs: configuration.shutdownTimeoutMs },
    ...configuration.disposeEofGraceMs === void 0 ? {} : { disposeEofGraceMs: configuration.disposeEofGraceMs },
    ...configuration.disposeGraceMs === void 0 ? {} : { disposeGraceMs: configuration.disposeGraceMs }
  };
}
function validateConfiguration(configuration, context) {
  assertArtifact("DeepSeek runtime composition", configuration.composition);
  if (configuration.composition.launch.command !== process.execPath || configuration.composition.runtime.clientVersion !== DEEPSEEK_SDK_VERSION || configuration.composition.runtime.protocolVersion !== DEEPSEEK_SDK_VERSION) {
    throw new Error("DeepSeek runtime composition does not match the pinned public client runtime.");
  }
  const expectedArgs = [
    configuration.composition.launch.runtimeArtifact.locator,
    "--profile",
    configuration.composition.launch.profile,
    ...configuration.composition.patches.flatMap(({ locator }) => ["--patch", locator])
  ];
  if (JSON.stringify(configuration.composition.launch.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("DeepSeek launch arguments do not match the retained runtime and patch artifacts.");
  }
  if (configuration.sessionId.trim() === "") throw new Error("DeepSeek session ID is required.");
  if (context.workspace?.status !== "ready" || context.workspace.path === void 0 || resolve6(context.workspace.path) !== resolve6(configuration.composition.workspaceCwd)) {
    throw new Error("DeepSeek runtime workspace must match the retained ready lifecycle workspace.");
  }
  for (const reference of [
    configuration.composition.cordis,
    configuration.composition.launch.runtimeArtifact,
    ...configuration.composition.patches,
    ...configuration.composition.plugins.flatMap(({ configuration: value }) => value ?? []),
    ...configuration.composition.telemetry.artifact === void 0 ? [] : [configuration.composition.telemetry.artifact]
  ]) verifyFileReference(reference);
  const keys = Object.keys(configuration.env).sort();
  const allowed = configuration.composition.environment.allowedKeys;
  if (keys.some((key) => !allowed.includes(key))) throw new Error("DeepSeek child environment contains a key outside the recorded policy.");
  const suppliedHome = configuration.env.DSH_HOME;
  const retainedHome = configuration.composition.launch.dshHome;
  if (retainedHome !== void 0 && !allowed.includes("DSH_HOME")) {
    throw new Error("DeepSeek effective child DSH_HOME is outside the recorded environment allowlist.");
  }
  if (retainedHome === void 0 ? suppliedHome !== void 0 : suppliedHome !== void 0 && resolve6(suppliedHome) !== resolve6(retainedHome)) {
    throw new Error("DeepSeek child DSH_HOME does not match the retained runtime composition.");
  }
}
function verifyFileReference(reference) {
  if (digestString3(readFileSync3(reference.locator)) !== reference.digest) {
    throw new Error(`DeepSeek configuration digest mismatch for ${reference.locator}.`);
  }
}
function digestString3(bytes) {
  return `sha256:${digestBytes(bytes).value}`;
}
function assertArtifact(label, document) {
  const errors = validateArtifact(label, document);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}
function required2(value, label) {
  if (value.trim() === "") throw new Error(`${label} is required.`);
  return value;
}
var DeepSeekActivityTimeoutError = class extends Error {
};
var DeepSeekInterruptedError = class extends Error {
};
function throwIfAborted(signal) {
  if (signal.aborted) throw new DeepSeekInterruptedError("DeepSeek activity was interrupted.");
}
async function nextNotification(subscription, signal, deadline) {
  if (signal.aborted) throw new DeepSeekInterruptedError("DeepSeek activity was interrupted.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DeepSeekActivityTimeoutError("DeepSeek activity interval timed out.");
  let timer;
  let abort;
  try {
    return await Promise.race([
      subscription.next(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeepSeekActivityTimeoutError("DeepSeek activity interval timed out.")), remaining);
      }),
      new Promise((_resolve, reject) => {
        abort = () => reject(new DeepSeekInterruptedError("DeepSeek activity was interrupted."));
        signal.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    if (abort !== void 0) signal.removeEventListener("abort", abort);
  }
}
function isInboxReceipt(notification, sessionId, messageId) {
  if (notification.method !== "session.event" || notification.params.sessionId !== sessionId) return false;
  const event = record2(notification.params.event);
  const data = record2(event?.data);
  return event?.type === "agent/inbox/spliced" && Array.isArray(data?.inserted) && data.inserted.some((message) => record2(message)?.id === messageId);
}
function isRootIdle(notification, sessionId) {
  return notification.method === "session.status" && notification.params.sessionId === sessionId && notification.params.status === "idle";
}
function notificationIdentity(notification) {
  if (notification.method === "session.event") {
    const event = record2(notification.params.event);
    return typeof event?.seq === "number" ? String(event.seq) : void 0;
  }
  for (const key of ["childSessionId", "sessionId"]) {
    if (typeof notification.params[key] === "string") return notification.params[key];
  }
  return void 0;
}
function notificationSessionId(notification, rootSessionId) {
  if (typeof notification.params.sessionId === "string") return notification.params.sessionId;
  if (typeof notification.params.childSessionId === "string") return notification.params.childSessionId;
  return rootSessionId;
}
function relatedSessionIds(records, rootSessionId) {
  const ids = /* @__PURE__ */ new Set();
  for (const observation2 of records) {
    const payload = record2(observation2.payload);
    for (const value of [observation2.sessionId, payload?.sessionId, payload?.childSessionId, payload?.parentSessionId]) {
      if (typeof value === "string" && value !== rootSessionId) ids.add(value);
    }
  }
  return [...ids].sort();
}
function eventFamily(recordValue) {
  if (["composition", "capability", "diagnostic"].includes(recordValue.kind)) return "runtime";
  if (recordValue.kind === "error") return "outcome";
  if (["initialize", "session/prompt", "session.status", "client.close"].includes(recordValue.method ?? "")) return "runtime";
  if (["subagent.started", "subagent.finished"].includes(recordValue.method ?? "")) return "delegation";
  if (recordValue.method !== "session.event") return void 0;
  const type = nativeSessionEvent(recordValue)?.type;
  if (typeof type !== "string") return void 0;
  if (type.startsWith("user/") || type.startsWith("assistant/")) return "message";
  if (type.startsWith("tool/")) return "tool";
  if (type.startsWith("request/")) return "model-request";
  if (type.startsWith("compaction/") || type === "session/end-seed") return "context";
  if (type.startsWith("validation/")) return "validation";
  if (type.startsWith("artifact/")) return "artifact";
  if (type === "turn/end") return "outcome";
  if (type.startsWith("turn/") || type.startsWith("step/") || type.startsWith("hook/") || type === "agent/inbox/spliced") return "runtime";
  return void 0;
}
function requestUsage2(message, event) {
  const data = record2(event?.data);
  const usage = record2(data?.usage);
  if (event?.type !== "assistant/message" || usage === void 0) return [];
  const attributes = {};
  for (const [target, source] of [
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["cacheReadInputTokens", "cacheReadTokens"],
    ["cacheCreationInputTokens", "cacheWriteTokens"],
    ["reasoningOutputTokens", "reasoningTokens"]
  ]) {
    const value = usage[source];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) attributes[target] = value;
  }
  if (Object.keys(attributes).length === 0) return [];
  for (const key of ["turn", "step"]) addAttribute(attributes, key, data?.[key]);
  return [{
    ...message,
    id: `${message.id}:usage`,
    family: "runtime",
    phase: "after",
    relations: { parent: message.relations.parent, known: [{ kind: "caused-by", eventId: message.id }] },
    attributes: { ...attributes, resourceSemantics: "increment", usageScope: "assistant" },
    content: { status: "known", value: [{ nativeReference: { ...message.source.nativeReference, recordLocator: `${message.source.nativeReference.recordLocator}#/payload/event/data/usage` } }] }
  }];
}
function nativeSessionEvent(recordValue) {
  if (recordValue.method !== "session.event") return void 0;
  return record2(record2(recordValue.payload)?.event);
}
function nativeSessionId(recordValue) {
  const payload = record2(recordValue.payload);
  return typeof payload?.sessionId === "string" ? payload.sessionId : recordValue.sessionId;
}
function nativeSessionSequence(event) {
  return Number.isSafeInteger(event?.seq) && event?.seq >= 0 ? event?.seq : void 0;
}
function nativeSessionTime(event) {
  if (typeof event?.time !== "number" || !Number.isFinite(event.time)) {
    return { status: "unknown", reason: "native record carries no valid event time" };
  }
  const timestamp = new Date(event.time);
  return Number.isNaN(timestamp.valueOf()) ? { status: "unknown", reason: "native event time is outside the supported timestamp range" } : { status: "known", value: timestamp.toISOString() };
}
function nativeSourceSequences(event) {
  return Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs.filter((value) => Number.isSafeInteger(value) && value >= 0) : [];
}
function actorKind(recordValue, event) {
  const type = typeof event?.type === "string" ? event.type : "";
  if (type.startsWith("user/")) return "user";
  if (type.startsWith("assistant/") || type.startsWith("request/")) return "model";
  if (type.startsWith("tool/")) return "tool";
  if (recordValue.method?.startsWith("subagent.")) return "agent";
  return "harness";
}
function eventPhase(recordValue, event) {
  const type = typeof event?.type === "string" ? event.type : recordValue.method ?? "";
  if (type.endsWith("/start") || recordValue.kind === "request") return "before";
  if (type.endsWith("/end") || type.endsWith("/result") || recordValue.kind === "response") return "after";
  if (type === "session.status") return "during";
  return "instant";
}
function eventAttributes2(recordValue, event) {
  const data = record2(event?.data);
  const attributes = {
    recordKind: recordValue.kind,
    ...recordValue.method === void 0 ? {} : { method: recordValue.method }
  };
  addAttribute(attributes, "eventType", event?.type);
  addAttribute(attributes, "eventSeq", event?.seq);
  addAttribute(attributes, "surface", event === void 0 ? void 0 : Object.hasOwn(event, "surfaceOp") ? "surface" : "log-only");
  addAttribute(attributes, "surfaceOp", typeof event?.surfaceOp === "string" ? event.surfaceOp : record2(event?.surfaceOp)?.op);
  for (const key of ["turn", "step", "callId", "name", "status", "reason"]) addAttribute(attributes, key, data?.[key]);
  if (event?.type === "tool/call") {
    addAttribute(attributes, "toolName", data?.name);
    if (data?.arguments !== void 0) attributes.inputDigest = `sha256:${digestBytes(Buffer.from(canonicalizeMetadata(data.arguments))).value}`;
  }
  if (event?.type === "tool/result") {
    const message = record2(data?.message);
    const parts = Array.isArray(message?.content) ? message.content.map(record2) : [];
    addAttribute(attributes, "callId", data?.callId ?? record2(message?.source)?.callId ?? parts[0]?.toolCallId);
    if (parts.some((part) => typeof part?.isError === "boolean")) attributes.isError = parts.some((part) => part?.isError === true);
    const output = parts.flatMap((part) => Array.isArray(part?.content) ? part.content.flatMap((block) => typeof record2(block)?.text === "string" ? [record2(block).text] : []) : typeof part?.content === "string" ? [part.content] : []).join("");
    const exit = /\n?\[exit code: (-?\d+)\]\s*$/u.exec(output);
    if (exit !== null) attributes.exitCode = Number(exit[1]);
  }
  return attributes;
}
function addAttribute(target, key, value) {
  if (typeof value === "string" && value.length <= 512 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") {
    target[key] = value;
  }
}
function hasReferencedContent(recordValue, event) {
  if (recordValue.method === "session/prompt" && recordValue.kind === "request") return true;
  const type = typeof event?.type === "string" ? event.type : "";
  return type.startsWith("user/") || type.startsWith("assistant/") || type.startsWith("tool/") || type.startsWith("compaction/") || type.startsWith("request/") || type.startsWith("validation/");
}
function sanitizedError(error, sensitiveValues) {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const value of sensitiveValues) if (value !== "") message = message.replaceAll(value, "[redacted]");
  return Buffer.from(message).subarray(0, 64 * 1024).toString("utf8");
}
function extractStderr(message) {
  const marker = "stderr tail:\n";
  const index = message.lastIndexOf(marker);
  return index < 0 ? void 0 : message.slice(index + marker.length);
}
function withoutStderr(message) {
  const index = message.lastIndexOf("stderr tail:\n");
  return index < 0 ? message : message.slice(0, index).trimEnd();
}
function errorName(error) {
  return error instanceof Error ? error.name : "Error";
}
function record2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function referenceKey6(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}

// src/cursor-sdk.ts
import { createHash as createHash5 } from "node:crypto";
init_artifacts();
import { dirname as dirname4, join as join3, parse, resolve as resolve7 } from "node:path";
import {
  Agent,
  Cursor,
  JSONL_LOCAL_AGENT_STORE_FILES,
  JsonlLocalAgentStore
} from "@cursor/sdk";
init_scheduler();
var CURSOR_SDK_VERSION = "1.0.37";
var RETAINED_CURSOR_SDK_VERSIONS = [CURSOR_SDK_VERSION, "1.0.31"];
var CURSOR_SDK_HARNESS = "cursor-sdk";
var CURSOR_SDK_ADAPTER_ID = "ebo-cursor-sdk-v1";
var CURSOR_SDK_ADAPTER_VERSION = "0.1.0";
var CURSOR_NATIVE_SCHEMA_VERSION = "ebo.cursor-native-record/v1";
var MAX_NATIVE_RECORD_BYTES = 16 * 1024 * 1024;
var STREAM_TYPES = ["assistant", "request", "status", "system", "task", "thinking", "tool_call", "usage", "user"];
var NATIVE_TYPES = [
  "configuration",
  "agent-created",
  "run-created",
  "delta",
  "step",
  "terminal",
  "history",
  "billing",
  "usage-snapshot",
  "error",
  "cleanup",
  ...STREAM_TYPES.map((type) => `stream:${type}`),
  "stream:unknown",
  "store:agent",
  "store:run",
  "store:run-event",
  "store:checkpoint",
  "store:unknown"
];
var CURSOR_SDK_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: CURSOR_SDK_ADAPTER_ID,
  harness: CURSOR_SDK_HARNESS,
  nativeTypes: NATIVE_TYPES,
  families: {
    message: { status: "available", detail: "SDK stream user and assistant messages are authoritative for message projection." },
    "model-request": { status: "unsupported", detail: "The SDK does not expose source-native inference request boundaries." },
    tool: { status: "available", detail: "SDK stream tool_call records are authoritative; detailed callbacks and store history remain overlap evidence." },
    context: { status: "partial", detail: "Detailed summary and nested-task callback records remain native and are not semantically reconstructed." },
    permission: { status: "unsupported", detail: "The public SDK does not expose individual local approval decisions." },
    delegation: { status: "partial", detail: "Task tool records are retained as tool operations without inventing subagent lifecycle boundaries." },
    artifact: { status: "unsupported", detail: "Tool names express intent, not verified mutations; retained workspace outcome remains authoritative." },
    validation: { status: "unsupported", detail: "No validation is inferred from shell command text." },
    runtime: { status: "available", detail: "Per-turn stream usage is projected as increments; cumulative run and billing readbacks remain separate." },
    outcome: { status: "available", detail: "run.wait() is authoritative; stream EOF is never treated as completion." }
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Serialized callback/stream receipt order is retained and labeled as adapter receipt order." },
    nativeTime: { status: "partial", detail: "Adapter receipt timestamps are retained separately; absent source timestamps remain unknown." },
    parentage: { status: "partial", detail: "Stable agent, run, and tool-call identities are retained where exposed." },
    content: { status: "partial", detail: "Content stays in restricted native records and normalized events carry references only." }
  }
};
async function createCursorSdkBehaviorEvidence(bundleRoot) {
  const manifest = JSON.parse(readBoundedFile(join3(resolve7(bundleRoot), "manifest.json"), "Run manifest").toString("utf8"));
  const retainedVersion = manifest.run.harness.version;
  if (manifest.run.harness.id !== CURSOR_SDK_HARNESS || !RETAINED_CURSOR_SDK_VERSIONS.includes(retainedVersion) || !manifest.run.runtime.some(({ source, name, version }) => source === "cursor" && name === "cursor-sdk" && version === retainedVersion)) {
    throw new Error(`Unsupported retained Cursor SDK runtime ${manifest.run.harness.version}.`);
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  const manifestRecord = outcomeCapture.records.find(({ record: record3 }) => record3.kind === "manifest")?.record.document;
  const capture = {
    runId: outcomeCapture.runId,
    attemptId: outcomeCapture.attemptId,
    qualification: outcomeCapture.qualification,
    records: outcomeCapture.records.filter(({ record: record3 }) => record3.kind === "session").map(({ reference, record: record3 }) => {
      assertCursorRecord(record3.document, reference);
      return { reference, record: record3.document };
    })
  };
  assertRetainedCursorIdentity(manifest, capture.records.map(({ record: record3 }) => record3));
  const normalization = normalizeCursorSdkCapture(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: CURSOR_SDK_CAPABILITIES,
    adapterVersion: CURSOR_SDK_ADAPTER_VERSION,
    nativeType: cursorNativeType
  });
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver(outcomeCapture));
  const coverage = await validateNormalizedDataset(dataset, resolver);
  if (manifestRecord === void 0) throw new Error("Retained Cursor bundle omits terminal outcome metadata.");
  return { capture, outcomeCapture, dataset, resolver, coverage };
}
function assertRetainedCursorIdentity(manifest, records) {
  const envelopes = records.filter((record3) => record3.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION);
  const byChannel = (channel) => envelopes.filter((record3) => record3.channel === channel);
  const configurations = byChannel("configuration");
  const agents = byChannel("agent-created");
  const runs = byChannel("run-created");
  const terminals = byChannel("terminal");
  if (configurations.length !== 1 || agents.length !== 1 || runs.length !== 1 || terminals.length !== 1) {
    throw new Error("Retained Cursor capture requires one configuration, agent, run, and terminal record.");
  }
  const sessionId = manifest.run.native?.sessionId;
  const agentId = text6(agents[0].agentId) ?? text6(asRecord3(agents[0].payload)?.agentId);
  const runId = text6(runs[0].runId) ?? text6(asRecord3(runs[0].payload)?.runId);
  if (sessionId === void 0 || agentId !== sessionId || runId === void 0) {
    throw new Error("Retained Cursor agent/run identity differs from the run manifest.");
  }
  for (const record3 of envelopes) {
    if (record3.agentId !== void 0 && record3.agentId !== agentId || record3.sessionId !== void 0 && record3.sessionId !== sessionId || record3.runId !== void 0 && record3.runId !== runId) {
      throw new Error("Retained Cursor native envelope contains a foreign agent/run identity.");
    }
  }
  const configuration = asRecord3(configurations[0].payload);
  const configuredModel = configuration?.model;
  if (configuration?.sdkVersion !== manifest.run.harness.version || modelId(configuredModel) !== manifest.run.model.id || configuration?.workingDirectoryPolicy !== "isolated-local.cwd" || !Array.isArray(configuration?.environmentKeys) || configuration.environmentKeys.some((key) => typeof key !== "string")) {
    throw new Error("Retained Cursor configuration differs from the effective run manifest or policy.");
  }
  const runPayload = asRecord3(runs[0].payload);
  const terminal = asRecord3(asRecord3(terminals[0].payload)?.result);
  if (runPayload?.runId !== runId || runPayload.agentId !== agentId || !sameModelSelection(runPayload.model, configuredModel) || terminal?.id !== runId || !sameModelSelection(terminal.model, configuredModel) || !["finished", "cancelled", "error"].includes(String(terminal.status))) {
    throw new Error("Retained Cursor terminal/model identity differs from the owned run.");
  }
  for (const record3 of byChannel("stream")) {
    const message = asRecord3(asRecord3(record3.payload)?.message);
    if (message?.agent_id !== agentId || message.run_id !== runId) {
      throw new Error("Retained Cursor stream identity differs from the owned run.");
    }
  }
  const storeAgents = records.filter((record3) => cursorNativeType(record3) === "store:agent");
  const storeRuns = records.filter((record3) => cursorNativeType(record3) === "store:run");
  const storeEvents = records.filter((record3) => cursorNativeType(record3) === "store:run-event");
  const storeCheckpoints = records.filter((record3) => cursorNativeType(record3) === "store:checkpoint");
  if (storeAgents.length !== 1 || storeAgents[0].agentId !== agentId || storeRuns.length !== 1 || storeRuns[0].agentId !== agentId || storeRuns[0].runId !== runId || !sameModelSelection(storeRuns[0].model, configuredModel) || storeEvents.some((record3) => record3.runId !== runId) || storeCheckpoints.some((record3) => record3.agentId !== agentId)) {
    throw new Error("Retained Cursor native store identity differs from the owned agent/run/model.");
  }
  assertCheckpointCompleteness(storeAgents[0], storeRuns[0], storeCheckpoints, "Retained Cursor native store");
}
function normalizeCursorSdkCapture(input) {
  const events = [];
  const unmapped = [];
  for (const captured of input.records) {
    const mapped = mapCursorRecord(input, captured.reference, captured.record);
    events.push(...mapped);
    if (mapped.length === 0) unmapped.push({ reference: captured.reference, reason: unmappedCursorReason(captured.record) });
  }
  return { events, unmapped };
}
function mapCursorRecord(input, reference, record3) {
  if (record3.schemaVersion !== CURSOR_NATIVE_SCHEMA_VERSION) return [];
  const channel = record3.channel;
  const payload = asRecord3(record3.payload);
  const sequence = safeInteger(record3.sequence);
  if (typeof channel !== "string" || payload === void 0 || sequence === void 0) return [];
  const nativeType = cursorNativeType(record3);
  const base = (family, phase, discriminator) => ({
    schemaVersion: "ebo.uniform-event/v1",
    id: stableEventId2(input, reference, discriminator),
    runId: input.runId,
    attemptId: input.attemptId,
    source: { harness: CURSOR_SDK_HARNESS, nativeType, nativeReference: reference },
    nativeOrder: { status: "known", value: sequence, domain: "cursor-sdk-receipt" },
    nativeTime: { status: "unknown", reason: "Record time is adapter receipt time, not a source-native timestamp." },
    actor: { kind: "harness", ...text6(record3.agentId) === void 0 ? {} : { id: text6(record3.agentId) } },
    family,
    phase,
    scope: text6(record3.runId) === void 0 ? { kind: "session", ...text6(record3.sessionId) === void 0 ? {} : { id: text6(record3.sessionId) } } : { kind: "turn", id: text6(record3.runId) },
    relations: { parent: { status: "unknown", reason: "No source-native event parent is exposed for this record." }, known: [] },
    attributes: compactAttributes2({ timestampSemantics: "adapter-receipt", agentId: text6(record3.agentId), sessionId: text6(record3.sessionId), runId: text6(record3.runId) }),
    content: { status: "unknown", reason: "Native content remains in the restricted record." }
  });
  if (channel === "stream") {
    const message = asRecord3(payload.message);
    const type = text6(message?.type);
    if (message === void 0 || type === void 0) return [];
    if (type === "assistant" || type === "user") {
      const event = base("message", "instant", type);
      event.actor = { kind: type === "user" ? "user" : "model", ...type === "assistant" && text6(record3.agentId) !== void 0 ? { id: text6(record3.agentId) } : {} };
      event.content = knownContent2(contentReference2(reference, "", `${type}-message`));
      return [event];
    }
    if (type === "tool_call") {
      const callId = text6(message.call_id);
      const status = text6(message.status);
      const phase = status === "running" ? "before" : "after";
      const failed = status === "error" || asRecord3(message.result)?.status === "error";
      const event = base("tool", phase, `tool:${callId ?? sequence}:${status ?? "unknown"}`);
      event.actor = { kind: "tool", ...text6(message.name) === void 0 ? {} : { id: text6(message.name) } };
      event.scope = { kind: "operation", ...callId === void 0 ? {} : { id: callId } };
      event.attributes = compactAttributes2({
        ...event.attributes,
        operationId: callId,
        toolName: text6(message.name),
        toolStatus: status,
        inputDigest: message.args === void 0 ? void 0 : `sha256:${digestMetadata(message.args).value}`,
        failed: failed ? true : void 0
      });
      const content = [];
      if (message.args !== void 0) content.push(contentReference2(reference, "", "tool-input"));
      if (message.result !== void 0) content.push(contentReference2(reference, "", failed ? "tool-error" : "tool-result"));
      if (content.length > 0) event.content = knownContent2(...content);
      return [event];
    }
    if (type === "usage") {
      const usage = asRecord3(message.usage);
      if (usage === void 0) return [];
      const event = base("runtime", "instant", `usage:${sequence}`);
      event.attributes = compactAttributes2({
        ...event.attributes,
        resourceSemantics: "increment",
        inputTokens: nonnegativeInteger(usage.inputTokens),
        outputTokens: nonnegativeInteger(usage.outputTokens),
        cacheReadInputTokens: nonnegativeInteger(usage.cacheReadTokens),
        cacheCreationInputTokens: nonnegativeInteger(usage.cacheWriteTokens),
        totalTokens: nonnegativeInteger(usage.totalTokens),
        reasoningTokens: nonnegativeInteger(usage.reasoningTokens)
      });
      return [event];
    }
    if (type === "status" || type === "system") {
      const event = base("runtime", "instant", `${type}:${sequence}`);
      event.attributes = compactAttributes2({ ...event.attributes, status: text6(message.status), model: modelId(message.model) });
      return [event];
    }
    return [];
  }
  if (channel === "terminal") {
    const result = asRecord3(payload.result);
    if (result === void 0) return [];
    const event = base("outcome", "after", "terminal");
    event.attributes = compactAttributes2({
      ...event.attributes,
      status: text6(result.status),
      model: modelId(result.model),
      durationMs: nonnegativeNumber(result.durationMs),
      resourceSemantics: nonnegativeNumber(result.durationMs) === void 0 ? void 0 : "cumulative-final"
    });
    return [event];
  }
  return [];
}
function assertCheckpointCompleteness(agent, run, checkpoints, label) {
  const reference = (value, field) => {
    if (value === void 0 || value === null) return void 0;
    const record3 = asRecord3(value);
    if (record3?.schemaVersion !== 1 || typeof record3.rootBlobId !== "string" || record3.rootBlobId.trim() === "") {
      throw new Error(`${label} ${field} is malformed.`);
    }
    return record3.rootBlobId;
  };
  const required3 = [
    reference(agent.latestCheckpoint, "agent latest checkpoint"),
    reference(run.startCheckpointRef, "run start checkpoint"),
    reference(run.latestCheckpointRef, "run latest checkpoint")
  ].filter((value) => value !== void 0);
  const retained = new Set(checkpoints.map((checkpoint) => checkpoint.blobId));
  if (required3.some((blobId) => !retained.has(blobId))) {
    throw new Error(`${label} omits a referenced checkpoint blob.`);
  }
}
function assertCursorRecord(value, reference) {
  if (!isRecord8(value)) throw new Error(`Invalid retained Cursor record at ${reference.artifactId}:${reference.recordLocator}.`);
  if (value.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION) {
    const expectedLine = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
    if (!Number.isSafeInteger(value.sequence) || value.sequence !== expectedLine || value.sequence < 1 || typeof value.channel !== "string" || typeof value.receivedAt !== "string" || !isRecord8(value.payload)) {
      throw new Error(`Invalid retained Cursor envelope at ${reference.artifactId}:${reference.recordLocator}.`);
    }
    return;
  }
  const type = cursorNativeType(value);
  if (type === "store:agent" && typeof value.agentId === "string" && typeof value.cwd === "string" && typeof value.status === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)) return;
  if (type === "store:run" && typeof value.agentId === "string" && typeof value.runId === "string" && Number.isSafeInteger(value.turnNumber) && typeof value.status === "string" && Number.isFinite(value.createdAt) && Number.isFinite(value.updatedAt)) return;
  if (type === "store:run-event" && typeof value.runId === "string" && Number.isSafeInteger(value.seq) && typeof value.offset === "string" && typeof value.eventType === "string" && typeof value.createdAt === "string") return;
  if (type === "store:checkpoint" && typeof value.agentId === "string" && typeof value.blobId === "string" && typeof value.dataBase64 === "string") return;
  throw new Error(`Invalid retained Cursor store record at ${reference.artifactId}:${reference.recordLocator}.`);
}
function cursorNativeType(record3) {
  if (record3.schemaVersion === CURSOR_NATIVE_SCHEMA_VERSION) {
    if (record3.channel === "stream") {
      const type = text6(asRecord3(asRecord3(record3.payload)?.message)?.type);
      return STREAM_TYPES.includes(type ?? "") ? `stream:${type}` : "stream:unknown";
    }
    return typeof record3.channel === "string" && NATIVE_TYPES.includes(record3.channel) ? record3.channel : "error";
  }
  if (typeof record3.dataBase64 === "string" && typeof record3.blobId === "string") return "store:checkpoint";
  if (typeof record3.eventType === "string" && Number.isSafeInteger(record3.seq)) return "store:run-event";
  if (Number.isSafeInteger(record3.turnNumber) && typeof record3.runId === "string") return "store:run";
  if (typeof record3.cwd === "string" && typeof record3.agentId === "string") return "store:agent";
  return "store:unknown";
}
function unmappedCursorReason(record3) {
  const type = cursorNativeType(record3);
  if (type === "delta" || type === "step") return "Detailed callback evidence overlaps the authoritative stream projection and remains native.";
  if (type === "history" || type.startsWith("store:")) return "Durable native history remains authoritative evidence and is not counted as a second operation/message source.";
  if (type === "billing") return "Eventually consistent billing readback remains separate from per-turn token observations.";
  if (type === "usage-snapshot") return "Cumulative run.usage at finalization is retained separately, not added to per-turn token observations.";
  if (type === "stream:thinking") return "Hidden reasoning remains restricted native evidence and is never projected as semantic content.";
  return "Cursor native record is retained explicitly without a supported semantic mapping.";
}
function contentReference2(reference, pointer, role) {
  return { nativeReference: pointer === "" ? structuredClone(reference) : { artifactId: reference.artifactId, recordLocator: `${reference.recordLocator}#${pointer}` }, role };
}
function knownContent2(...value) {
  return { status: "known", value };
}
function stableEventId2(input, reference, discriminator) {
  return `cursor-${createHash5("sha256").update(JSON.stringify([input.runId, input.attemptId, reference, discriminator])).digest("hex").slice(0, 32)}`;
}
function compactAttributes2(values) {
  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== void 0));
}
function modelId(value) {
  return typeof value === "string" ? value : text6(asRecord3(value)?.id);
}
function sameModelSelection(value, expected) {
  const normalize = (candidate) => {
    if (typeof candidate === "string") return { id: candidate, params: [] };
    const record3 = asRecord3(candidate);
    if (record3 === void 0 || typeof record3.id !== "string" || !Array.isArray(record3.params)) {
      return record3 !== void 0 && typeof record3.id === "string" && record3.params === void 0 ? { id: record3.id, params: [] } : void 0;
    }
    if (record3.params.some((entry) => !isRecord8(entry) || typeof entry.id !== "string" || typeof entry.value !== "string")) return void 0;
    return {
      id: record3.id,
      params: record3.params.map(({ id, value: value2 }) => ({ id, value: value2 })).sort((left, right) => left.id.localeCompare(right.id) || left.value.localeCompare(right.value))
    };
  };
  return JSON.stringify(normalize(value)) === JSON.stringify(normalize(expected));
}
function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : void 0;
}
function text6(value) {
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function asRecord3(value) {
  return isRecord8(value) ? value : void 0;
}
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/retained-evidence.ts
init_scheduler();

// src/pi.ts
init_artifacts();
init_contracts();
import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION
} from "@earendil-works/pi-coding-agent";
init_scheduler();
init_task_packets();

// src/workspaces.ts
init_contracts();
init_task_packets();

// src/pi.ts
var PI_HARNESS = "pi-sdk";
var RETAINED_PI_ADAPTER_VERSIONS = ["1.0.0"];
var PI_NORMALIZATION_ADAPTER_VERSION = "1.0.0";
var PINNED_PI_SDK_VERSION = "1.1.0";
var RETAINED_PI_SDK_VERSIONS = [PINNED_PI_SDK_VERSION, "0.87.1", "0.85.1"];
var piCapabilityProfile = {
  schemaVersion: "ebo.adapter-capability-profile/v1",
  adapterId: `${PI_HARNESS}/v1`,
  harness: PI_HARNESS,
  nativeTypes: [
    "session",
    "history:message",
    "history:model_change",
    "history:thinking_level_change",
    "history:compaction",
    "history:branch_summary",
    "stream:agent_start",
    "stream:agent_end",
    "stream:agent_settled",
    "stream:turn_start",
    "stream:turn_end",
    "stream:message_start",
    "stream:message_update",
    "stream:message_end",
    "stream:tool_execution_start",
    "stream:tool_execution_update",
    "stream:tool_execution_end",
    "stream:compaction_start",
    "stream:compaction_end",
    "stream:auto_retry_start",
    "stream:auto_retry_end",
    "observer:session_start",
    "observer:session_shutdown",
    "observer:context",
    "observer:before_provider_request",
    "observer:before_provider_headers",
    "observer:after_provider_response",
    "observer:before_agent_start",
    "observer:tool_call",
    "observer:tool_result",
    "observer:session_before_compact",
    "observer:session_compact",
    "observer:session_compact_failed",
    "adapter:session_created",
    "adapter:capture_error",
    "adapter:cleanup"
  ],
  families: {
    message: { status: "available" },
    "model-request": { status: "partial", detail: "Available when the caller enables the passive observer." },
    tool: { status: "available" },
    context: { status: "available" },
    permission: { status: "unsupported", detail: "Pi's selected public SDK events do not expose a distinct permission decision record." },
    delegation: { status: "unsupported", detail: "Child-session/delegation histories are outside this one-session runner." },
    artifact: { status: "partial", detail: "Workspace outcome is authoritative; only tool events explicitly identify mutations." },
    validation: { status: "partial", detail: "Validation is identified only when the native tool name or command is explicit." },
    runtime: { status: "available" },
    outcome: { status: "available" }
  },
  evidence: {
    nativeOrder: { status: "partial", detail: "Pi history and subscription/observer records retain separate source-local order domains." },
    nativeTime: { status: "partial", detail: "History and message timestamps are native; other stream, observer and adapter records use the in-process receipt time, labeled by nativeTimeSource." },
    parentage: { status: "partial", detail: "Pi session entry IDs and parent IDs remain authoritative in native history." },
    content: { status: "partial", detail: "Native content remains restricted and is referenced rather than copied into uniform events." }
  }
};
async function normalizePiCapture(input) {
  const events = [];
  const unmapped = [];
  const retainedSessionId = input.records.flatMap(({ record: record3 }) => record3.type === "session" ? text7(record3.id) ?? [] : []).at(0) ?? input.records.flatMap(({ record: record3 }) => text7(record3.sessionId) ?? []).at(0);
  for (const captured of input.records) {
    const mapped = mapPiRecord(input, captured, retainedSessionId);
    events.push(...mapped);
    if (mapped.length === 0) unmapped.push({ reference: captured.reference, reason: piUnmappedReason(captured.record) });
  }
  return { events: correlateHistoryWithStream(events, input.records), unmapped };
}
function correlateHistoryWithStream(events, records) {
  const streamByKey = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (!event.source.nativeType.startsWith("stream:")) continue;
    const { toolCallId, responseId, messageTimestamp, role } = event.attributes;
    for (const key of [
      typeof toolCallId === "string" ? `tool:${toolCallId}` : void 0,
      typeof responseId === "string" ? `response:${responseId}` : void 0,
      typeof messageTimestamp === "number" && typeof role === "string" ? `message:${role}:${String(messageTimestamp)}` : void 0
    ]) if (key !== void 0) streamByKey.set(key, [...streamByKey.get(key) ?? [], event.id]);
  }
  const historyMessages = new Map(records.flatMap(({ reference, record: record3 }) => reference.artifactId === "pi-session" && isRecord9(record3.message) ? [[JSON.stringify([reference.artifactId, reference.recordLocator]), record3.message]] : []));
  return events.map((event) => {
    const message = historyMessages.get(JSON.stringify([event.source.nativeReference.artifactId, event.source.nativeReference.recordLocator]));
    if (message === void 0) return event;
    const toolCallIds = Array.isArray(message.content) ? message.content.flatMap((block) => isRecord9(block) && block.type === "toolCall" ? text7(block.id) ?? [] : []) : [];
    const keys = [
      ...toolCallIds.map((id) => `tool:${id}`),
      ...text7(message.toolCallId) === void 0 ? [] : [`tool:${text7(message.toolCallId)}`],
      ...text7(message.responseId) === void 0 ? [] : [`response:${text7(message.responseId)}`],
      ...number(message.timestamp) === void 0 || text7(message.role) === void 0 ? [] : [`message:${text7(message.role)}:${String(number(message.timestamp))}`]
    ];
    const linked = [...new Set(keys.flatMap((key) => streamByKey.get(key) ?? []))].filter((id) => !event.relations.known.some(({ eventId }) => eventId === id));
    return linked.length === 0 ? event : {
      ...event,
      relations: { ...event.relations, known: [...event.relations.known, ...linked.map((eventId) => ({ kind: "correlates-with", eventId }))] }
    };
  });
}
function mapPiRecord(input, captured, retainedSessionId) {
  const record3 = captured.record;
  const nativeType = piNativeType(record3);
  const envelope = record3.schemaVersion === "ebo.pi-native-record/v1";
  const channel = envelope ? text7(record3.channel) : void 0;
  const payload = envelope && isRecord9(record3.payload) ? record3.payload : record3;
  const sourceId = text7(record3.sessionId) ?? retainedSessionId ?? text7(payload.id) ?? input.attemptId;
  const order = envelope ? number(record3.sequence) : lineNumber(captured.reference.recordLocator);
  const payloadMessage = isRecord9(payload.message) ? payload.message : isRecord9(payload.error) ? payload.error : void 0;
  const originTimestamp = envelope ? millisTimestamp(payloadMessage?.timestamp) : text7(record3.timestamp) ?? millisTimestamp(payload.timestamp);
  const receiptTimestamp = envelope && payloadMessage?.timestamp === void 0 ? isoTimestamp(record3.receivedAt) : void 0;
  const timestamp = originTimestamp ?? receiptTimestamp;
  const common = {
    schemaVersion: "ebo.uniform-event/v1",
    runId: input.runId,
    attemptId: input.attemptId,
    source: { harness: PI_HARNESS, nativeType, nativeReference: structuredClone(captured.reference) },
    nativeOrder: order === void 0 ? { status: "unknown", reason: "Pi native order is unavailable" } : { status: "known", value: order, domain: envelope ? `pi-${channel ?? "adapter"}` : "pi-session" },
    nativeTime: timestamp === void 0 ? { status: "unknown", reason: envelope ? "Pi record has no origin or receipt timestamp" : "Pi history timestamp is unavailable" } : { status: "known", value: timestamp },
    relations: { parent: { status: "unknown", reason: "Native parent IDs remain in Pi session history" }, known: [] }
  };
  const event = (suffix, family, phase, actor, scope, attributes, content = true) => ({
    ...common,
    id: `pi-${captured.reference.artifactId}-${String(order ?? 0)}-${suffix}`,
    family,
    phase,
    actor,
    scope,
    attributes: { sessionId: sourceId, ...attributes, ...receiptTimestamp === void 0 ? {} : { nativeTimeSource: "adapter-receipt" } },
    content: content ? { status: "known", value: [{ nativeReference: structuredClone(captured.reference) }] } : { status: "unknown", reason: "No content is associated with this lifecycle record" }
  });
  if (!envelope) {
    if (record3.type === "session") return [event("session", "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { lifecycle: "session-start" }, false)];
    if (record3.type === "message" && isRecord9(record3.message)) {
      const message = record3.message;
      const role = text7(message.role);
      const actor = role === "assistant" ? { kind: "model", id: text7(message.model) } : role === "toolResult" || role === "bashExecution" ? { kind: "tool", id: text7(message.toolName) } : role === "user" ? { kind: "user" } : ["custom", "branchSummary", "compactionSummary"].includes(String(role)) ? { kind: "harness" } : void 0;
      if (actor === void 0) return [];
      const result = [event(`message-${text7(record3.id) ?? "entry"}`, "message", "after", actor, { kind: "session", id: sourceId }, {
        role: role ?? "unknown",
        entryId: text7(record3.id) ?? "unknown",
        ...messageIdentity(message)
      })];
      if ((role === "assistant" || role === "toolResult") && isRecord9(message.usage)) {
        result.push(event(
          `usage-${text7(record3.id) ?? "entry"}`,
          "runtime",
          "after",
          { kind: "harness" },
          { kind: "session", id: sourceId },
          { ...usageAttributes(message.usage, role), ...compactAttributes3({ responseId: text7(message.responseId) }) },
          false
        ));
      }
      return result;
    }
    if (record3.type === "compaction" || record3.type === "branch_summary") {
      const result = [event(`${String(record3.type)}-${text7(record3.id) ?? "entry"}`, "context", "after", { kind: "harness" }, { kind: "session", id: sourceId }, {
        boundary: String(record3.type),
        ...record3.type === "compaction" ? { subtype: "compact_boundary" } : {}
      })];
      if (isRecord9(record3.usage)) result.push(event(`usage-${text7(record3.id) ?? "entry"}`, "runtime", "after", { kind: "harness" }, { kind: "session", id: sourceId }, usageAttributes(record3.usage, String(record3.type)), false));
      return result;
    }
    if (record3.type === "model_change" || record3.type === "thinking_level_change") {
      return [event(`${String(record3.type)}-${text7(record3.id) ?? "entry"}`, "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { change: String(record3.type) })];
    }
    return [];
  }
  const kind = text7(record3.nativeType) ?? "unknown";
  if (channel === "stream") {
    if (["message_start", "message_end"].includes(kind)) {
      const message = isRecord9(payload.message) ? payload.message : void 0;
      const role = text7(message?.role) ?? "unknown";
      const actor = role === "assistant" ? { kind: "model" } : role === "toolResult" || role === "bashExecution" ? { kind: "tool" } : role === "user" ? { kind: "user" } : role === "custom" ? { kind: "harness" } : void 0;
      return actor === void 0 ? [] : [event(kind, "message", kind.endsWith("start") ? "before" : "after", actor, { kind: "session", id: sourceId }, { role, ...message === void 0 ? {} : messageIdentity(message) })];
    }
    if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(kind)) {
      const toolCallId = text7(payload.toolCallId);
      const args = payload.args;
      return [event(
        kind,
        "tool",
        kind.endsWith("start") ? "before" : kind.endsWith("end") ? "after" : "during",
        { kind: "tool", id: text7(payload.toolName) },
        { kind: "operation", ...toolCallId === void 0 ? {} : { id: toolCallId } },
        compactAttributes3({
          toolCallId,
          toolName: text7(payload.toolName),
          inputDigest: args === void 0 ? void 0 : `sha256:${digestMetadata(args).value}`,
          isError: typeof payload.isError === "boolean" ? payload.isError : void 0
        })
      )];
    }
    if (["compaction_start", "compaction_end"].includes(kind)) return [event(kind, "context", kind.endsWith("start") ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, { boundary: "compaction", subtype: "compact_boundary" })];
    if (["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "auto_retry_start", "auto_retry_end"].includes(kind)) {
      const turnIndex = number(payload.turnIndex);
      const scope = kind.startsWith("turn") ? { kind: "turn", ...turnIndex === void 0 ? {} : { id: `${sourceId}:turn:${String(turnIndex)}` } } : { kind: "session", id: sourceId };
      return [event(
        kind,
        kind.startsWith("auto_retry") ? "context" : "runtime",
        kind.endsWith("start") ? "before" : "after",
        { kind: "harness" },
        scope,
        compactAttributes3({ lifecycle: kind, turnIndex })
      )];
    }
    return [];
  }
  if (channel === "observer") {
    if (kind === "before_provider_request") return [event(kind, "model-request", "before", { kind: "harness" }, { kind: "operation", id: `provider-${String(order ?? 0)}` }, { requestId: `provider-${String(order ?? 0)}`, observationStage: text7(record3.stage) ?? "pre-provider-request" })];
    if (["context", "before_agent_start"].includes(kind)) return [event(kind, "context", "before", { kind: "harness" }, { kind: "session", id: sourceId }, { observationStage: text7(record3.stage) ?? kind })];
    if (["session_before_compact", "session_compact", "session_compact_failed"].includes(kind)) {
      return [event(kind, "context", kind === "session_before_compact" ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, {
        observationStage: text7(record3.stage) ?? kind,
        subtype: "compact_boundary"
      })];
    }
    if (["session_start", "session_shutdown", "before_provider_headers", "after_provider_response"].includes(kind)) return [event(kind, "runtime", kind.endsWith("start") || kind.startsWith("before") ? "before" : "after", { kind: "harness" }, { kind: "session", id: sourceId }, { observationStage: text7(record3.stage) ?? kind })];
    return [];
  }
  if (channel === "adapter") return [event(kind, kind === "capture_error" ? "outcome" : "runtime", "instant", { kind: "harness" }, { kind: "session", id: sourceId }, { lifecycle: kind })];
  return [];
}
function piNativeType(record3) {
  if (record3.schemaVersion === "ebo.pi-native-record/v1") return `${String(record3.channel)}:${String(record3.nativeType)}`;
  if (record3.type === "session") return "session";
  return `history:${String(record3.type)}`;
}
function assertPiNativeRecord(record3, line) {
  if (!isRecord9(record3) || !Number.isSafeInteger(line) || line < 1) throw new Error(`Invalid retained Pi native record at line ${line}.`);
  if (record3.schemaVersion === "ebo.pi-native-record/v1") {
    if (!Number.isSafeInteger(record3.sequence) || record3.sequence !== line || !["stream", "observer", "adapter"].includes(String(record3.channel)) || text7(record3.nativeType) === void 0 || text7(record3.receivedAt) === void 0 || record3.payload === void 0) {
      throw new Error(`Invalid retained Pi native envelope at line ${line}.`);
    }
    return;
  }
  if (text7(record3.type) === void 0 || (record3.type === "session" ? line !== 1 || record3.version !== 3 || text7(record3.id) === void 0 || text7(record3.cwd) === void 0 : line === 1 || text7(record3.id) === void 0 || !(record3.parentId === null || text7(record3.parentId) !== void 0) || text7(record3.timestamp) === void 0)) {
    throw new Error(`Invalid retained Pi session entry at line ${line}.`);
  }
}
function qualifyRetainedPiCapture(capture, sessionId, expectsCompletion) {
  for (const { reference, record: record3 } of capture.records) assertPiNativeRecord(record3, lineNumber(reference.recordLocator) ?? 0);
  const history = capture.records.filter(({ reference }) => reference.artifactId === "pi-session").map(({ record: record3 }) => record3);
  const headers = history.filter(({ type }) => type === "session");
  if (sessionId === void 0 || headers.length !== 1 || headers[0].id !== sessionId) {
    throw new Error("Retained Pi session identity differs from the run manifest.");
  }
  const entryIds = /* @__PURE__ */ new Set();
  for (const record3 of history.filter(({ type }) => type !== "session")) {
    const id = text7(record3.id);
    if (entryIds.has(id) || record3.parentId !== null && !entryIds.has(String(record3.parentId))) {
      throw new Error("Retained Pi session history has duplicate or unresolved parent identities.");
    }
    entryIds.add(id);
  }
  const envelopeSessionIds = capture.records.flatMap(({ record: record3 }) => {
    const ids = [text7(record3.sessionId)];
    if (record3.channel === "observer" && isRecord9(record3.payload)) ids.push(text7(record3.payload.sessionId));
    return ids.filter((id) => id !== void 0);
  });
  if (envelopeSessionIds.some((id) => id !== sessionId)) throw new Error("Retained Pi stream identity differs from the native session.");
  if (capture.records.some(({ record: record3 }) => record3.channel === "observer" && record3.nativeType === "extension_error")) {
    throw new Error("Retained Pi capture contains a selected extension hook failure.");
  }
  if (expectsCompletion) {
    const settled = capture.records.filter(({ record: record3 }) => record3.channel === "stream" && record3.nativeType === "agent_settled");
    const lastAssistant = history.filter(({ type, message }) => type === "message" && isRecord9(message) && message.role === "assistant").at(-1)?.message;
    if (settled.length === 0 || settled.some(({ record: record3 }) => isRecord9(record3.payload) && record3.payload.aborted === true) || !isRecord9(lastAssistant) || !["stop", "length"].includes(String(lastAssistant.stopReason))) {
      throw new Error("Completed retained Pi capture lacks matching native settled terminal evidence.");
    }
    const historyCalls = new Set(history.flatMap(({ type, message }) => {
      if (type !== "message" || !isRecord9(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
      return message.content.flatMap((block) => isRecord9(block) && block.type === "toolCall" ? text7(block.id) ?? [] : []);
    }));
    const historyResults = new Set(history.flatMap(({ type, message }) => type === "message" && isRecord9(message) && message.role === "toolResult" ? text7(message.toolCallId) ?? [] : []));
    const streamIds = (nativeType) => new Set(capture.records.flatMap(({ record: record3 }) => record3.channel === "stream" && record3.nativeType === nativeType && isRecord9(record3.payload) ? text7(record3.payload.toolCallId) ?? [] : []));
    if (!sameTextSet(historyCalls, historyResults) || !sameTextSet(historyCalls, streamIds("tool_execution_start")) || !sameTextSet(historyCalls, streamIds("tool_execution_end"))) {
      throw new Error("Completed retained Pi capture has mismatched native history and streamed tool identities.");
    }
  }
  return capture;
}
function piUnmappedReason(record3) {
  const type = piNativeType(record3);
  if (type === "stream:message_update") return "Transient message delta retained natively; final history/message records own counted semantics";
  if (type === "stream:entry_appended") return "Persistence notification overlaps authoritative native session history";
  if (type === "observer:tool_call" || type === "observer:tool_result") return "Passive observer duplicate; subscription tool lifecycle owns normalized operation semantics";
  return `Pi native type ${type} is retained but has no uniform projection`;
}
function compactAttributes3(input) {
  return Object.fromEntries(Object.entries(input).filter((entry) => entry[1] !== void 0));
}
function sameTextSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
function messageIdentity(message) {
  const toolCallIds = Array.isArray(message.content) ? message.content.flatMap((block) => isRecord9(block) && block.type === "toolCall" ? text7(block.id) ?? [] : []) : [];
  return compactAttributes3({
    messageTimestamp: number(message.timestamp),
    responseId: text7(message.responseId),
    toolCallId: text7(message.toolCallId),
    toolName: message.role === "toolResult" ? text7(message.toolName) : void 0,
    // Attribute lists hold at most 16 values; relations to stream events carry every tool call.
    toolCallIds: toolCallIds.length > 0 && toolCallIds.length <= 16 ? toolCallIds : void 0
  });
}
function usageAttributes(usage, usageScope) {
  const cost = isRecord9(usage.cost) ? usage.cost : void 0;
  return compactAttributes3({
    inputTokens: number(usage.input),
    outputTokens: number(usage.output),
    cacheReadInputTokens: number(usage.cacheRead),
    cacheCreationInputTokens: number(usage.cacheWrite),
    reasoningOutputTokens: number(usage.reasoning),
    totalTokens: number(usage.totalTokens),
    totalCostUsd: number(cost?.total),
    resourceSemantics: "increment",
    usageScope
  });
}
function lineNumber(locator) {
  const match = locator.match(/^line:(\d+)$/u);
  return match === null ? void 0 : Number(match[1]);
}
function millisTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  const timestamp = new Date(value).toISOString();
  return Number.isNaN(Date.parse(timestamp)) ? void 0 : timestamp;
}
function isoTimestamp(value) {
  if (typeof value !== "string") return void 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? void 0 : new Date(parsed).toISOString();
}
function text7(value) {
  return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function isRecord9(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/retained-evidence.ts
async function createRetainedBehaviorEvidence(bundleRoot) {
  const manifest = JSON.parse(readBoundedFile(join4(bundleRoot, "manifest.json"), "Run manifest").toString("utf8"));
  if (manifest.schemaVersion === "ebo.import-manifest/v1") return readImportedBehaviorEvidence(bundleRoot);
  const harness = manifest.run.harness.id;
  if (harness === CURSOR_SDK_HARNESS) return createCursorSdkBehaviorEvidence(bundleRoot);
  const isAgentSdk = [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(harness) || manifest.run.runtime.some(({ source, name }) => source === "anthropic" && [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(name));
  if (isAgentSdk) {
    const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
    return { ...evidence, outcomeCapture: evidence.capture };
  }
  if (![CODEX_HARNESS, DEVIN_HARNESS, FACTORY_HARNESS, "openhands-agent-server", DEEPSEEK_HARNESS_ID, PI_HARNESS].includes(harness)) {
    throw new Error(`Unsupported retained harness ${harness}; refusing Agent SDK fallback normalization.`);
  }
  if (harness === "openhands-agent-server") openHandsCapabilityProfile(manifest.run.harness.version);
  if (harness === DEEPSEEK_HARNESS_ID && !RETAINED_DEEPSEEK_SDK_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained DeepSeek runtime ${manifest.run.harness.version}.`);
  }
  if (harness === DEVIN_HARNESS && !RETAINED_DEVIN_CLI_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained Devin runtime ${manifest.run.harness.version}.`);
  }
  if (harness === PI_HARNESS && !RETAINED_PI_SDK_VERSIONS.includes(manifest.run.harness.version)) {
    throw new Error(`Unsupported retained Pi runtime ${manifest.run.harness.version}.`);
  }
  if (harness === PI_HARNESS) {
    const expected = /* @__PURE__ */ new Map([
      ["pi-coding-agent", { source: "earendil-works", version: manifest.run.harness.version }],
      [PI_HARNESS, { source: "EBO", version: manifest.run.harness.version }]
    ]);
    for (const [name, identity] of expected) {
      const matches2 = manifest.run.runtime.filter((runtime) => runtime.name === name);
      if (matches2.length !== 1 || matches2[0].source !== identity.source || matches2[0].version !== identity.version) {
        throw new Error(`Retained Pi runtime identity ${name} differs from the pinned adapter manifest.`);
      }
    }
    const adapters = manifest.run.runtime.filter(({ name }) => name === "pi-sdk-adapter");
    if (adapters.length !== 1 || adapters[0].source !== "EBO" || !RETAINED_PI_ADAPTER_VERSIONS.includes(adapters[0].version)) {
      throw new Error("Retained Pi runtime identity pi-sdk-adapter differs from the supported capture adapter manifest.");
    }
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  const expectsCompletion = manifest.terminal.state === "completed" || manifest.terminal.failureClass === "task";
  const capture = {
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record: record3 }) => record3.kind === "session").map(({ reference, record: record3 }) => {
      const line = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
      if (harness === PI_HARNESS) assertPiNativeRecord(record3.document, line);
      else assertNativeEnvelope(harness, record3.document, line);
      return { reference, record: record3.document };
    })
  };
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver({
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record: record3 }) => record3.kind !== "session" && record3.kind !== "hook")
  }));
  let dataset;
  if (harness === PI_HARNESS) {
    const compositions = capture.records.filter(({ record: record3 }) => {
      const value = record3;
      return value.channel === "adapter" && value.nativeType === "session_created";
    }).map(({ record: record3 }) => record3);
    if (compositions.length !== 1) throw new Error(`Retained Pi capture has ${String(compositions.length)} native composition records; expected exactly one.`);
    if (compositions[0].payload?.sdk?.version !== manifest.run.harness.version) {
      throw new Error("Retained Pi native composition version differs from the run manifest.");
    }
    const native = qualifyRetainedPiCapture(capture, manifest.run.native?.sessionId, expectsCompletion);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({
      capture: native,
      normalization: await normalizePiCapture(native),
      capabilityProfile: piCapabilityProfile,
      adapterVersion: PI_NORMALIZATION_ADAPTER_VERSION,
      nativeType: piNativeType
    });
  } else if (harness === CODEX_HARNESS) {
    const native = capture;
    const handshakeVersions = native.records.filter(({ record: record3 }) => record3.kind === "response" && record3.source === CODEX_HARNESS && record3.method === "initialize").map(({ record: record3 }) => String(record3.payload?.userAgent ?? "").match(/^[^\s/]+\/([^\s]+)/u)?.[1]);
    const telemetryVersions = outcomeCapture.records.flatMap(({ record: record3 }) => {
      const document = record3.document;
      return document?.schemaVersion === "ebo.codex-telemetry/v1" ? [document.runtime?.version] : [];
    });
    if (handshakeVersions.length === 0 || [
      ...handshakeVersions,
      ...telemetryVersions,
      ...manifest.run.runtime.filter(({ name }) => name === CODEX_HARNESS).map(({ version }) => version)
    ].some((version) => version !== manifest.run.harness.version)) {
      throw new Error("Retained Codex native runtime version differs from the run manifest.");
    }
    let acceptedStartSequence = 0;
    const identities = (method, key) => {
      const accepted = native.records.filter(({ record: record3 }) => {
        const payload2 = record3.payload;
        return record3.kind === "response" && record3.source === CODEX_HARNESS && record3.method === method && typeof payload2?.[key]?.id === "string" && payload2[key].id.trim() !== "";
      });
      const optionalPartialTurn = key === "turn" && !expectsCompletion;
      if (accepted.length === 0 && optionalPartialTurn) return void 0;
      if (accepted.length !== 1) throw new Error(`Retained Codex ${method} requires one owned identity.`);
      const response = accepted[0].record;
      const requests = native.records.filter(({ record: record3 }) => record3.kind === "request" && record3.source === "ebo-codex-client" && record3.id === response.id);
      const responses = native.records.filter(({ record: record3 }) => record3.kind === "response" && record3.source === CODEX_HARNESS && record3.id === response.id);
      const request = requests[0]?.record;
      const payload = response.payload;
      if (response.id === void 0 || response.id === null || requests.length !== 1 || responses.length !== 1 || request?.method !== method || request.sequence <= acceptedStartSequence || request.sequence >= response.sequence || key === "turn" && (request.payload?.threadId !== native.threadId || payload.turn.threadId !== void 0 && payload.turn.threadId !== native.threadId)) {
        throw new Error(`Retained Codex ${method} requires a unique ordered owned request/response pair.`);
      }
      acceptedStartSequence = response.sequence;
      return payload[key].id;
    };
    native.threadId = identities("thread/start", "thread");
    native.turnId = identities("turn/start", "turn");
    if (native.threadId !== manifest.run.native?.sessionId) throw new Error("Retained Codex thread identity differs from the run manifest.");
    const terminals = native.records.filter(({ record: record3 }) => {
      const payload = record3.payload;
      return record3.kind === "notification" && record3.source === CODEX_HARNESS && record3.method === "turn/completed" && payload?.threadId === native.threadId && payload?.turn?.id === native.turnId;
    });
    if (terminals.length > 1 || terminals.some(({ record: record3 }) => record3.sequence <= acceptedStartSequence) || expectsCompletion && terminals[0]?.record.payload?.turn?.status !== "completed") {
      throw new Error("Retained Codex capture requires unambiguous matching owned terminal evidence.");
    }
    dataset = (await describeAndValidateCodexDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === FACTORY_HARNESS) {
    const expected = /* @__PURE__ */ new Map([[FACTORY_HARNESS, { source: "Factory", version: manifest.run.harness.version }]]);
    for (const [name, identity] of expected) {
      const matches2 = manifest.run.runtime.filter((runtime2) => runtime2.name === name);
      if (matches2.length !== 1 || matches2[0].source !== identity.source || matches2[0].version !== identity.version) {
        throw new Error(`Retained Factory runtime identity ${name} differs from the manifest.`);
      }
    }
    const adapters = manifest.run.runtime.filter(({ name }) => name === "factory-adapter");
    const sdks = manifest.run.runtime.filter(({ name }) => name === "@factory/droid-sdk");
    if (adapters.length !== 1 || adapters[0].source !== "EBO" || !RETAINED_FACTORY_ADAPTER_VERSIONS.includes(adapters[0].version) || sdks.length !== 1 || sdks[0].source !== "Factory" || !RETAINED_FACTORY_SDK_VERSIONS.includes(sdks[0].version)) {
      throw new Error("Retained Factory capture adapter or SDK version is unsupported or ambiguous.");
    }
    const captureAdapterVersion = adapters[0].version;
    const captureSdkVersion = sdks[0].version;
    const runtimeDocuments = outcomeCapture.records.filter(({ record: record3 }) => record3.kind === "telemetry").map(({ record: record3 }) => record3.document);
    const runtime = runtimeDocuments[0]?.runtime;
    if (runtimeDocuments.length !== 1 || runtimeDocuments[0]?.schemaVersion !== "ebo.factory-runtime/v1" || runtime?.version !== manifest.run.harness.version || runtime?.sdkVersion !== captureSdkVersion || runtime?.adapterVersion !== captureAdapterVersion) throw new Error("Retained Factory runtime document differs from the manifest.");
    if (runtimeDocuments[0]?.effectiveConfiguration?.model !== manifest.run.model.id) throw new Error("Retained Factory model differs from the run manifest.");
    const native = qualifyFactoryCapture(capture, {
      sessionId: manifest.run.native?.sessionId,
      expectsCompletion,
      cliVersion: manifest.run.harness.version,
      sdkVersion: runtime.sdkVersion,
      adapterVersion: captureAdapterVersion
    });
    const initialization = native.records.find(({ record: record3 }) => record3.source === "ebo-factory-client" && record3.method === "droid.initialize_session")?.record;
    const effective = runtimeDocuments[0].effectiveConfiguration;
    const selection = effective.modelSelection === void 0 ? factoryModelSelection(manifest.run.model.id) : factoryModelSelection(effective.modelSelection.model, effective.modelSelection.route);
    if (selection.model !== manifest.run.model.id || effective.modelSelection !== void 0 && digestMetadata(selection).value !== digestMetadata(effective.modelSelection).value) throw new Error("Retained Factory model route is invalid.");
    if (effective.settings?.modelId !== void 0 && effective.settings.modelId !== selection.nativeModelId) throw new Error("Retained Factory effective selector differs from its route.");
    if (initialization !== void 0 && initialization.payload?.params?.modelId !== selection.nativeModelId) throw new Error("Retained Factory initialization model differs from the manifest.");
    const composition = native.records.find(({ record: record3 }) => record3.capability === "runtime-composition")?.record.evidence;
    if (selection.route.kind === "byok" && (effective.customModelSource !== "attempt-settings-override" || composition?.customModelSource !== "attempt-settings-override")) throw new Error("Retained Factory BYOK route lacks an attempt-owned settings override.");
    if (effective.modelSelection !== void 0 && digestMetadata(composition?.modelSelection ?? null).value !== digestMetadata(selection).value) throw new Error("Retained Factory route differs from recorded composition.");
    if (composition?.binaryDigest !== runtime.binaryDigest || composition?.protocolVersion !== runtime.protocolVersion) {
      throw new Error("Retained Factory runtime digest or protocol differs from native composition.");
    }
    dataset = (await describeAndValidateFactoryDataset(native)).dataset;
  } else if (harness === DEVIN_HARNESS) {
    const telemetryDocuments = outcomeCapture.records.filter(({ record: record3 }) => record3.kind === "telemetry").map(({ record: record3 }) => record3.document);
    if (telemetryDocuments.length !== 1 || telemetryDocuments[0]?.schemaVersion !== "ebo.devin-telemetry/v1") {
      throw new Error("Retained Devin capture requires exactly one recognized ebo.devin-telemetry/v1 runtime document.");
    }
    const telemetryVersion = telemetryDocuments[0].runtime?.version;
    if (typeof telemetryVersion !== "string") throw new Error("Retained Devin runtime document lacks a native runtime version.");
    const runtimeVersions = manifest.run.runtime.filter(({ name }) => name === DEVIN_HARNESS).map(({ version }) => version);
    if (runtimeVersions.length !== 1) throw new Error("Retained Devin runtime identity devin-cli differs from the pinned adapter manifest.");
    const native = qualifyRetainedDevinCapture(capture, {
      sessionId: manifest.run.native?.sessionId,
      expectsCompletion,
      harnessVersion: manifest.run.harness.version,
      runtimeVersions: [telemetryVersion, ...runtimeVersions]
    });
    dataset = (await describeAndValidateDevinDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === "openhands-agent-server") {
    const native = capture;
    const sessionId = manifest.run.native?.sessionId;
    const serverInfo = native.records.filter(({ record: record3 }) => record3.channel === "server-info");
    if (serverInfo.length !== 1) throw new Error("Retained OpenHands capture requires exactly one native server-info record.");
    for (const { record: record3 } of native.records) {
      if (record3.channel === "server-info" && record3.payload.version !== manifest.run.harness.version) {
        throw new Error("Retained OpenHands native server version differs from the run manifest.");
      }
      if (record3.session_id !== void 0 && record3.session_id !== sessionId || ["conversation-created", "websocket-status", "websocket-event", "rest-event", "conversation-final"].includes(record3.channel) && (sessionId === void 0 || record3.session_id !== sessionId) || ["conversation-created", "conversation-final"].includes(record3.channel) && record3.payload.id !== sessionId) {
        throw new Error("Retained OpenHands conversation identity differs from the run manifest.");
      }
    }
    const finals = native.records.filter(({ record: record3 }) => record3.channel === "conversation-final");
    if (expectsCompletion && (finals.length !== 1 || finals[0].record.payload.execution_status !== "finished")) {
      throw new Error("Completed retained OpenHands capture lacks owned finished conversation evidence.");
    }
    dataset = describeNormalizedDataset({
      capture: native,
      normalization: await normalizeOpenHandsCapture(native),
      capabilityProfile: openHandsCapabilityProfile(manifest.run.harness.version),
      adapterVersion: manifest.run.harness.version,
      nativeType: (record3) => typeof record3.payload.kind === "string" ? record3.payload.kind : record3.channel
    });
  } else {
    const native = qualifyRetainedDeepSeekCapture(
      capture,
      manifest.run.native?.sessionId,
      expectsCompletion,
      manifest.run.harness.version
    );
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({
      capture: native,
      normalization: normalizeDeepSeekCapture(native),
      capabilityProfile: createDeepSeekHarnessAdapter().normalization.capabilityProfile,
      adapterVersion: manifest.run.harness.version,
      nativeType: (record3) => record3.method ?? record3.kind
    });
  }
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, outcomeCapture, dataset, resolver, coverage };
}
function assertNativeEnvelope(harness, value, line) {
  const fail = () => {
    throw new Error(`Invalid retained ${harness} native envelope at line ${line}.`);
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record3 = value;
  if (!Number.isSafeInteger(line) || line < 1 || record3.sequence !== line) fail();
  if (harness === FACTORY_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== FACTORY_HARNESS && value.source !== "ebo-factory-client") fail();
    return;
  }
  if (harness === DEVIN_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== DEVIN_HARNESS && value.source !== "ebo-devin-client") fail();
    if (value.source === "ebo-devin-client" && (!["request", "response", "notification"].includes(value.kind) || value.kind === "notification" && value.method !== "session/cancel")) fail();
    return;
  }
  if (harness === CODEX_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== CODEX_HARNESS && value.source !== "ebo-codex-client") fail();
    if (value.source === "ebo-codex-client" && (!["request", "response", "notification"].includes(value.kind) || value.kind === "notification" && value.method !== "initialized")) fail();
    return;
  }
  const optionalText = (fields) => fields.every((field) => record3[field] === void 0 || typeof record3[field] === "string" && record3[field].trim() !== "");
  if (harness === "openhands-agent-server") {
    if (record3.schemaVersion !== "ebo.openhands-native-record/v1" || !["server-info", "conversation-create-response", "conversation-created", "websocket-status", "websocket-event", "conversation-final", "rest-event", "capture-error", "cleanup"].includes(String(record3.channel)) || record3.payload === null || typeof record3.payload !== "object" || Array.isArray(record3.payload) || !optionalText(["session_id"]) || record3.channelSequence !== void 0 && (typeof record3.channelSequence !== "number" || !Number.isSafeInteger(record3.channelSequence) || record3.channelSequence < 0)) fail();
    return;
  }
  if (record3.schemaVersion !== "ebo.deepseek-native-observation/v1" || !["composition", "capability", "request", "response", "notification", "diagnostic", "error"].includes(String(record3.kind)) || typeof record3.observedAt !== "string" || record3.observedAt.trim() === "" || !optionalText(["method", "sessionId", "sourceIdentity"]) || record3.stream !== void 0 && record3.stream !== "stderr" || ["request", "response", "notification"].includes(String(record3.kind)) && typeof record3.method !== "string") fail();
}

// src/structural-observations.ts
import { createHash as createHash6 } from "node:crypto";
init_artifacts();

// src/event-order.ts
function nativeEventPrecedence(left, right) {
  if (left.runId !== right.runId || left.attemptId !== right.attemptId) return void 0;
  if (left.id === right.id) return 0;
  if (left.nativeOrder.status !== "known" || right.nativeOrder.status !== "known" || left.nativeOrder.domain !== right.nativeOrder.domain) return void 0;
  return Math.sign(left.nativeOrder.value - right.nativeOrder.value) || void 0;
}
function compareEventDisplayOrder(left, right) {
  const key = (event) => [
    event.runId,
    event.attemptId,
    event.nativeTime.status === "known" && Number.isFinite(Date.parse(event.nativeTime.value)) ? Date.parse(event.nativeTime.value) : Number.POSITIVE_INFINITY,
    event.nativeOrder.status === "known" ? event.nativeOrder.domain : "",
    event.nativeOrder.status === "known" ? event.nativeOrder.value : Number.POSITIVE_INFINITY,
    event.id
  ];
  const a = key(left), b = key(right);
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index], y = b[index];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function sameInference(left, right) {
  if (left.runId !== right.runId || left.attemptId !== right.attemptId) return false;
  for (const key of ["inferenceId", "modelRequestId", "responseId"]) {
    const value = left.attributes[key];
    if (typeof value === "string" && value !== "" && value === right.attributes[key]) return true;
  }
  return false;
}
function mergeNativeEventStreams(events) {
  const groups = /* @__PURE__ */ new Map();
  for (const event of events) {
    const key = JSON.stringify([event.runId, event.attemptId, event.nativeOrder.status === "known" ? ["known", event.nativeOrder.domain] : ["unknown", event.id]]);
    const group = groups.get(key);
    if (group === void 0) groups.set(key, [event]);
    else group.push(event);
  }
  const heap = [];
  const compare2 = (a, b) => compareEventDisplayOrder(a.events[a.index], b.events[b.index]);
  const push = (stream) => {
    heap.push(stream);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare2(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  for (const group of groups.values()) push({ events: group.sort((a, b) => nativeEventPrecedence(a, b) ?? compareEventDisplayOrder(a, b)), index: 0 });
  const result = [];
  while (heap.length) {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        const child = right < heap.length && compare2(heap[right], heap[left]) < 0 ? right : left;
        if (child >= heap.length || compare2(heap[index], heap[child]) <= 0) break;
        [heap[index], heap[child]] = [heap[child], heap[index]];
        index = child;
      }
    }
    result.push(first.events[first.index]);
    first.index += 1;
    if (first.index < first.events.length) push(first);
  }
  return result;
}

// src/occurrences.ts
var OCCURRENCE_RULES_VERSION = "1.2.0";
var OCCURRENCE_TYPES = ["failure-response", "validation-run", "source-change", "repeated-operation", "compaction", "delegation"];
var VALIDATION_KINDS = /* @__PURE__ */ new Set(["test", "typecheck", "lint", "build"]);
var EDIT_TOOLS = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "multiedit",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
  "create",
  "write_file",
  "edit_file",
  "notebookedit",
  "patch",
  "filechange"
]);
function extractOccurrences(input) {
  const operations = [...input.operations].map((operation2) => ({ ...operation2, events: ordered(operation2.events) })).sort((left, right) => compareEventDisplayOrder(left.events[0], right.events[0]));
  const details = new Map(operations.map((operation2) => [operation2.id, describe(operation2, input.resolveContent)]));
  const eventsById = new Map(operations.flatMap(({ events }) => events.map((event) => [event.id, event])));
  const occurrences = [];
  let failureOrderUnavailable = false;
  let repeatedOrderUnavailable = false;
  let compactionOrderUnavailable = false;
  const add = (type, heuristic, events, attributes, anchorId) => {
    const sorted = ordered(uniqueEvents(events));
    const times = sorted.flatMap(({ nativeTime }) => nativeTime.status === "known" && Number.isFinite(Date.parse(nativeTime.value)) ? [nativeTime.value] : []).sort((left, right) => Date.parse(left) - Date.parse(right));
    occurrences.push({
      schemaVersion: "ebo.occurrence/v1",
      id: `${input.attemptId}/occ/${type}/${anchorId ?? sorted[0].id}`,
      type,
      rule: { id: type, version: OCCURRENCE_RULES_VERSION, heuristic },
      eventIds: sorted.map(({ id }) => id),
      citations: uniqueReferences(sorted.map(({ source }) => source.nativeReference)),
      attributes: Object.fromEntries(Object.entries(attributes).filter((entry) => entry[1] !== void 0)),
      span: { ...times[0] === void 0 ? {} : { start: times[0] }, ...times.at(-1) === void 0 ? {} : { end: times.at(-1) } }
    });
  };
  const scopes = /* @__PURE__ */ new Map();
  for (const operation2 of operations) {
    const key = JSON.stringify([operationScope(operation2), operation2.toolName]);
    scopes.set(key, [...scopes.get(key) ?? [], operation2]);
  }
  for (const group of scopes.values()) {
    const view = commonOperationView(group);
    if (view === void 0) {
      if (group.some(({ failed }) => failed)) failureOrderUnavailable = true;
      continue;
    }
    const scoped = [...group].sort((a, b) => nativeEventPrecedence(view.get(a.id).start, view.get(b.id).start) ?? compareEventDisplayOrder(view.get(a.id).start, view.get(b.id).start));
    const otherTools = operations.filter((operation2) => operationScope(operation2) === operationScope(group[0]) && operation2.toolName !== group[0].toolName);
    for (let index = 0; index < scoped.length; ) {
      const first = scoped[index];
      if (!first.failed) {
        index += 1;
        continue;
      }
      let end = index;
      while (end < scoped.length && scoped[end].failed && scoped[end].toolName === first.toolName) {
        if (end > index) {
          const previous = view.get(scoped[end - 1].id).start;
          const candidate = view.get(scoped[end].id).start;
          let separated = false, uncertainBoundary = false;
          for (const other of otherTools) {
            const starts = other.events.filter((event) => (event.phase === "before" || event.phase === "instant") && event.nativeOrder.status === "known" && previous.nativeOrder.status === "known" && event.nativeOrder.domain === previous.nativeOrder.domain);
            if (starts.some((start) => nativeEventPrecedence(previous, start) === -1 && nativeEventPrecedence(start, candidate) === -1)) {
              separated = true;
              break;
            }
            if (starts.length === 0 || starts.some((start) => nativeEventPrecedence(previous, start) === void 0 || nativeEventPrecedence(start, candidate) === void 0)) uncertainBoundary = true;
          }
          if (!separated && uncertainBoundary) {
            failureOrderUnavailable = true;
            separated = true;
          }
          if (separated) break;
        }
        end += 1;
      }
      const failures = scoped.slice(index, end);
      const failureEnds = failures.map(({ id }) => view.get(id).end);
      const failedAt = [...failureEnds].sort((a, b) => nativeEventPrecedence(a, b) ?? compareEventDisplayOrder(a, b)).at(-1);
      let chainOrderUnavailable = failureEnds.some((event) => event.id !== failedAt.id && nativeEventPrecedence(event, failedAt) === void 0);
      const candidates = [];
      for (const candidate of scoped.slice(end)) {
        if (candidate.toolName !== first.toolName) continue;
        const start = view.get(candidate.id).start;
        if (failures.some((failure) => sameDeclaredBatch(failure, candidate))) continue;
        const precedence = nativeEventPrecedence(failedAt, start);
        if (precedence === void 0) {
          chainOrderUnavailable = true;
          continue;
        }
        if (precedence < 0) candidates.push(candidate);
      }
      const next = candidates[0];
      if (next !== void 0 && candidates.slice(1).some((candidate) => nativeEventPrecedence(view.get(next.id).start, view.get(candidate.id).start) !== -1)) chainOrderUnavailable = true;
      if (chainOrderUnavailable) {
        failureOrderUnavailable = true;
        index = end;
        continue;
      }
      add("failure-response", true, [...failures, ...next === void 0 ? [] : [next]].flatMap(({ events }) => events), {
        toolName: first.toolName,
        failures: failures.length,
        lastFailureEventId: failedAt.id,
        nextOutcome: next === void 0 ? "none" : details.get(next.id).result,
        responseEventId: next === void 0 ? void 0 : view.get(next.id).start.id
      }, view.get(first.id).start.id);
      index = end;
    }
  }
  occurrences.sort((left, right) => compareEventDisplayOrder(eventsById.get(left.eventIds[0]), eventsById.get(right.eventIds[0])));
  for (const operation2 of operations) {
    const detail = details.get(operation2.id);
    const validation = detail.checkKinds.filter((kind) => VALIDATION_KINDS.has(kind));
    if (validation.length > 0) {
      add("validation-run", true, operation2.events, {
        toolName: operation2.toolName,
        checkKinds: limited(detail.checkKinds),
        result: detail.result,
        reportedExitCode: reportedExitCode(operation2, input.resolveContent),
        outputRedirected: detail.outputRedirected
      });
    }
    if (detail.change !== void 0) {
      add("source-change", detail.change !== "explicit-mutation", operation2.events, {
        toolName: operation2.toolName,
        detectedBy: detail.change,
        paths: limited(detail.writes)
      });
    }
  }
  const signatures = /* @__PURE__ */ new Map();
  for (const operation2 of operations) if (operation2.toolName !== void 0 && operation2.inputDigest !== void 0) {
    const key = JSON.stringify([operationScope(operation2), operation2.toolName, operation2.inputDigest]);
    signatures.set(key, [...signatures.get(key) ?? [], operation2]);
  }
  for (const group of signatures.values()) {
    if (group.length < 2) continue;
    const view = commonOperationView(group, "repetition");
    if (view === void 0) {
      repeatedOrderUnavailable = true;
      continue;
    }
    const sorted = [...group].sort((a, b) => nativeEventPrecedence(view.get(a.id).start, view.get(b.id).start) ?? compareEventDisplayOrder(view.get(a.id).start, view.get(b.id).start));
    const first = view.get(sorted[0].id).start;
    for (const operation2 of sorted.slice(1)) {
      if (nativeEventPrecedence(first, view.get(operation2.id).start) !== -1) {
        repeatedOrderUnavailable = true;
        continue;
      }
      add("repeated-operation", false, operation2.events, {
        toolName: operation2.toolName,
        firstEventId: first.id,
        repeatedEventId: view.get(operation2.id).start.id
      });
    }
  }
  const changed = new Set(occurrences.filter(({ type }) => type === "source-change").flatMap(({ eventIds }) => eventIds));
  const operationEvents = new Set(operations.flatMap(({ events }) => events.map(({ id }) => id)));
  for (const event of ordered(input.events.filter(({ id, attributes }) => attributes.mutation === true && !changed.has(id) && !operationEvents.has(id)))) {
    add("source-change", false, [event], { toolName: text8(event.attributes.toolName) ?? text8(event.attributes.itemType) ?? text8(event.attributes.hook), detectedBy: "explicit-mutation" });
  }
  let boundary = [];
  const closeBoundary = () => {
    if (boundary.length > 0) add("compaction", true, boundary, { records: boundary.length, grouping: "adjacent-records" });
    boundary = [];
  };
  const compactionKind = (event) => JSON.stringify([event.source.nativeType, event.attributes.hook ?? event.attributes.subtype ?? event.attributes.eventType ?? event.attributes.method ?? event.attributes.lifecycle ?? ""]);
  let preceding;
  const compactionInputs = input.events.filter((event) => input.isCompaction(event) || event.family === "tool" || event.family === "message" && event.actor.kind !== "harness");
  const compactionTraversal = mergeNativeEventStreams(compactionInputs);
  for (const event of compactionTraversal) {
    if (preceding !== void 0 && (boundary.length > 0 || input.isCompaction(event)) && !knownCompactionAdjacency(preceding, event)) {
      compactionOrderUnavailable = true;
      closeBoundary();
    }
    if (input.isCompaction(event)) {
      if (boundary.some((part) => compactionKind(part) === compactionKind(event))) closeBoundary();
      boundary.push(event);
    } else if (event.family === "tool" || event.family === "message" && event.actor.kind !== "harness") closeBoundary();
    preceding = event;
  }
  closeBoundary();
  const delegationAvailable = input.delegationCapability.status !== "unsupported";
  if (delegationAvailable) {
    const groups = /* @__PURE__ */ new Map();
    for (const event of ordered(input.events.filter(({ family }) => family === "delegation"))) {
      const key = text8(event.attributes.taskId) ?? text8(event.attributes.agentId) ?? (event.scope.kind === "operation" ? text8(event.scope.id) : void 0) ?? `event:${event.id}`;
      groups.set(key, [...groups.get(key) ?? [], event]);
    }
    for (const [key, events] of groups) {
      add("delegation", false, events, { taskId: key.startsWith("event:") ? void 0 : key, records: events.length });
    }
  }
  const count2 = (type) => occurrences.filter((occurrence) => occurrence.type === type).length;
  const toolReason = input.toolCapability.status === "unsupported" ? input.toolCapability.detail ?? "The adapter does not expose tool operations." : void 0;
  const contentReason = input.resolveContent === void 0 ? "Native tool content is not available to classify commands." : void 0;
  const coverage = OCCURRENCE_TYPES.map((type) => {
    const reason = type === "delegation" && !delegationAvailable ? input.delegationCapability.detail ?? "The adapter does not expose delegation." : type === "failure-response" ? toolReason ?? (failureOrderUnavailable ? "Native source order cannot establish the failure follow-up population." : void 0) : type === "repeated-operation" ? toolReason ?? (repeatedOrderUnavailable ? "Native source order cannot establish repeated-operation precedence." : void 0) : type === "compaction" && compactionOrderUnavailable ? "Native order and source clocks cannot establish compaction adjacency." : ["validation-run", "source-change"].includes(type) ? toolReason ?? contentReason : void 0;
    return reason === void 0 ? { type, status: "available", count: count2(type) } : { type, status: "unavailable", reason };
  });
  const unavailable2 = new Set(coverage.filter(({ status }) => status === "unavailable").map(({ type }) => type));
  return { occurrences: occurrences.filter(({ type }) => !unavailable2.has(type)), coverage };
}
function describe(operation2, resolveContent) {
  const command = resolveContent === void 0 ? void 0 : operation2.events.flatMap((event) => event.content.status === "known" ? event.content.value.map(({ nativeReference }) => nativeReference) : []).map((reference) => findCommand(resolveContent(reference))).find((value) => value !== void 0);
  const checkKinds = command === void 0 ? [] : checkKindsOf(command);
  const writes = command === void 0 ? [] : shellWrites(command);
  const explicitMutation = operation2.events.some(({ attributes }) => attributes.mutation === true);
  const editTool = EDIT_TOOLS.has((operation2.toolName ?? "").toLowerCase());
  const passed = operation2.events.some(({ attributes }) => attributes.isError === false || attributes.status === "completed" || attributes.exitCode === 0 || attributes.hook === "PostToolUse");
  const exited = operation2.events.some(({ attributes }) => typeof attributes.exitCode === "number" && attributes.exitCode !== 0);
  return {
    checkKinds,
    writes,
    ...command === void 0 || checkKinds.length === 0 ? {} : { outputRedirected: /(?<![0-9&])>\s*[^\s&]/u.test(unwrap(command)) },
    // An inferred edit or shell write counts only after a native success result; a failed or unfinished one is an attempt.
    ...explicitMutation ? { change: "explicit-mutation" } : operation2.failed || exited || !passed ? {} : editTool ? { change: "edit-tool" } : writes.length > 0 ? { change: "shell-write" } : {},
    result: operation2.failed || exited ? "failed" : passed ? "passed" : "unknown"
  };
}
var EXIT_TEXT = /(?:Exit code|Process exited with code|exit status|exited with code|command failed with exit code)\s*[:=]?\s*(-?\d+)/giu;
function reportedExitCode(operation2, resolveContent) {
  if (resolveContent === void 0) return void 0;
  for (const event of [...operation2.events].reverse()) {
    if (event.phase !== "after" || event.content.status !== "known") continue;
    for (const { nativeReference } of event.content.value) {
      const content = resolveContent(nativeReference);
      if (content === void 0) continue;
      const matches2 = [...(typeof content === "string" ? content : JSON.stringify(content)).matchAll(EXIT_TEXT)];
      const code = matches2.length === 0 ? void 0 : Number(matches2.at(-1)[1]);
      if (code !== void 0 && Number.isSafeInteger(code)) return code;
    }
  }
  return void 0;
}
function findCommand(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== "object") return void 0;
  const record3 = value;
  for (const key of ["command", "cmd"]) {
    const candidate = record3[key];
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
    if (Array.isArray(candidate) && candidate.length > 0 && candidate.every((part) => typeof part === "string")) return candidate.join(" ");
  }
  for (const [key, nested] of Object.entries(record3)) {
    if (["content", "output", "result", "aggregatedOutput", "tool_response", "stdout", "stderr"].includes(key)) continue;
    const parsed = typeof nested === "string" && ["arguments", "args", "input"].includes(key) && nested.trimStart().startsWith("{") ? parseJson4(nested) : nested;
    const found = findCommand(parsed, depth + 1);
    if (found !== void 0) return found;
  }
  return void 0;
}
var SEGMENT_SPLIT = /&&|\|\||;|\n|\|/u;
var ENV_ASSIGN = /^[A-Z_][A-Z0-9_]*=\S*$/u;
var PACKAGE_RUNNERS = /* @__PURE__ */ new Set(["pnpm", "npm", "yarn", "npx", "bun", "corepack", "pnpx"]);
var SOURCE_EXTENSION = "(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|py|ya?ml|toml|html|svg)";
var SOURCE_PATH = new RegExp(`(?<![\\w.])((?:\\.{0,2}/)?[\\w@.-]+(?:/[\\w@.\\[\\]()-]+)+\\.${SOURCE_EXTENSION})\\b`, "gu");
var IGNORED_PATH = /(^|\/)(tmp|node_modules|\.cache|coverage|dist|build|\.git)\/|jest-cache/u;
var WRITE_SIGNAL = /writeFileSync|appendFileSync|fs\.write|\.write_text\(|open\([^)]*,\s*['"][wa]|\bsed\s+-i|\bperl\s+-\w*i|\bapply_patch\b|\*\*\* (?:Update|Add|Delete) File:|\btee\b|cat\s*>|>\s*[\w./~-]|\bcp\b|\bmv\b|\brm\b/u;
function unwrap(command) {
  const trimmed = command.trim();
  return /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/u.exec(trimmed)?.[2] ?? trimmed;
}
function segments(command) {
  return unwrap(command).split(SEGMENT_SPLIT).flatMap((segment) => {
    let tokens = segment.trim().split(/\s+/u).filter(Boolean);
    while (tokens.length > 0 && (ENV_ASSIGN.test(tokens[0]) || ["env", "time", "exec", "timeout", "sudo"].includes(tokens[0]) || /^\d+[smh]?$/u.test(tokens[0]))) tokens = tokens.slice(1);
    return tokens.length === 0 || tokens[0] === "cd" ? [] : [tokens];
  });
}
var NON_RUN_FLAGS = /* @__PURE__ */ new Set(["--version", "-V", "--help", "-h", "--listTests", "--list-tests", "--showConfig", "--show-config", "--list", "--init"]);
var PLAYWRIGHT_NON_TEST_SUBCOMMANDS = /* @__PURE__ */ new Set(["install", "install-deps", "uninstall", "show-report", "show-trace", "codegen", "open", "screenshot", "pdf", "merge-reports", "clear-cache", "init"]);
function checkKindsOf(command) {
  const kinds = [];
  for (const tokens of segments(command)) {
    const program = tokens[0].split("/").at(-1);
    const playwright = tokens.slice(0, 4).findIndex((token) => token.split("/").at(-1) === "playwright");
    if (tokens.some((token) => NON_RUN_FLAGS.has(token)) || playwright >= 0 && PLAYWRIGHT_NON_TEST_SUBCOMMANDS.has(tokens[playwright + 1] ?? "")) continue;
    const words = [];
    if (["tsc", "vue-tsc", "mypy", "pyright"].includes(program)) words.push("typecheck");
    else if (["eslint", "biome", "ruff", "stylelint"].includes(program)) words.push("lint");
    else if (["prettier", "black", "gofmt"].includes(program)) words.push("format");
    else if (["jest", "vitest", "mocha", "pytest", "playwright"].includes(program)) words.push("test");
    else if (["cargo", "go"].includes(program) && tokens[1] === "test") words.push("test");
    else if (PACKAGE_RUNNERS.has(program) || ["expo", "deno", "turbo", "nx"].includes(program)) {
      const args = tokens.slice(1, 7).filter((token) => !token.startsWith("-")).join(" ").toLowerCase();
      if (/\b(tsc|typecheck|type-check|check-types)\b/u.test(args)) words.push("typecheck");
      if (/\b(eslint|lint|design[-:]?lint)\b/u.test(args)) words.push("lint");
      if (/\b(jest|vitest|test(:\w+)?|playwright)\b/u.test(args)) words.push("test");
      if (/\b(build|export)\b/u.test(args) && program !== "corepack") words.push("build");
      if (/\b(prettier|format)\b/u.test(args)) words.push("format");
    } else if (["python", "python3"].includes(program) && /-m\s+pytest/u.test(tokens.slice(1, 3).join(" "))) words.push("test");
    for (const word of words) if (!kinds.includes(word)) kinds.push(word);
  }
  return kinds;
}
function shellWrites(command) {
  const source = unwrap(command);
  if (!WRITE_SIGNAL.test(source)) return [];
  const paths = [];
  for (const match of source.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/gu)) paths.push(match[1]);
  for (const match of source.matchAll(/(?<![0-9&<])>>?\s*([^\s;&|]+)/gu)) paths.push(match[1].replace(/^['"]|['"]$/gu, ""));
  if (/writeFileSync|appendFileSync|fs\.write|\.write_text\(|open\([^)]*,\s*['"][wa]/u.test(source)) {
    for (const match of source.matchAll(/(?:writeFileSync|appendFileSync)\(\s*['"]([^'"]+)/gu)) paths.push(match[1]);
    if (!paths.some((path) => new RegExp(`\\.${SOURCE_EXTENSION}$`, "u").test(path))) {
      paths.push(...[...source.matchAll(SOURCE_PATH)].map((match) => match[1]).slice(0, 3));
    }
  }
  for (const tokens of segments(source)) {
    const program = tokens[0].split("/").at(-1);
    if (["sed", "perl"].includes(program) && tokens.slice(1).some((token) => token.startsWith("-i") || program === "perl" && token.startsWith("-") && token.includes("i"))) {
      paths.push(...tokens.slice(1).filter((token) => new RegExp(SOURCE_PATH.source, "u").test(token)).map(stripQuotes));
    }
    if (["cp", "mv", "tee"].includes(program) && tokens.length > 1) paths.push(stripQuotes(tokens.at(-1)));
    if (program === "rm") paths.push(...tokens.slice(1).filter((token) => !token.startsWith("-")).map(stripQuotes));
  }
  return [...new Set(paths.filter((path) => new RegExp(`\\.${SOURCE_EXTENSION}$`, "u").test(path) && !IGNORED_PATH.test(path)))];
}
function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/gu, "");
}
function operationScope(operation2) {
  const first = operation2.events[0];
  const session = operation2.scope ?? text8(first.attributes.sessionId) ?? (first.scope.kind === "session" ? text8(first.scope.id) : void 0) ?? "";
  return session;
}
function ordered(events) {
  return [...events].sort(compareEventDisplayOrder);
}
function commonOperationView(operations, purpose = "failure") {
  const views = operations.map((operation2) => {
    const byDomain = /* @__PURE__ */ new Map();
    for (const event of operation2.events) if (event.nativeOrder.status === "known") {
      byDomain.set(event.nativeOrder.domain, [...byDomain.get(event.nativeOrder.domain) ?? [], event]);
    }
    return new Map([...byDomain].flatMap(([domain, events]) => {
      const sorted = [...events].sort((a, b) => nativeEventPrecedence(a, b) ?? compareEventDisplayOrder(a, b));
      const start = sorted.find(({ phase }) => phase === "before" || phase === "instant") ?? (purpose === "repetition" ? sorted[0] : void 0);
      const end = sorted.filter((event) => (event.phase === "after" || event.phase === "instant" && isFailureEndpoint(event)) && (!operation2.failed || isFailureEndpoint(event))).at(-1);
      return start === void 0 || purpose === "failure" && operation2.failed && end === void 0 ? [] : [[domain, { start, end }]];
    }));
  });
  const common = [...views[0]?.keys() ?? []].sort().find((domain) => views.every((view) => view.has(domain)));
  return common === void 0 ? void 0 : new Map(operations.map(({ id }, index) => [id, views[index].get(common)]));
}
function isFailureEndpoint(event) {
  return event.attributes.isError === true || event.attributes.errorScope === "agent-tool" || typeof event.attributes.exitCode === "number" && event.attributes.exitCode !== 0 || event.attributes.hook === "PostToolUseFailure" || ["failed", "error", "declined"].includes(String(event.attributes.status));
}
function sameDeclaredBatch(left, right) {
  const starts = (operation2) => operation2.events.filter(({ phase }) => phase === "before" || phase === "instant");
  return starts(left).some((a) => starts(right).some((b) => sameInference(a, b) || a.source.nativeReference.artifactId === b.source.nativeReference.artifactId && a.source.nativeReference.recordLocator === b.source.nativeReference.recordLocator));
}
function knownCompactionAdjacency(left, right) {
  const precedence = nativeEventPrecedence(left, right);
  if (precedence !== void 0) return precedence < 0;
  if (left.nativeOrder.status === "known" && right.nativeOrder.status === "known" && left.nativeOrder.domain === right.nativeOrder.domain) return false;
  const nativeClock = (event) => event.nativeTime.status === "known" && Number.isFinite(Date.parse(event.nativeTime.value)) && !["capture-receipt", "adapter-receipt", "hook-callback"].includes(String(event.attributes.nativeTimeSource));
  return nativeClock(left) && nativeClock(right) && left.nativeTime.status === "known" && right.nativeTime.status === "known" && Date.parse(left.nativeTime.value) < Date.parse(right.nativeTime.value);
}
function uniqueEvents(events) {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
function uniqueReferences(references) {
  return [...new Map(references.map((reference) => [JSON.stringify([reference.artifactId, reference.recordLocator]), reference])).values()].map((reference) => ({ ...reference }));
}
function limited(values) {
  return values.length > 0 && values.length <= 16 && values.every((value) => [...value].length <= 512) ? [...values] : void 0;
}
function text8(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function parseJson4(value) {
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}

// src/structural-observations.ts
var STRUCTURAL_EXTRACTOR_VERSION = "1.2.0";
var STRUCTURAL_EXTRACTOR_REGISTRY = [
  registry2("model-request-count", ["family:model-request"], "Distinct source-native inference requests observed in the attempt."),
  registry2("tool-operation-count", ["family:tool"], "Distinct logical tool operations, deduplicated by source-native operation identity."),
  registry2("tool-native-record-count", ["family:tool"], "Native records carrying mapped or explicitly unprojectable tool evidence."),
  registry2("unidentified-tool-native-record-count", ["family:tool"], "Native tool-family records without a resolvable source-native operation identity."),
  registry2("tool-error-count", ["family:tool"], "Distinct logical tool operations with an explicit native failure result."),
  registry2("repeated-tool-operation-count", ["family:tool"], "Distinct logical tool operations beyond the first with the same explicit tool identity and input digest."),
  registry2("failure-followed-by-same-tool-count", ["family:tool", "evidence:nativeOrder"], "Failed logical tool operations followed by a distinct operation of the same tool in the same native-order domain."),
  registry2("failure-followed-by-alternate-tool-count", ["family:tool", "evidence:nativeOrder"], "Failed logical tool operations followed by a distinct operation of another tool in the same native-order domain."),
  registry2("validation-after-last-mutation", ["family:artifact", "family:validation", "evidence:nativeOrder"], "Whether an explicitly identified validation occurs after the last explicitly identified mutation in one native-order domain."),
  registry2("compaction-boundary-record-count", ["family:context"], "Native records that explicitly identify a compaction boundary."),
  registry2("input-token-count", ["family:runtime"], "Native-reported input-token total without combining cumulative snapshots or telemetry sources."),
  registry2("output-token-count", ["family:runtime"], "Native-reported output-token total without combining cumulative snapshots or telemetry sources."),
  registry2("cache-read-input-token-count", ["family:runtime"], "Native-reported cache-read input-token total."),
  registry2("cache-creation-input-token-count", ["family:runtime"], "Native-reported cache-creation input-token total."),
  registry2("total-token-count", ["family:runtime"], "Native-reported total-token total; component categories are not added to reconstruct it."),
  registry2("total-cost-usd", ["family:runtime"], "Native-reported attempt cost in US dollars; subscription utilization is not inferred."),
  registry2("attempt-latency-ms", ["family:outcome"], "Native-reported end-to-end attempt duration in milliseconds.")
];
async function createRetainedStructuralObservationSet(bundleRoot) {
  const { outcomeCapture, dataset, resolver, coverage } = await createRetainedBehaviorEvidence(bundleRoot);
  const result = createStructuralObservationSet(dataset, coverage, outcomeCapture);
  await validateStructuralObservationSet(result, resolver);
  return result;
}
function createStructuralObservationSet(dataset, coverage, nativeCapture) {
  if (coverage.runId !== dataset.runId || coverage.attemptId !== dataset.attemptId || canonicalizeMetadata(coverage.adapter) !== canonicalizeMetadata(dataset.adapter)) {
    throw new Error("Structural observation coverage does not match the normalized dataset.");
  }
  const assessmentMode = importAssessmentMode(dataset, nativeCapture);
  const operations = toolOperations(dataset.events);
  const observations = [
    ...importOutcomes(dataset, nativeCapture, assessmentMode),
    ...extractStructuralFacts(dataset, operations)
  ];
  const { occurrences, coverage: occurrenceCoverage } = extractOccurrences({
    attemptId: dataset.attemptId,
    events: dataset.events,
    operations,
    toolCapability: dataset.capabilityProfile.families.tool,
    delegationCapability: dataset.capabilityProfile.families.delegation,
    isCompaction: isCompactionBoundary,
    ...nativeCapture === void 0 ? {} : { resolveContent: nativeContentResolver(nativeCapture) }
  });
  return {
    schemaVersion: "ebo.structural-observation-set/v1",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    assessmentMode,
    extractorVersion: STRUCTURAL_EXTRACTOR_VERSION,
    normalization: {
      datasetDigest: `sha256:${digestMetadata(dataset).value}`,
      adapter: structuredClone(dataset.adapter),
      capabilityProfile: structuredClone(dataset.capabilityProfile),
      coverage: structuredClone(coverage)
    },
    observations: dataset.origin?.kind === "imported" ? observations.map((observation2) => observation2.extractor.id.startsWith("outcome-") ? observation2 : {
      ...observation2,
      value: { status: "unavailable", reason: dataset.origin.reason }
    }) : observations,
    occurrences: dataset.origin?.kind === "imported" ? occurrences.filter((occurrence) => occurrence.type !== "failure-response" || occurrence.attributes.nextOutcome !== "none").map((occurrence) => ({ ...occurrence, attributes: { ...occurrence.attributes, sourceCompleteness: "unproven", evidenceOrigin: "imported" } })) : occurrences,
    occurrenceCoverage: dataset.origin?.kind === "imported" ? occurrenceCoverage.map(({ type }) => ({
      type,
      status: "unavailable",
      reason: dataset.origin.reason
    })) : occurrenceCoverage
  };
}
function nativeContentResolver(capture) {
  if (capture.qualification === "imported") {
    const resolver = createPointerEvidenceResolver({ ...capture, records: capture.records.map(({ reference, record: record3 }) => ({ reference, record: record3.document })) });
    return (reference) => resolver.read(reference)?.value;
  }
  const documents = new Map(capture.records.map(({ reference, record: record3 }) => [`${reference.artifactId}\0${reference.recordLocator}`, record3.document]));
  return (reference) => {
    const marker = reference.recordLocator.indexOf("#");
    const base = marker === -1 ? reference.recordLocator : reference.recordLocator.slice(0, marker);
    let current = documents.get(`${reference.artifactId}\0${base === "" ? "#" : base}`);
    const pointer = marker === -1 ? "" : reference.recordLocator.slice(marker + 1);
    for (const segment of pointer.split("/").slice(1)) {
      const key = segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
      current = Array.isArray(current) ? current[Number(key)] : asRecord4(current)?.[key];
      if (current === void 0) return void 0;
    }
    return current;
  };
}
async function validateStructuralObservationSet(report, resolver) {
  const errors = validateArtifact("structural observations", report);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  const occurrenceIds = /* @__PURE__ */ new Set();
  for (const occurrence of report.occurrences ?? []) {
    if (occurrenceIds.has(occurrence.id)) throw new Error(`Duplicate occurrence ID "${occurrence.id}".`);
    occurrenceIds.add(occurrence.id);
    if (!occurrence.id.startsWith(`${report.attemptId}/occ/${occurrence.type}/`)) throw new Error(`Occurrence "${occurrence.id}" belongs to another attempt or type.`);
    for (const citation of occurrence.citations) {
      const resolution = await resolver.resolve(citation);
      if (typeof resolution !== "object" || resolution.runId !== report.runId || resolution.attemptId !== report.attemptId) {
        throw new Error(`Occurrence "${occurrence.id}" has an unresolved native citation.`);
      }
    }
  }
  const ids = /* @__PURE__ */ new Set();
  for (const observation2 of report.observations) {
    if (ids.has(observation2.id)) throw new Error(`Duplicate structural observation ID "${observation2.id}".`);
    ids.add(observation2.id);
    if (observation2.runId !== report.runId || observation2.attemptId !== report.attemptId) {
      throw new Error(`Structural observation "${observation2.id}" belongs to another run or attempt.`);
    }
    if (observation2.denominator.id !== report.attemptId) {
      throw new Error(`Structural observation "${observation2.id}" has the wrong attempt denominator.`);
    }
    if (observation2.sourceRecordCount !== observation2.citations.length) {
      throw new Error(`Structural observation "${observation2.id}" source-record count does not match its citations.`);
    }
    for (const citation of observation2.citations) {
      const resolution = await resolver.resolve(citation);
      if (typeof resolution !== "object" || resolution.runId !== report.runId || resolution.attemptId !== report.attemptId) {
        throw new Error(`Structural observation "${observation2.id}" has an unresolved native citation.`);
      }
    }
  }
}
function extractStructuralFacts(dataset, operations) {
  const unprojectedToolEvidence = dataset.events.filter((event) => typeof event.attributes.unprojectedToolBlockCount === "number" && event.attributes.unprojectedToolBlockCount > 0);
  const ambiguousTools = uniqueEvents2([
    ...dataset.events.filter((event) => event.family === "tool" && !isToolBatch(event) && operationId(event, dataset.events) === void 0),
    ...ambiguousActorScopedToolEvents(dataset.events),
    ...unprojectedToolEvidence
  ]);
  const ambiguousToolFailures = ambiguousTools.filter(explicitToolFailure);
  const toolEvidence = uniqueEvents2([...dataset.events.filter(({ family }) => family === "tool"), ...unprojectedToolEvidence]);
  const toolCitations = citations(toolEvidence);
  const unprojectedToolReason = unprojectedToolEvidence.length === 0 ? void 0 : `${unprojectedToolEvidence.length} native record(s) contain unprojectable tool blocks.`;
  const modelEvents = dataset.events.filter(({ family }) => family === "model-request");
  const requests = logicalRequestCount(modelEvents);
  const failed = operations.filter(({ failed: failed2 }) => failed2);
  const ambiguousToolStarts = ambiguousTools.filter(isToolStart);
  const repeated = repeatedOperations(operations, ambiguousToolStarts);
  const followed = followedOperations(operations, ambiguousToolStarts);
  const compactions = dataset.events.filter(isCompactionBoundary);
  return [
    countOrUnavailable(dataset, registration("model-request-count"), requests.count, citations(modelEvents), requests.reason, "requests", modelEvents),
    countOrUnavailable(dataset, registration("tool-operation-count"), operations.length, toolCitations, unprojectedToolReason, "identified-logical-tool-operations", toolEvidence),
    countOrUnavailable(dataset, registration("tool-native-record-count"), toolCitations.length, toolCitations, void 0, "native-records", toolEvidence),
    countOrUnavailable(dataset, registration("unidentified-tool-native-record-count"), citations(ambiguousTools).length, citations(ambiguousTools), void 0, "native-records", ambiguousTools),
    countOrUnavailable(dataset, registration("tool-error-count"), failed.length, citations(failed.flatMap(({ events }) => events)), unprojectedToolReason ?? (ambiguousToolFailures.length > 0 ? "Tool failure totals are unavailable because a failure record has ambiguous operation identity." : void 0), "logical-tool-operations", failed.flatMap(({ events }) => events)),
    countOrUnavailable(dataset, registration("repeated-tool-operation-count"), repeated.count, repeated.citations, unprojectedToolReason ?? repeated.reason, "logical-tool-operations", repeated.events),
    countOrUnavailable(dataset, registration("failure-followed-by-same-tool-count"), followed.same, followed.citations, unprojectedToolReason ?? followed.reason, "failed-logical-tool-operations", followed.events),
    countOrUnavailable(dataset, registration("failure-followed-by-alternate-tool-count"), followed.alternate, followed.citations, unprojectedToolReason ?? followed.reason, "failed-logical-tool-operations", followed.events),
    validationAfterMutation(dataset),
    countOrUnavailable(dataset, registration("compaction-boundary-record-count"), compactions.length, citations(compactions), void 0, "native-records", compactions),
    resourceObservation(dataset, "input-token-count", ["inputTokens"], "tokens"),
    resourceObservation(dataset, "output-token-count", ["outputTokens"], "tokens"),
    resourceObservation(dataset, "cache-read-input-token-count", ["cacheReadInputTokens", "cachedInputTokens"], "tokens"),
    resourceObservation(dataset, "cache-creation-input-token-count", ["cacheCreationInputTokens", "cacheWriteInputTokens"], "tokens"),
    resourceObservation(dataset, "total-token-count", ["totalTokens"], "tokens"),
    resourceObservation(dataset, "total-cost-usd", ["totalCostUsd"], "usd"),
    resourceObservation(dataset, "attempt-latency-ms", ["durationMs"], "milliseconds")
  ];
}
function importOutcomes(dataset, capture, assessmentMode) {
  const terminal = dataset.events.find((event) => event.family === "outcome" && event.source.nativeType === "terminal-record");
  const retainedTerminal = capture?.records.find(({ record: record3 }) => record3.kind === "manifest");
  const retainedState = asRecord4(retainedTerminal?.record.document);
  const retainedWorkspace = capture?.records.find(({ record: record3 }) => record3.kind === "workspace" && asRecord4(record3.document)?.id === retainedState?.workspaceArtifactId);
  const terminalWorkspaceIds = new Set(terminal?.content.status === "known" ? terminal.content.value.flatMap(({ nativeReference, role }) => role === "final-workspace" ? [nativeReference.artifactId] : []) : []);
  const workspace = dataset.events.filter((event) => event.family === "artifact" && event.scope.kind === "workspace" && typeof event.scope.id === "string" && terminalWorkspaceIds.has(event.scope.id) && event.content.status === "known" && event.content.value.some(({ nativeReference, role }) => role === "workspace-outcome" && terminalWorkspaceIds.has(nativeReference.artifactId)));
  const captureReports = capture?.records.filter(({ record: record3 }) => record3.kind === "capture-report") ?? [];
  const captureReferences = captureReports.length > 0 ? captureReports.map(({ reference }) => reference) : capture?.records.map(({ reference }) => reference) ?? [];
  const assessmentEvents = dataset.events.filter((event) => event.source.nativeType === "assessment-mode");
  const assessmentReferences = capture?.records.filter(({ record: record3 }) => record3.kind === "assessment-mode").map(({ reference }) => reference) ?? [];
  const verifierReferences = capture?.records.filter(({ record: record3 }) => record3.kind === "verifier").map(({ reference }) => reference) ?? [];
  const base = [
    assessmentMode === "unknown" ? unavailable(dataset, outcomeRegistry("assessment-mode", "Assessment mode retained by the run manifest."), "Assessment mode evidence is missing.", []) : directObservation(
      dataset,
      "assessment-mode",
      "Assessment mode retained by the run manifest.",
      assessmentMode,
      "mode",
      assessmentEvents,
      assessmentEvents.length === 0 ? assessmentReferences.length > 0 ? assessmentReferences : verifierReferences : []
    ),
    terminal === void 0 || typeof terminal.attributes.state !== "string" ? retainedTerminal !== void 0 && typeof retainedState?.state === "string" ? directObservation(dataset, "terminal-state", "Terminal state retained by the run manifest.", retainedState.state, "state", [], [retainedTerminal.reference]) : unavailable(dataset, outcomeRegistry("terminal-state", "Terminal state retained by the run manifest."), "Terminal outcome evidence is missing.", []) : directObservation(dataset, "terminal-state", "Terminal state retained by the run manifest.", String(terminal.attributes.state), "state", [terminal]),
    capture === void 0 ? unavailable(dataset, outcomeRegistry("capture-qualification", "Structural capture qualification used to admit normalization."), "Capture qualification evidence was not supplied.", []) : directObservation(
      dataset,
      "capture-qualification",
      "Structural capture qualification used to admit normalization.",
      capture.qualification,
      "qualification",
      [],
      captureReferences
    ),
    workspace.length === 0 && retainedWorkspace !== void 0 && retainedTerminal !== void 0 ? directObservation(dataset, "workspace-outcome-count", "Retained final workspace outcomes referenced by the attempt.", 1, "workspace-outcomes", [], [retainedWorkspace.reference, retainedTerminal.reference]) : workspace.length === 0 ? unavailable(
      dataset,
      outcomeRegistry("workspace-outcome-count", "Retained final workspace outcomes referenced by the attempt."),
      terminalWorkspaceIds.size === 0 ? "Terminal outcome does not reference a final workspace artifact." : "Terminal-referenced workspace outcome evidence is missing.",
      terminal === void 0 ? [] : citations([terminal]),
      terminal === void 0 ? [] : [terminal]
    ) : directObservation(
      dataset,
      "workspace-outcome-count",
      "Retained final workspace outcomes referenced by the attempt.",
      new Set(workspace.map(({ scope }) => scope.id)).size,
      "workspace-outcomes",
      [...workspace, ...terminal === void 0 ? [] : [terminal]]
    )
  ];
  if (assessmentMode !== "verified" || capture === void 0) return base;
  const assertions = capture.records.flatMap(({ record: record3, reference }) => {
    if (record3.kind !== "verifier") return [];
    const document = asRecord4(record3.document);
    return Array.isArray(document?.assertions) ? document.assertions.flatMap((candidate, index) => {
      const assertion = asRecord4(candidate);
      return typeof assertion?.id === "string" && typeof assertion.status === "string" ? [{ id: assertion.id, status: assertion.status, reference: derivedReference(reference, `/assertions/${index}`) }] : [];
    }) : [];
  });
  return [...base, ...assertions.map(({ id, status, reference }) => directObservation(
    dataset,
    `verifier-assertion-${stableSuffix(id)}`,
    "Verifier assertion outcome identified by the cited native record.",
    status,
    "assertion-status",
    [],
    [reference]
  ))];
}
function toolOperations(events) {
  const groups = /* @__PURE__ */ new Map();
  for (const event of events.filter(({ family }) => family === "tool")) {
    const id = operationId(event, events);
    if (id === void 0) continue;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).flatMap(([id, grouped]) => groupToolEvents(id, grouped, events).groups.map(([scopedId, scoped]) => ({
    ...operation(scopedId, scoped),
    scope: JSON.stringify([
      scoped.map((event) => sessionScope(event, events)).find((value) => value !== void 0) ?? "",
      scoped.map(explicitAgentScope).find((value) => value !== void 0) ?? ""
    ])
  })));
}
function operation(id, grouped) {
  const toolNames = new Set(grouped.flatMap((event) => scalarString(event.attributes.toolName) ?? []));
  const inputDigests = new Set(grouped.flatMap((event) => scalarString(event.attributes.inputDigest) ?? []));
  return {
    id,
    events: grouped,
    ...toolNames.size === 1 ? { toolName: [...toolNames][0] } : {},
    ...inputDigests.size === 1 ? { inputDigest: [...inputDigests][0] } : {},
    failed: grouped.some(explicitToolFailure)
  };
}
function actorScope(event) {
  return explicitAgentScope(event) ?? directSessionScope(event);
}
function explicitAgentScope(event) {
  const id = scalarString(event.attributes.agentId) ?? (event.actor.kind === "agent" ? event.actor.id : void 0);
  return id === void 0 ? void 0 : `agent:${id}`;
}
function directSessionScope(event) {
  const retained = scalarString(event.attributes.sessionId);
  const document = scalarString(event.attributes.documentScope);
  if (document !== void 0) return `document:${JSON.stringify([document, retained ?? ""])}`;
  if (retained !== void 0) return `session:${retained}`;
  const scopeId = scalarString(event.scope.id);
  return (event.scope.kind === "session" || event.scope.kind === "turn") && scopeId !== void 0 ? `${event.scope.kind}:${scopeId}` : void 0;
}
var eventIndexes = /* @__PURE__ */ new WeakMap();
function eventIndex(allEvents) {
  let index = eventIndexes.get(allEvents);
  if (index === void 0) {
    index = { byId: /* @__PURE__ */ new Map(), scopeByReference: /* @__PURE__ */ new Map() };
    for (const event of allEvents) {
      if (!index.byId.has(event.id)) index.byId.set(event.id, event);
      const scope = directSessionScope(event);
      const key = referenceKey7(event.source.nativeReference);
      if (scope !== void 0 && !index.scopeByReference.has(key)) index.scopeByReference.set(key, scope);
    }
    eventIndexes.set(allEvents, index);
  }
  return index;
}
function referenceKey7(reference) {
  return JSON.stringify([reference.artifactId, reference.recordLocator]);
}
function sessionScope(event, allEvents) {
  const direct = directSessionScope(event);
  if (direct !== void 0) return direct;
  const index = eventIndex(allEvents);
  const sibling = index.scopeByReference.get(referenceKey7(event.source.nativeReference));
  if (sibling !== void 0) return sibling;
  for (const relation of event.relations.known) {
    const related = index.byId.get(relation.eventId);
    if (related === void 0) continue;
    const relatedScope = directSessionScope(related) ?? index.scopeByReference.get(referenceKey7(related.source.nativeReference));
    if (relatedScope !== void 0) return relatedScope;
  }
  return void 0;
}
function groupToolEvents(id, events, allEvents) {
  const sessions = new Set(events.flatMap((event) => sessionScope(event, allEvents) ?? []));
  if (sessions.size === 0) return splitToolEventsByAgent(id, events);
  const bySession = new Map([...sessions].sort().map((session) => [session, []]));
  const agentSessions = /* @__PURE__ */ new Map();
  for (const event of events) {
    const agent = explicitAgentScope(event);
    const session = sessionScope(event, allEvents);
    if (agent === void 0 || session === void 0) continue;
    const linked = agentSessions.get(agent) ?? /* @__PURE__ */ new Set();
    linked.add(session);
    agentSessions.set(agent, linked);
  }
  const ambiguous = [];
  for (const event of events) {
    const session = sessionScope(event, allEvents);
    if (session !== void 0) bySession.get(session).push(event);
    else if (sessions.size === 1) bySession.values().next().value.push(event);
    else {
      const linked = agentSessions.get(explicitAgentScope(event) ?? "");
      if (linked?.size === 1) bySession.get([...linked][0]).push(event);
      else ambiguous.push(event);
    }
  }
  const groups = [];
  for (const [session, grouped] of bySession) {
    const split = splitToolEventsByAgent(`${session}:${id}`, grouped);
    groups.push(...split.groups);
    ambiguous.push(...split.ambiguous);
  }
  return { groups, ambiguous };
}
function splitToolEventsByAgent(id, events) {
  const agents = new Set(events.flatMap((event) => explicitAgentScope(event) ?? []));
  if (agents.size <= 1) return { groups: [[id, [...events]]], ambiguous: [] };
  return {
    groups: [...agents].sort().map((agent) => [`${agent}:${id}`, events.filter((event) => explicitAgentScope(event) === agent)]),
    ambiguous: events.filter((event) => explicitAgentScope(event) === void 0)
  };
}
function ambiguousActorScopedToolEvents(events) {
  const groups = /* @__PURE__ */ new Map();
  for (const event of events.filter(({ family }) => family === "tool")) {
    const id = operationId(event, events);
    if (id === void 0) continue;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
  }
  return [...groups.entries()].flatMap(([id, grouped]) => groupToolEvents(id, grouped, events).ambiguous);
}
function uniqueEvents2(events) {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}
function repeatedOperations(operations, ambiguousStarts) {
  if (ambiguousStarts.length > 0) {
    const events = [...operations.flatMap(({ events: events2 }) => events2), ...ambiguousStarts];
    return { count: 0, citations: citations(events), events, reason: "Identity-less tool starts make repeated-operation identity ambiguous." };
  }
  if (operations.length === 0) return { count: 0, citations: [], events: [] };
  if (operations.some(({ toolName, inputDigest }) => toolName === void 0 || inputDigest === void 0)) {
    const events = operations.flatMap(({ events: events2 }) => events2);
    return { count: 0, citations: citations(events), events, reason: "Repetition requires an explicit tool identity and native-input digest for every logical operation." };
  }
  const seen = /* @__PURE__ */ new Map();
  let count2 = 0;
  const records = [];
  for (const operation2 of operations) {
    const signature = JSON.stringify([operation2.toolName, operation2.inputDigest]);
    const first = seen.get(signature);
    if (first !== void 0) {
      count2 += 1;
      records.push(...first.events, ...operation2.events);
    } else seen.set(signature, operation2);
  }
  return { count: count2, citations: citations(records), events: records };
}
function followedOperations(operations, ambiguousStarts) {
  const failed = operations.filter(({ failed: failed2 }) => failed2);
  if (failed.length === 0) return { same: 0, alternate: 0, citations: [], events: [] };
  if (ambiguousStarts.some(({ nativeOrder }) => nativeOrder.status !== "known")) {
    const events = [...failed.flatMap(({ events: events2 }) => events2), ...ambiguousStarts];
    return {
      same: 0,
      alternate: 0,
      citations: citations(events),
      events,
      reason: "An identity-less tool start has unknown native order relative to a failed operation."
    };
  }
  const ordered2 = operations.map((operation2) => ({ operation: operation2, starts: orderedEvents(operation2.events, false), failures: orderedEvents(operation2.events, true) }));
  if (ordered2.some(({ operation: operation2, starts }) => starts.length === 0 || operation2.toolName === void 0) || ordered2.filter(({ operation: operation2 }) => operation2.failed).some(({ failures }) => failures.length === 0)) {
    const events = operations.flatMap(({ events: events2 }) => events2);
    return {
      same: 0,
      alternate: 0,
      citations: citations(events),
      events,
      reason: "Failure-followed-by-operation requires explicit tool identities and source-local order for starts and failures."
    };
  }
  let same = 0;
  let alternate = 0;
  const records = [];
  for (const current of ordered2.filter(({ operation: operation2 }) => operation2.failed)) {
    records.push(...current.operation.events);
    const nextOperations = [];
    for (const failure of current.failures) {
      const candidates = ordered2.flatMap(({ operation: operation2, starts }) => starts.map((start) => ({ operation: operation2, start }))).filter(({ operation: operation2, start }) => operation2.id !== current.operation.id && start.domain === failure.domain && start.value > failure.value);
      const nextOrder = candidates.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...candidates.map(({ start }) => start.value));
      const intervening = ambiguousStarts.filter(({ nativeOrder }) => nativeOrder.status === "known" && nativeOrder.domain === failure.domain && nativeOrder.value > failure.value && nativeOrder.value <= nextOrder);
      if (intervening.length > 0) {
        const next = candidates.filter(({ start }) => start.value === nextOrder).flatMap(({ operation: operation2 }) => operation2.events);
        const events = [...current.operation.events, ...intervening, ...next];
        return {
          same: 0,
          alternate: 0,
          citations: citations(events),
          events,
          reason: "An identity-less tool start can be the next operation after a failure."
        };
      }
      if (candidates.length === 0) continue;
      const tied = candidates.filter(({ start }) => start.value === nextOrder);
      const tiedClassifications = new Set(tied.map(({ operation: operation2 }) => operation2.toolName === current.operation.toolName ? "same" : "alternate"));
      if (tiedClassifications.size > 1) {
        const events = [current.operation, ...tied.map(({ operation: operation2 }) => operation2)].flatMap(({ events: events2 }) => events2);
        return {
          same: 0,
          alternate: 0,
          citations: citations(events),
          events,
          reason: "Tied next operations in one native-order domain disagree on tool classification."
        };
      }
      nextOperations.push(...tied.map(({ operation: operation2 }) => operation2));
    }
    const classifications = new Set(nextOperations.map((operation2) => operation2.toolName === current.operation.toolName ? "same" : "alternate"));
    if (classifications.size > 1) {
      const events = [current.operation, ...nextOperations].flatMap(({ events: events2 }) => events2);
      return {
        same: 0,
        alternate: 0,
        citations: citations(events),
        events,
        reason: "Independent native-order domains disagree on the next tool operation classification."
      };
    }
    const classification = [...classifications][0];
    if (classification === "same") same += 1;
    if (classification === "alternate") alternate += 1;
    if (classification !== void 0) records.push(...nextOperations.flatMap(({ events }) => events));
  }
  return { same, alternate, citations: citations(records), events: records };
}
function isToolStart(event) {
  return event.family === "tool" && (event.phase === "before" || event.phase === "instant");
}
function validationAfterMutation(dataset) {
  const registrationValue = registration("validation-after-last-mutation");
  const mutations = dataset.events.filter((event) => event.family === "artifact" && event.attributes.mutation === true);
  const validations = dataset.events.filter(({ family }) => family === "validation");
  const records = [...mutations, ...validations];
  const capabilityReason = unavailableCapability(dataset, registrationValue, true);
  if (capabilityReason !== void 0) return unavailable(dataset, registrationValue, capabilityReason, citations(records), records);
  if (mutations.length === 0) return unavailable(dataset, registrationValue, "No normalized event explicitly identifies a mutation.", citations(records), records);
  const ordered2 = records.flatMap((event) => event.nativeOrder.status === "known" ? [{ event, value: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
  if (ordered2.length !== records.length || new Set(ordered2.map(({ domain }) => domain)).size !== 1) {
    return unavailable(dataset, registrationValue, "Mutation and validation ordering is unknown or spans unrelated native-order domains.", citations(records), records);
  }
  const lastMutation = Math.max(...ordered2.filter(({ event }) => event.family === "artifact").map(({ value: value2 }) => value2));
  const value = ordered2.some(({ event, value: order }) => event.family === "validation" && order > lastMutation);
  return known(dataset, registrationValue, value, "boolean", citations(records), records);
}
function resourceObservation(dataset, id, fields, unit) {
  const resourceEvents = dataset.events.filter((event) => typeof event.attributes.resourceSemantics === "string");
  const candidates = resourceEvents.flatMap((event) => {
    if (typeof event.attributes.resourceSemantics !== "string") return [];
    const aliases = fields.flatMap((field2) => typeof event.attributes[field2] === "number" ? [{ field: field2, value: event.attributes[field2] }] : []);
    return aliases.length === 0 ? [] : [{
      event,
      field: aliases.map(({ field: field2 }) => field2).join("/"),
      value: aliases[0].value,
      semantics: event.attributes.resourceSemantics,
      aliasConflict: new Set(aliases.map(({ value }) => value)).size > 1
    }];
  });
  const field = fields.join("/");
  const registrationValue = registration(id);
  const capabilityReason = unavailableCapability(dataset, registrationValue, resourceEvents.length === 0);
  if (capabilityReason !== void 0) return unavailable(dataset, registrationValue, capabilityReason, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
  if (candidates.length === 0) return unavailable(dataset, registrationValue, `No supported native ${field} record is available.`, []);
  const finals = candidates.filter(({ semantics }) => semantics === "cumulative-final");
  if (finals.length > 0) {
    const invalid = invalidResourceReason(finals, field, unit);
    if (invalid !== void 0) return unavailable(dataset, registrationValue, invalid, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event));
    const values = new Set(finals.map(({ value }) => value));
    return values.size === 1 ? known(dataset, registrationValue, finals[0].value, unit, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event)) : unavailable(dataset, registrationValue, `Conflicting cumulative-final ${field} records are available.`, citations(finals.map(({ event }) => event)), finals.map(({ event }) => event));
  }
  const snapshotCandidates = candidates.filter(({ semantics }) => semantics === "cumulative-snapshot");
  if (snapshotCandidates.length > 0 && candidates.every(({ semantics }) => semantics === "cumulative-snapshot" || semantics === "increment")) {
    const snapshots = resourceEvents.filter(({ attributes }) => attributes.resourceSemantics === "cumulative-snapshot");
    return cumulativeResourceObservation(dataset, registrationValue, snapshotCandidates, snapshots, field, unit);
  }
  if (candidates.every(({ semantics }) => semantics === "increment")) {
    const invalid = invalidResourceReason(candidates, field, unit);
    return invalid === void 0 ? known(dataset, registrationValue, candidates.reduce((sum, { value }) => sum + value, 0), unit, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event)) : unavailable(dataset, registrationValue, invalid, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
  }
  return unavailable(dataset, registrationValue, `${field} records have overlapping or unordered usage semantics.`, citations(candidates.map(({ event }) => event)), candidates.map(({ event }) => event));
}
function cumulativeResourceObservation(dataset, extractor, candidates, semanticEvents, field, unit) {
  const ordered2 = semanticEvents.flatMap((event) => event.nativeOrder.status === "known" ? [{ event, order: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
  if (semanticEvents.length > 1 && (ordered2.length !== semanticEvents.length || new Set(ordered2.map(({ domain }) => domain)).size !== 1)) {
    return unavailable(dataset, extractor, `${field} cumulative snapshot records have unknown or unrelated native order.`, citations(semanticEvents), semanticEvents);
  }
  const latestEvents = semanticEvents.length === 1 ? semanticEvents : ordered2.filter(({ order }) => order === Math.max(...ordered2.map(({ order: value }) => value))).map(({ event }) => event);
  const latestIds = new Set(latestEvents.map(({ id }) => id));
  const latest = candidates.filter(({ event }) => latestIds.has(event.id));
  if (latest.length === 0) {
    return unavailable(dataset, extractor, `Latest cumulative snapshot omits ${field}.`, citations(latestEvents), latestEvents);
  }
  const invalid = invalidResourceReason(latest, field, unit);
  if (invalid !== void 0) return unavailable(dataset, extractor, invalid, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event));
  const values = new Set(latest.map(({ value }) => value));
  return values.size === 1 ? known(dataset, extractor, latest[0].value, unit, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event)) : unavailable(dataset, extractor, `Conflicting latest cumulative ${field} snapshots are available.`, citations(latest.map(({ event }) => event)), latest.map(({ event }) => event));
}
function invalidResourceReason(candidates, field, unit) {
  if (candidates.some(({ aliasConflict }) => aliasConflict)) return `${field} aliases conflict within one native record.`;
  return candidates.some(({ value }) => !Number.isFinite(value) || value < 0 || unit === "tokens" && !Number.isSafeInteger(value)) ? `${field} contains a negative or non-integral native value.` : void 0;
}
function countOrUnavailable(dataset, extractor, count2, evidence, reason, unit = "requests", sourceEvents = []) {
  if (reason !== void 0) return unavailable(dataset, extractor, reason, evidence, sourceEvents);
  const unavailableReason = unavailableCapability(dataset, extractor, count2 === 0);
  if (unavailableReason !== void 0) return unavailable(dataset, extractor, unavailableReason, evidence, sourceEvents);
  return known(dataset, extractor, count2, unit, evidence, sourceEvents);
}
function directObservation(dataset, id, definition, value, unit, events, extraCitations = []) {
  return known(dataset, outcomeRegistry(id, definition), value, unit, citations(events, extraCitations), events);
}
function known(dataset, extractor, value, unit, evidence, sourceEvents = []) {
  return observation(dataset, extractor, { status: "known", value, unit }, evidence, sourceEvents);
}
function unavailable(dataset, extractor, reason, evidence, sourceEvents = []) {
  return observation(dataset, extractor, { status: "unavailable", reason }, evidence, sourceEvents);
}
function observation(dataset, extractor, value, evidence, sourceEvents) {
  const unique = uniqueReferences2(evidence);
  return {
    schemaVersion: "ebo.structural-observation/v1",
    id: `${dataset.attemptId}:${extractor.id}`,
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    extractor: { id: extractor.id, version: STRUCTURAL_EXTRACTOR_VERSION, requiredCapabilities: extractor.requiredCapabilities },
    definition: extractor.definition,
    denominator: { scope: "attempt", id: dataset.attemptId, value: 1, unit: "attempt" },
    value,
    sourceEventIds: [...new Set(sourceEvents.map(({ id }) => id))].sort(),
    sourceRecordCount: unique.length,
    citations: unique
  };
}
function operationId(event, events) {
  if (isToolBatch(event)) return void 0;
  const direct = [event.attributes.toolUseId, event.attributes.toolCallId, event.attributes.actionId, event.attributes.callId, event.attributes.itemId].map(scalarString).find((value) => value !== void 0) ?? (event.scope.kind === "operation" ? event.scope.id : void 0);
  if (direct !== void 0) return direct;
  for (const relation of event.relations.known) {
    const related = eventIndex(events).byId.get(relation.eventId);
    const relatedId = related === void 0 ? void 0 : operationIdWithoutRelations(related);
    if (relatedId !== void 0) return relatedId;
  }
  return void 0;
}
function operationIdWithoutRelations(event) {
  return [event.attributes.toolUseId, event.attributes.toolCallId, event.attributes.actionId, event.attributes.callId, event.attributes.itemId].map(scalarString).find((value) => value !== void 0) ?? (event.scope.kind === "operation" ? event.scope.id : void 0);
}
function requestId(event) {
  return [event.attributes.requestId, event.attributes.callId, event.attributes.llmResponseId].map(scalarString).find((value) => value !== void 0) ?? (event.scope.kind === "operation" ? event.scope.id : void 0);
}
function logicalRequestCount(events) {
  const groups = /* @__PURE__ */ new Map();
  const unidentified = events.filter((event) => {
    const id = requestId(event);
    if (id === void 0) return true;
    const grouped = groups.get(id) ?? [];
    grouped.push(event);
    groups.set(id, grouped);
    return false;
  });
  let count2 = 0;
  let ambiguousScopes = 0;
  for (const grouped of groups.values()) {
    const scopes = new Set(grouped.flatMap((event) => actorScope(event) ?? []));
    count2 += Math.max(1, scopes.size);
    if (scopes.size > 1) ambiguousScopes += grouped.filter((event) => actorScope(event) === void 0).length;
  }
  const ambiguities = [
    unidentified.length > 0 ? `${unidentified.length} record(s) lack a source-native request identity` : void 0,
    ambiguousScopes > 0 ? `${ambiguousScopes} record(s) lack a native scope while the same request ID occurs in multiple scopes` : void 0
  ].filter((reason) => reason !== void 0);
  return { count: count2, ...ambiguities.length === 0 ? {} : { reason: `Model-request count is unavailable because ${ambiguities.join(" and ")}.` } };
}
function isToolBatch(event) {
  return event.attributes.hook === "PostToolBatch";
}
function explicitToolFailure(event) {
  return event.attributes.isError === true || event.attributes.errorScope === "agent-tool" || typeof event.attributes.exitCode === "number" && event.attributes.exitCode !== 0 || event.attributes.hook === "PostToolUseFailure" || event.attributes.status === "failed" || event.attributes.status === "error" || event.attributes.status === "declined";
}
function orderedEvents(events, failures) {
  return events.filter((event) => failures ? explicitToolFailure(event) : event.phase === "before" || event.phase === "instant").flatMap((event) => event.nativeOrder.status === "known" ? [{ value: event.nativeOrder.value, domain: event.nativeOrder.domain }] : []);
}
function isCompactionBoundary(event) {
  if (event.family !== "context") return false;
  const subtype = scalarString(event.attributes.subtype);
  const hook = scalarString(event.attributes.hook);
  const method = scalarString(event.attributes.method);
  const eventType = scalarString(event.attributes.eventType);
  return subtype === "compact_boundary" || hook === "PreCompact" || hook === "PostCompact" || method === "thread/compacted" || eventType?.startsWith("compaction/") === true || event.source.nativeType === "Condensation" || event.source.nativeType === "CondensationSummaryEvent";
}
function importAssessmentMode(dataset, capture) {
  const record3 = capture?.records.find(({ record: record4 }) => record4.kind === "assessment-mode")?.record.document;
  if (record3 === "observational" || record3 === "verified") return record3;
  if (capture?.records.some(({ record: record4 }) => record4.kind === "verifier") === true) return "verified";
  const value = dataset.events.find((event) => event.source.nativeType === "assessment-mode")?.attributes.assessmentMode;
  return value === "observational" || value === "verified" ? value : "unknown";
}
function unavailableCapability(dataset, extractor, zero) {
  for (const requirement of extractor.requiredCapabilities) {
    const capability = requirement === "evidence:nativeOrder" ? dataset.capabilityProfile.evidence.nativeOrder : dataset.capabilityProfile.families[requirement.slice("family:".length)];
    if (capability.status === "unsupported") return capability.detail ?? `Required capability ${requirement} is unsupported.`;
    if (zero && capability.status === "partial") return capability.detail ?? `Required capability ${requirement} is partial, so an observed zero is not supported.`;
  }
  return void 0;
}
function citations(events, extra = []) {
  return uniqueReferences2([...events.map(({ source }) => source.nativeReference), ...extra]);
}
function uniqueReferences2(references) {
  return [...new Map(references.map((reference) => [canonicalizeMetadata(reference), structuredClone(reference)])).values()].sort((left, right) => canonicalizeMetadata(left).localeCompare(canonicalizeMetadata(right)));
}
function derivedReference(reference, pointer) {
  return { artifactId: reference.artifactId, recordLocator: reference.recordLocator === "#" ? `#${pointer}` : `${reference.recordLocator}#${pointer}` };
}
function scalarString(value) {
  return typeof value === "string" && value !== "" ? value : void 0;
}
function stableSuffix(value) {
  return createHash6("sha256").update(value).digest("hex").slice(0, 16);
}
function registry2(id, requiredCapabilities, definition) {
  return { id, requiredCapabilities, definition };
}
function registration(id) {
  const found = STRUCTURAL_EXTRACTOR_REGISTRY.find((candidate) => candidate.id === id);
  if (found === void 0) throw new Error(`Unknown structural extractor "${id}".`);
  return found;
}
function outcomeRegistry(id, definition) {
  return registry2(`outcome-${id}`, [], definition);
}
function asRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}

// src/atlas-packet.ts
import { createHash as createHash8 } from "node:crypto";
import { closeSync as closeSync5, cpSync, existsSync, mkdirSync as mkdirSync4, mkdtempSync, openSync as openSync5, readdirSync as readdirSync3, readFileSync as readFileSync4, renameSync as renameSync2, rmSync as rmSync2, statSync as statSync2, writeFileSync as writeFileSync3, writeSync } from "node:fs";
import { basename, dirname as dirname9, extname as extname2, join as join10, relative as relative6, resolve as resolve13 } from "node:path";
import { DuckDBInstance as DuckDBInstance2 } from "@duckdb/node-api";
import { makeVector as makeVector2, tableFromIPC, tableToIPC as tableToIPC2, Table as Table2, vectorFromArray as vectorFromArray2, Utf8 as Utf82 } from "apache-arrow";

// src/atlas-bundle.ts
init_artifacts();
import { DuckDBInstance } from "@duckdb/node-api";

// src/atlas.ts
import { statSync } from "node:fs";
import { dirname as dirname7, join as join8, resolve as resolve11 } from "node:path";
import { pathToFileURL } from "node:url";

// src/aggregation.ts
init_artifacts();
import { join as join6, resolve as resolve9 } from "node:path";

// src/human-calibration.ts
import { createHash as createHash7 } from "node:crypto";
import { dirname as dirname5, join as join5, relative as relative4, resolve as resolve8, sep as sep4 } from "node:path";
import lockfile from "proper-lockfile";
init_artifacts();
init_scheduler();
async function selectReviewSample(sourceSet, criteria, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  assertValid2("review source set", sourceSet);
  assertValid2("review sample criteria", criteria);
  if (new Set(criteria.strata.map(({ id }) => id)).size !== criteria.strata.length) {
    throw new Error("Review sample stratum IDs must be unique.");
  }
  for (const { id, filters } of criteria.strata) {
    if (filters.confidence?.min !== void 0 && filters.confidence.max !== void 0 && filters.confidence.min > filters.confidence.max) {
      throw new Error(`Review sample stratum "${id}" has an inverted confidence range.`);
    }
  }
  const canonicalSources = {
    ...structuredClone(sourceSet),
    sources: sourceSet.sources.map((source) => ({
      ...structuredClone(source),
      bundleRoot: resolve8(source.bundleRoot),
      assertionPath: resolve8(source.assertionPath)
    }))
  };
  const loaded = await loadCandidates(canonicalSources.sources);
  const identities = loaded.map(({ assertion }) => assertionKey(assertion));
  if (new Set(identities).size !== identities.length) throw new Error("Review source assertion identities must be unique.");
  const assignments = /* @__PURE__ */ new Map();
  for (const candidate of loaded) {
    const matches2 = criteria.strata.filter(({ filters }) => matchesFilters(candidate, filters));
    if (matches2.length > 1) throw new Error(`Review assertion "${candidate.assertion.id}" matches more than one stratum.`);
    if (matches2[0] !== void 0) assignments.set(assertionKey(candidate.assertion), matches2[0].id);
  }
  const candidates = [];
  const strata = criteria.strata.map((stratum) => {
    const eligible = loaded.filter(({ assertion }) => assignments.get(assertionKey(assertion)) === stratum.id).sort((left, right) => seededKey(criteria.seed, stratum.id, left.assertion).localeCompare(
      seededKey(criteria.seed, stratum.id, right.assertion)
    ));
    candidates.push(...eligible.slice(0, stratum.sampleSize).map(publicCandidate));
    return { id: stratum.id, eligible: eligible.length, selected: Math.min(eligible.length, stratum.sampleSize), requested: stratum.sampleSize };
  });
  const sample = {
    schemaVersion: "ebo.review-sample/v1",
    createdAt: now(),
    sources: canonicalSources,
    criteria: structuredClone(criteria),
    population: {
      sourceCount: loaded.length,
      eligibleAssertionIds: loaded.filter(({ assertion }) => assignments.has(assertionKey(assertion))).map(({ assertion }) => assertion.id).sort(),
      selectedAssertionIds: candidates.map(({ assertion }) => assertion.id),
      unavailableStrata: strata.filter(({ eligible }) => eligible === 0).map(({ id }) => id),
      strata
    },
    candidates
  };
  validateReviewSample(sample);
  return sample;
}
function validateReviewHistory(selection, history) {
  validateReviewSample(selection);
  assertValid2("review history", history);
  if (history.selection.digest !== digest3(selection)) throw new Error("Review history selection binding is stale.");
  const decisionIndex = indexDecisions();
  const candidatesById = /* @__PURE__ */ new Map();
  for (const candidate of selection.candidates) {
    const matches2 = candidatesById.get(candidate.assertion.id) ?? [];
    matches2.push(candidate);
    candidatesById.set(candidate.assertion.id, matches2);
  }
  const prefix = createHash7("sha256").update('{"decisions":[');
  const suffix = `],"schemaVersion":${canonicalizeMetadata(history.schemaVersion)},"selection":${canonicalizeMetadata(history.selection)}}`;
  for (const [index, decision] of history.decisions.entries()) {
    if (decisionIndex.byId.has(decision.id)) throw new Error(`Review history repeats decision "${decision.id}".`);
    const matchingId = candidatesById.get(decision.assertion.id) ?? [];
    if (matchingId.length === 0) throw new Error(`Review history targets unknown assertion "${decision.assertion.id}".`);
    const candidate = matchingId.find(({ assertion }) => assertionKey(assertion) === assertionKey(decision.assertion));
    if (candidate === void 0) throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    if (canonicalizeMetadata(candidate.assertion) !== canonicalizeMetadata(decision.assertion)) {
      throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    }
    const expected = index === 0 ? null : {
      schemaVersion: history.schemaVersion,
      digest: `sha256:${prefix.copy().update(suffix).digest("hex")}`
    };
    if (canonicalizeMetadata(decision.previousHistory) !== canonicalizeMetadata(expected)) {
      throw new Error(`Review history decision "${decision.id}" has a stale previous-history binding.`);
    }
    validateDecisionSemantics(decision, decisionIndex);
    prefix.update(`${index === 0 ? "" : ","}${canonicalizeMetadata(decision)}`);
    indexDecision(decisionIndex, decision);
  }
}
function validateReviewSample(selection) {
  assertValid2("review sample", selection);
  const candidateBindings = selection.candidates.map(({ assertion }) => assertionKey(assertion));
  if (new Set(candidateBindings).size !== candidateBindings.length) {
    throw new Error("Review sample candidate bindings must be unique.");
  }
  if (selection.population.sourceCount !== selection.sources.sources.length) {
    throw new Error("Review sample source count does not match its retained source set.");
  }
  if (canonicalizeMetadata(selection.population.selectedAssertionIds) !== canonicalizeMetadata(selection.candidates.map(({ assertion }) => assertion.id))) {
    throw new Error("Review sample selected assertion IDs do not match its candidates.");
  }
  if (selection.population.strata.length !== selection.criteria.strata.length) {
    throw new Error("Review sample strata do not match its retained criteria.");
  }
  const matched = /* @__PURE__ */ new Map();
  for (const candidate of selection.candidates) {
    const strata = selection.criteria.strata.filter(({ filters }) => matchesFilters(candidate, filters));
    if (strata.length !== 1) throw new Error(`Review candidate "${candidate.assertion.id}" must match exactly one retained stratum.`);
    matched.set(strata[0].id, (matched.get(strata[0].id) ?? 0) + 1);
  }
  for (const [index, criterion] of selection.criteria.strata.entries()) {
    const stratum = selection.population.strata[index];
    if (stratum.id !== criterion.id || stratum.requested !== criterion.sampleSize || stratum.selected !== (matched.get(criterion.id) ?? 0) || stratum.selected > stratum.eligible) {
      throw new Error(`Review sample stratum "${criterion.id}" is inconsistent with its criteria or selected candidates.`);
    }
  }
  const unavailable2 = selection.population.strata.filter(({ eligible }) => eligible === 0).map(({ id }) => id);
  if (canonicalizeMetadata(selection.population.unavailableStrata) !== canonicalizeMetadata(unavailable2) || selection.population.eligibleAssertionIds.length !== selection.population.strata.reduce((total, { eligible }) => total + eligible, 0)) {
    throw new Error("Review sample eligible or unavailable population is inconsistent with its strata.");
  }
  const sources = new Set(selection.sources.sources.map((source) => sourceKey(
    resolve8(source.bundleRoot),
    resolve8(source.assertionPath),
    source.taskContext
  )));
  for (const candidate of selection.candidates) {
    if (!sources.has(sourceKey(candidate.source.bundleRoot, candidate.source.assertionPath, candidate.context.taskContext))) {
      throw new Error(`Review candidate "${candidate.assertion.id}" is absent from the retained source set.`);
    }
  }
}
async function revalidateReviewSample(selection) {
  validateReviewSample(selection);
  const expected = await selectReviewSample(selection.sources, selection.criteria, () => selection.createdAt);
  if (canonicalizeMetadata(expected) !== canonicalizeMetadata(selection)) {
    throw new Error("Review sample does not match the reproducible selection from its retained sources and criteria.");
  }
}
async function loadCandidates(sources) {
  const grouped = /* @__PURE__ */ new Map();
  for (const source of sources) {
    const root = resolve8(source.bundleRoot);
    const group = grouped.get(root) ?? [];
    group.push(source);
    grouped.set(root, group);
  }
  const loaded = [];
  for (const [bundleRoot, group] of grouped) {
    const evidence = await createRetainedBehaviorEvidence(bundleRoot);
    const manifest = readManifest2(bundleRoot);
    for (const source of group) loaded.push(await loadCandidate(source, evidence, manifest));
  }
  return loaded;
}
async function loadCandidate(source, evidence, manifest, retainCapture = false) {
  const bundleRoot = resolve8(source.bundleRoot);
  const assertionPath = resolve8(source.assertionPath);
  const assertionDocument = readJson(assertionPath);
  const resolvedEvidence = evidence ?? await createRetainedBehaviorEvidence(bundleRoot);
  const resolvedManifest = manifest ?? readManifest2(bundleRoot);
  await validateBehaviorAssertion(assertionDocument, resolvedEvidence.dataset, resolvedEvidence.resolver, void 0, resolvedEvidence.capture);
  if (resolvedManifest.run.id !== assertionDocument.runId || resolvedManifest.attempt.id !== assertionDocument.attemptId) {
    throw new Error(`Review assertion "${assertionDocument.id}" belongs to another run bundle.`);
  }
  const outcome = terminalVerifierOutcome(resolvedEvidence.outcomeCapture, resolvedManifest);
  return {
    assertion: { id: assertionDocument.id, schemaVersion: assertionDocument.schemaVersion, digest: digest3(assertionDocument) },
    source: { bundleRoot, assertionPath },
    context: {
      runId: resolvedManifest.run.id,
      attemptId: resolvedManifest.attempt.id,
      taskId: resolvedManifest.run.task.id,
      taskContext: source.taskContext,
      modelId: resolvedManifest.run.model.id,
      harnessId: resolvedManifest.run.harness.id,
      terminalState: resolvedManifest.terminal.state,
      outcome,
      categoryId: assertionDocument.behavior.categoryId,
      abstained: assertionDocument.judgment.disposition === "abstained",
      confidence: assertionDocument.judgment.disposition === "assessed" ? assertionDocument.judgment.confidence.value : null
    },
    assertionDocument,
    manifest: resolvedManifest,
    ...retainCapture ? { capture: resolvedEvidence.capture } : {}
  };
}
function publicCandidate(candidate) {
  const { assertionDocument: _assertionDocument, manifest: _manifest, capture: _capture, ...result } = candidate;
  return structuredClone(result);
}
function matchesFilters(candidate, filters) {
  const values = [
    [filters.taskIds, candidate.context.taskId],
    [filters.modelIds, candidate.context.modelId],
    [filters.harnessIds, candidate.context.harnessId],
    [filters.outcomes, candidate.context.outcome],
    [filters.terminalStates, candidate.context.terminalState],
    [filters.categoryIds, candidate.context.categoryId],
    [filters.abstentions, candidate.context.abstained]
  ];
  if (values.some(([allowed, value]) => allowed !== void 0 && !allowed.includes(value))) return false;
  const confidence = candidate.context.confidence;
  if (filters.confidence === void 0) return true;
  if (confidence === null) return false;
  return (filters.confidence.min === void 0 || confidence >= filters.confidence.min) && (filters.confidence.max === void 0 || confidence <= filters.confidence.max);
}
function terminalVerifierOutcome(capture, manifest) {
  if (manifest.run.assessmentMode === "observational") return "unavailable";
  const workspaceId = manifest.terminal.workspaceArtifactId;
  if (workspaceId === void 0) return "unavailable";
  const outcomes = capture.records.flatMap(({ record: record3 }) => {
    if (record3.kind !== "verifier" || typeof record3.document !== "object" || record3.document === null) return [];
    const verifier = record3.document;
    return verifier.workspace?.artifactId === workspaceId && ["passed", "failed", "not-run", "error"].includes(String(verifier.status)) ? [verifier.status] : [];
  });
  const distinct = [...new Set(outcomes)];
  if (distinct.length > 1) throw new Error("Run bundle has conflicting verifier outcomes for the terminal workspace.");
  return distinct[0] ?? "unavailable";
}
function validateDecisionSemantics(decision, index) {
  if (decision.kind === "review" && decision.adjudicates !== void 0) throw new Error("A review decision cannot adjudicate prior decisions.");
  if (decision.kind !== "adjudication") return;
  if (decision.adjudicates === void 0 || decision.adjudicates.length < 2) throw new Error("An adjudication must bind at least two prior review decisions.");
  if (new Set(decision.adjudicates).size !== decision.adjudicates.length) throw new Error("Adjudication decision IDs must be unique.");
  const key = assertionKey(decision.assertion);
  for (const id of decision.adjudicates) {
    const target = index.byId.get(id);
    if (target === void 0 || target.kind !== "review" || assertionKey(target.assertion) !== key) {
      throw new Error(`Adjudication targets unknown or unrelated review decision "${id}".`);
    }
  }
  const current = [...index.latestReviews.get(key)?.values() ?? []].map(({ id }) => id).sort();
  if (canonicalizeMetadata([...decision.adjudicates].sort()) !== canonicalizeMetadata(current)) {
    throw new Error("Adjudication must bind the current latest decision from every reviewer.");
  }
}
function indexDecisions(decisions = []) {
  const index = { byId: /* @__PURE__ */ new Map(), latestReviews: /* @__PURE__ */ new Map() };
  for (const decision of decisions) indexDecision(index, decision);
  return index;
}
function indexDecision(index, decision) {
  index.byId.set(decision.id, decision);
  if (decision.kind !== "review") return;
  const key = assertionKey(decision.assertion);
  const reviews = index.latestReviews.get(key) ?? /* @__PURE__ */ new Map();
  reviews.set(decision.reviewer.id, decision);
  index.latestReviews.set(key, reviews);
}
function effectiveReviewOutcome(candidate, decisions) {
  if (candidate.context.abstained) return "judge-abstained";
  const own = decisions.filter(({ assertion }) => assertionKey(assertion) === assertionKey(candidate.assertion));
  const adjudication = currentAdjudication(own);
  if (adjudication !== void 0) return adjudication.state === "confirmed" ? "confirmed" : adjudication.state === "rejected" ? "rejected" : "unresolved";
  const reviews = latestHumanReviews(own);
  if (reviews.length === 0) return "unreviewed";
  if (reviews.some(({ state }) => state === "disputed" || state === "insufficient-evidence")) return "unresolved";
  const states = new Set(reviews.map(({ state }) => state));
  if (states.size !== 1) return "unresolved";
  return states.has("confirmed") ? "confirmed" : "rejected";
}
function isDisputedReviewOutcome(candidate, decisions) {
  if (effectiveReviewOutcome(candidate, decisions) !== "unresolved") return false;
  const own = decisions.filter(({ assertion }) => assertionKey(assertion) === assertionKey(candidate.assertion));
  const adjudication = currentAdjudication(own);
  if (adjudication !== void 0) return adjudication.state === "disputed";
  const reviews = latestHumanReviews(own);
  return reviews.some(({ state }) => state === "disputed") || new Set(reviews.filter(({ state }) => state !== "insufficient-evidence").map(({ state }) => state)).size > 1;
}
function currentAdjudication(decisions) {
  const lastReviewIndex = decisions.findLastIndex(({ kind }) => kind === "review");
  const adjudicationIndex = decisions.findLastIndex(({ kind }) => kind === "adjudication");
  return adjudicationIndex > lastReviewIndex ? decisions[adjudicationIndex] : void 0;
}
function latestHumanReviews(decisions) {
  const latest = /* @__PURE__ */ new Map();
  for (const decision of decisions) {
    if (decision.kind === "review") latest.set(`${assertionKey(decision.assertion)}\0${decision.reviewer.id}`, decision);
  }
  return [...latest.values()];
}
function readManifest2(bundleRoot) {
  const path = join5(bundleRoot, "manifest.json");
  const manifest = readJson(path);
  const errors = [...validateArtifact(path, manifest), ...validateRunManifestEvidence(path, manifest, bundleRoot)];
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  return manifest;
}
function readJson(path) {
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(path));
  assertNoDuplicateJsonKeys(text9);
  return JSON.parse(text9);
}
function assertValid2(label, value) {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}
function digest3(value) {
  return `sha256:${digestMetadata(value).value}`;
}
function seededKey(seed, stratum, assertion) {
  return createHash7("sha256").update(canonicalizeMetadata([seed, stratum, assertion.id, assertion.digest])).digest("hex");
}
function assertionKey(assertion) {
  return canonicalizeMetadata([assertion.id, assertion.schemaVersion, assertion.digest]);
}
function sourceKey(bundleRoot, assertionPath, taskContext) {
  return canonicalizeMetadata([bundleRoot, assertionPath, taskContext]);
}

// src/aggregation.ts
init_scheduler();
function aggregateEvaluation(input, policy) {
  return aggregateValidatedEvaluation(input, policy);
}
function selectAggregationAttempts(entries, policy, origins = "owned") {
  if (!["owned", "imported", "separate"].includes(origins)) throw new Error("Invalid evidence-origin selection.");
  if (!["all-attempts", "latest-attempt-per-run"].includes(policy)) throw new Error("Invalid attempt selection policy.");
  return selectAttempts(uniqueAttempts(entries, origins).attempts, policy);
}
async function aggregateValidatedEvaluation(input, policy) {
  assertPolicy(policy);
  const { attempts, duplicates } = uniqueAttempts(input.corpusEntries, policy.evidenceOrigins ?? "owned");
  const selected = selectAttempts(attempts, policy.selectedAttemptPolicy);
  const includedOriginIds = new Set(attempts.map(attemptKey));
  const excludedOriginIds = new Set(input.corpusEntries.filter((entry) => ["run", "import"].includes(entry.manifestKind) && entry.runId !== void 0 && entry.attemptId !== void 0 && !includedOriginIds.has(attemptKey(entry))).map((entry) => attemptKey(entry)));
  const includedSource = ({ document }) => !excludedOriginIds.has(attemptKey(document));
  const observationSources = uniqueBy(input.observationSets.filter(includedSource), ({ document }) => `${document.runId}\0${document.attemptId}`, "observation set");
  const observations = /* @__PURE__ */ new Map();
  for (const { bundleRoot, document } of observationSources.values()) {
    assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
    const rebuilt = await createRetainedStructuralObservationSet(bundleRoot);
    const { capabilityProfile: _capabilityProfile, ...legacyNormalization } = rebuilt.normalization;
    const comparable = document.normalization.capabilityProfile === void 0 ? { ...rebuilt, normalization: legacyNormalization } : rebuilt;
    if (canonicalizeMetadata(comparable) !== canonicalizeMetadata(document)) throw new Error(`Structural observation set for attempt "${document.attemptId}" is stale.`);
    observations.set(`${document.runId}\0${document.attemptId}`, rebuilt);
  }
  const assertionSources = uniqueBy(input.assertions.filter(includedSource), ({ document }) => assertionKey2(document), "behavior assertion");
  const assertions = /* @__PURE__ */ new Map();
  for (const { bundleRoot, document } of assertionSources.values()) {
    assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
    await validateRetainedBehaviorAssertion(bundleRoot, document);
    assertions.set(assertionKey2(document), document);
  }
  for (const { selection } of input.calibrations) await revalidateReviewSample(selection);
  const reviewOutcomes = reviewOutcomeIndex(input.calibrations);
  const selectedIds = new Set(selected.map(attemptKey));
  const groupBy = attempts.some((attempt) => evidenceOrigin(attempt) === "imported") && !policy.groupBy.includes("evidence-origin") ? [...policy.groupBy, "evidence-origin"] : [...policy.groupBy];
  const groups = groupAttempts(attempts, groupBy).map(([dimensions, allMembers]) => {
    const members = allMembers.filter((attempt) => selectedIds.has(attemptKey(attempt)));
    return {
      dimensions,
      metrics: groupMetrics(members, attempts, observations, assertions, reviewOutcomes, dimensions),
      behaviors: behaviorAggregates(members, assertions, reviewOutcomes),
      variations: [
        variation("terminal-state", members, policy.recurrence.minimumOccurrences),
        variation("verifier-status", members, policy.recurrence.minimumOccurrences)
      ]
    };
  });
  const report = {
    schemaVersion: "ebo.aggregation-report/v1",
    policy: {
      groupBy,
      ...policy.evidenceOrigins === void 0 ? {} : { evidenceOrigins: policy.evidenceOrigins },
      selectedAttemptPolicy: policy.selectedAttemptPolicy,
      recurrence: {
        minimumOccurrences: policy.recurrence.minimumOccurrences,
        establishesCausality: false,
        establishesStatisticalSignificance: false
      }
    },
    sourcePopulation: {
      uniqueRuns: new Set(attempts.map(({ runId }) => runId)).size,
      uniqueAttempts: attempts.length,
      selectedAttempts: selected.length,
      duplicateInputsIgnored: duplicates
    },
    sourceLineage: {
      requestDigest: input.lineage?.requestDigest ?? metadataDigest({ policy, comparisons: input.comparisons.map(({ eligibility: _eligibility, ...comparison }) => comparison) }),
      corpusIndexDigest: input.lineage?.corpusIndexDigest ?? metadataDigest(input.corpusEntries),
      manifests: attempts.map(({ runId, attemptId, manifestDigest: digest5 }) => ({ runId, attemptId, digest: digest5 })),
      observationSets: [...observationSources.values()].map(({ document }) => ({ runId: document.runId, attemptId: document.attemptId, digest: metadataDigest(document) })),
      assertions: [...assertionSources.values()].map(({ document }) => ({ runId: document.runId, attemptId: document.attemptId, id: document.id, digest: metadataDigest(document) })),
      calibrations: input.calibrations.map(({ selection, history }) => ({ selectionDigest: metadataDigest(selection), historyDigest: metadataDigest(history) })),
      comparisonGates: input.comparisons.flatMap(({ eligibility }) => eligibility.map(({ request, report: report2 }) => ({
        requestDigest: metadataDigest(request),
        reportDigest: metadataDigest(report2)
      })))
    },
    groups,
    comparisons: input.comparisons.map((comparison) => compare(
      comparison,
      selected,
      observations,
      policy.recurrence.minimumOccurrences
    )),
    limitations: [
      "All aggregates are descriptive; no causal attribution or statistical significance is claimed.",
      "Observational completion is a terminal-state measure, not task success.",
      "Verifier rates include only verified attempts with an available terminal verifier result.",
      "Human-reviewed assertion rates include only digest-bound calibration selections and validated review lineage."
    ]
  };
  assertArtifact2("aggregation report", report);
  return report;
}
function behaviorAggregates(selected, assertions, reviews) {
  const selectedIds = new Set(selected.map(attemptKey));
  const partitions = /* @__PURE__ */ new Map();
  for (const assertion of assertions.values()) {
    if (!selectedIds.has(attemptKey(assertion))) continue;
    const key = canonicalizeMetadata({ behavior: assertion.behavior, rubric: assertion.rubric, evaluator: assertion.evaluator });
    const values = partitions.get(key) ?? [];
    values.push(assertion);
    partitions.set(key, values);
  }
  return [...partitions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => {
    const first = values[0];
    const included = /* @__PURE__ */ new Set();
    const assessments = [];
    const exclusions = [];
    const outcome = (assertion) => reviews.get(assertionBindingKey(assertion)) ?? {
      outcome: assertion.judgment.disposition === "abstained" ? "judge-abstained" : "unreviewed",
      disputed: false
    };
    for (const attempt of selected) {
      const candidates = values.filter((assertion) => attemptKey(assertion) === attemptKey(attempt));
      const assessed = candidates.filter((assertion) => assertion.judgment.disposition === "assessed");
      const judgments = new Set(assessed.flatMap(({ judgment }) => judgment.disposition === "assessed" ? [judgment.assessment] : []));
      if (judgments.size === 1) {
        assessments.push([...judgments][0]);
        for (const assertion of assessed) included.add(assertionKey2(assertion));
      } else exclusions.push(judgments.size > 1 ? "conflicting-judge-reruns" : candidates.length === 0 ? "dimension-assertion-missing" : "no-assessed-judgment");
    }
    return {
      behavior: structuredClone(first.behavior),
      rubric: structuredClone(first.rubric),
      evaluator: structuredClone(first.evaluator),
      population: "judge-assessed-attempt-dimension",
      assessments: ["constructive", "adverse", "mixed", "context-dependent"].map((assessment) => ({
        assessment,
        measurement: rateMetric(
          assessment,
          "attempt",
          assessments.filter((value) => value === assessment).length,
          assessments.length,
          "judge-assessed-attempt-dimension",
          exclusionCounts(exclusions, "attempt-dimension")
        ).measurement
      })),
      assertions: values.map((assertion) => ({
        runId: assertion.runId,
        attemptId: assertion.attemptId,
        id: assertion.id,
        digest: metadataDigest(assertion),
        reviewOutcome: outcome(assertion).outcome,
        disputed: outcome(assertion).disputed,
        included: included.has(assertionKey2(assertion))
      }))
    };
  });
}
function groupMetrics(selected, all, observations, assertions, reviews, dimensions) {
  const selectedIds = new Set(selected.map(attemptKey));
  const relatedAll = all.filter((attempt) => matches(attempt, dimensions));
  const selectionExclusions = exclusionCounts(relatedAll.filter((attempt) => !selectedIds.has(attemptKey(attempt))).map(() => "not-selected-by-attempt-policy"), "attempt");
  const infrastructureEligible = selected.filter((attempt) => evidenceOrigin(attempt) === "owned" || attempt.failureClass !== void 0);
  const terminalEligible = selected.filter((attempt) => evidenceOrigin(attempt) === "owned" || attempt.terminalState !== void 0);
  const metrics = [
    metric("attempt-count", "attempt", selected.length, relatedAll.length, "attempt", "attempt", selectionExclusions),
    rateMetric("infrastructure-failure-rate", "attempt", infrastructureEligible.filter(({ failureClass }) => failureClass === "infrastructure").length, infrastructureEligible.length, "attempt", exclusionCounts(selected.filter((attempt) => evidenceOrigin(attempt) === "imported" && attempt.failureClass === void 0).map(() => "imported-failure-class-unavailable"), "attempt")),
    rateMetric(
      "capture-qualified-rate",
      "attempt",
      selected.filter(({ captureQualification }) => captureQualification === "qualified" || captureQualification === "qualified-with-gaps").length,
      selected.filter(({ captureQualification }) => captureQualification !== void 0 && captureQualification !== "unavailable").length,
      "attempt",
      exclusionCounts(selected.flatMap(({ captureQualification }) => captureQualification === void 0 || captureQualification === "unavailable" ? ["capture-qualification-unavailable"] : []), "attempt")
    ),
    rateMetric("terminal-completed-rate", "attempt", terminalEligible.filter(({ terminalState }) => terminalState === "completed").length, terminalEligible.length, "attempt", exclusionCounts(selected.filter((attempt) => evidenceOrigin(attempt) === "imported" && attempt.terminalState === void 0).map(() => "imported-terminal-state-unavailable"), "attempt"))
  ];
  const verified = selected.filter(({ assessmentMode, verifierStatuses }) => assessmentMode === "verified" && verifierStatuses.length === 1 && ["passed", "failed"].includes(verifierStatuses[0]));
  metrics.push(rateMetric(
    "verifier-pass-rate",
    "attempt",
    verified.filter(({ verifierStatuses }) => verifierStatuses[0] === "passed").length,
    verified.length,
    "verified-attempt",
    exclusionCounts(selected.flatMap((attempt) => attempt.assessmentMode !== "verified" ? ["observational-or-unknown-assessment-mode"] : attempt.verifierStatuses.length !== 1 || !["passed", "failed"].includes(attempt.verifierStatuses[0]) ? ["verifier-outcome-unavailable-or-infrastructure"] : []), "attempt")
  ));
  const selectedObservationSets = selected.flatMap((attempt) => observations.get(attemptKey(attempt)) ?? []);
  metrics.push(rateMetric(
    "structural-observation-set-availability-rate",
    "attempt",
    selectedObservationSets.length,
    selected.length,
    "attempt",
    exclusionCounts(selected.flatMap((attempt) => observations.has(attemptKey(attempt)) ? [] : ["observation-set-missing"]), "attempt")
  ));
  const extractorIds = [...new Set(selectedObservationSets.flatMap(({ observations: values }) => values.map(({ extractor }) => extractor.id)))].sort();
  for (const extractorId of extractorIds) {
    const values = selected.map((attempt) => observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === extractorId)?.value);
    const known2 = values.flatMap((value) => value?.status === "known" ? [value] : []);
    const units = new Set(known2.map(({ unit }) => unit));
    const types = new Set(known2.map(({ value }) => typeof value));
    const exclusions = exclusionCounts(values.flatMap((value) => value?.status === "unavailable" ? [value.reason] : value === void 0 ? ["observation-set-missing"] : []), "attempt");
    if (units.size > 1 || types.size > 1) {
      metrics.push(unavailableMetric(`structural:${extractorId}`, "attempt", "Structural observation types or units differ within the group.", selected.length, "attempt"));
    } else if (types.has("number")) {
      metrics.push(metric(
        `structural:${extractorId}`,
        "attempt",
        known2.reduce((sum, { value }) => sum + Number(value), 0),
        known2.length,
        known2[0]?.unit ?? "observation-value",
        "attempt-with-known-observation",
        exclusions
      ));
    } else if (types.has("boolean")) {
      metrics.push(metric(
        `structural:${extractorId}`,
        "attempt",
        known2.filter(({ value }) => value === true).length,
        known2.length,
        "attempt-with-true-observation",
        "attempt-with-known-observation",
        exclusions
      ));
    } else {
      for (const value of [...new Set(known2.map(({ value: value2 }) => String(value2)))].sort()) {
        metrics.push(metric(
          `structural:${extractorId}:${value}`,
          "attempt",
          known2.filter((knownValue) => knownValue.value === value).length,
          known2.length,
          "attempt",
          "attempt-with-known-observation",
          exclusions
        ));
      }
      if (known2.length === 0) metrics.push(unavailableMetric(`structural:${extractorId}`, "attempt", "The eligible denominator is empty.", 0, "attempt", exclusions));
    }
  }
  const selectedAssertions = [...assertions.values()].filter(({ runId, attemptId }) => selectedIds.has(`${runId}\0${attemptId}`));
  metrics.push(rateMetric(
    "assertion-abstention-rate",
    "assertion",
    selectedAssertions.filter(({ judgment }) => judgment.disposition === "abstained").length,
    selectedAssertions.length,
    "assertion",
    []
  ));
  const reviewResults = selectedAssertions.map((assertion) => reviews.get(assertionBindingKey(assertion)) ?? {
    outcome: assertion.judgment.disposition === "abstained" ? "judge-abstained" : "unreviewed",
    disputed: false
  });
  const outcomes = reviewResults.map(({ outcome }) => outcome);
  const reviewed = outcomes.filter((outcome) => outcome === "confirmed" || outcome === "rejected" || outcome === "unresolved");
  metrics.push(rateMetric(
    "reviewed-assertion-confirmed-rate",
    "reviewed-assertion",
    reviewed.filter((outcome) => outcome === "confirmed").length,
    reviewed.length,
    "reviewed-assertion",
    exclusionCounts(outcomes.flatMap((outcome) => outcome === "unreviewed" || outcome === "judge-abstained" ? [outcome] : []), "assertion")
  ));
  metrics.push(rateMetric(
    "review-unresolved-rate",
    "assertion",
    outcomes.filter((outcome) => outcome === "unresolved" || outcome === "unreviewed" || outcome === "judge-abstained").length,
    outcomes.length,
    "assertion",
    []
  ));
  metrics.push(rateMetric(
    "review-disputed-rate",
    "assertion",
    reviewResults.filter(({ disputed }) => disputed).length,
    reviewResults.length,
    "assertion",
    []
  ));
  return metrics;
}
function variation(measure, attempts, recurrenceMinimum) {
  const values = attempts.flatMap((attempt) => measure === "terminal-state" ? attempt.terminalState === void 0 ? [] : [attempt.terminalState] : attempt.assessmentMode === "verified" && attempt.verifierStatuses.length === 1 ? [attempt.verifierStatuses[0]] : []);
  const excluded = attempts.length - values.length;
  const counts = /* @__PURE__ */ new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const distribution = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count2]) => rateMetric(`${measure}:${value}`, "attempt", count2, values.length, "attempt", excluded === 0 ? [] : [{ reason: `${measure}-unavailable`, count: excluded, unit: "attempt" }]));
  const secondMostFrequent = [...counts.values()].sort((left, right) => right - left)[1] ?? 0;
  return {
    measure,
    distribution,
    claimStatus: values.length === 0 ? "unavailable" : secondMostFrequent === 0 ? "no-variation" : secondMostFrequent >= recurrenceMinimum ? "recurring-description" : "case-study"
  };
}
function compare(comparison, attempts, observations, recurrenceMinimum) {
  const gates = /* @__PURE__ */ new Map();
  for (const { request, report } of comparison.eligibility) {
    const rebuilt = assessComparisonEligibility(request);
    if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(report)) {
      throw new Error(`Comparison "${comparison.id}" has a stale eligibility report.`);
    }
    assertArtifact2("comparison report", report);
    const key = candidatePairKey(request.left, request.right);
    const current = gates.get(key);
    if (current !== void 0 && canonicalizeMetadata(current) !== canonicalizeMetadata({ request, report })) {
      throw new Error(`Comparison "${comparison.id}" has conflicting eligibility reports for one candidate pair.`);
    }
    gates.set(key, { request, report });
  }
  const left = attempts.filter((attempt) => matches(attempt, comparison.left));
  const right = attempts.filter((attempt) => matches(attempt, comparison.right));
  const exclusions = [
    ...left.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable"),
    ...right.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable")
  ];
  const leftByMatch = indexedMatches(left.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const rightByMatch = indexedMatches(right.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const keys = [.../* @__PURE__ */ new Set([...leftByMatch.keys(), ...rightByMatch.keys()])].sort();
  const differences = [];
  let differenceUnit;
  for (const key of keys) {
    const leftMatches = leftByMatch.get(key) ?? [];
    const rightMatches = rightByMatch.get(key) ?? [];
    if (leftMatches.length !== 1 || rightMatches.length !== 1) {
      exclusions.push(leftMatches.length === 0 || rightMatches.length === 0 ? "unmatched-unit" : "ambiguous-matched-unit");
      continue;
    }
    const gate = gates.get(candidatePairKey(
      { id: leftMatches[0].runId, manifestDigest: leftMatches[0].manifestDigest },
      { id: rightMatches[0].runId, manifestDigest: rightMatches[0].manifestDigest }
    ));
    if (gate === void 0) {
      exclusions.push("comparison-eligibility-missing");
      continue;
    }
    if (gate.report.status === "unsupported") {
      exclusions.push("comparison-eligibility-unsupported");
      continue;
    }
    if (gate.report.measure !== comparison.measure) {
      exclusions.push("comparison-measure-not-gated");
      continue;
    }
    if (measureCapabilities(comparison.measure, [leftMatches[0], rightMatches[0]], observations).some((capability) => !gate.report.policy.requiredCapabilities.includes(capability))) {
      exclusions.push("comparison-measure-capability-not-gated");
      continue;
    }
    const leftCandidate = gate.request.left.id === leftMatches[0].runId ? gate.request.left : gate.request.right;
    const rightCandidate = gate.request.left.id === rightMatches[0].runId ? gate.request.left : gate.request.right;
    if (!candidateMatchesAttempt(leftCandidate, leftMatches[0], observations) || !candidateMatchesAttempt(rightCandidate, rightMatches[0], observations)) {
      exclusions.push("comparison-candidate-evidence-mismatch");
      continue;
    }
    const leftValue = measureValue(leftMatches[0], comparison.measure, observations);
    const rightValue = measureValue(rightMatches[0], comparison.measure, observations);
    if (leftValue === void 0 || rightValue === void 0) exclusions.push("measure-unavailable");
    else if (leftValue.unit !== rightValue.unit || differenceUnit !== void 0 && differenceUnit !== leftValue.unit) exclusions.push("measure-unit-mismatch");
    else {
      differenceUnit = leftValue.unit;
      differences.push(rightValue.value - leftValue.value);
    }
  }
  const differing = differences.filter((value) => value !== 0).length;
  const measurement = differences.length === 0 ? unavailableMeasurement("No uniquely matched units have the requested measure on both sides.", 0, "matched-unit", exclusionCounts(exclusions, "matched-unit")) : availableMeasurement(
    differences.reduce((sum, value) => sum + value, 0),
    differences.length,
    `right-minus-left-${differenceUnit}`,
    "matched-unit",
    exclusionCounts(exclusions, "matched-unit")
  );
  return {
    id: comparison.id,
    measure: comparison.measure,
    eligibility: comparison.eligibility.map(({ report }) => structuredClone(report)),
    matchedDifference: measurement,
    differingMatchedUnits: differing,
    claimStatus: differences.length === 0 ? "unavailable" : differing === 0 ? "no-difference" : differing >= recurrenceMinimum ? "recurring-description" : "case-study",
    limitations: [
      ...new Set(comparison.eligibility.flatMap(({ report }) => report.reasons.map(({ detail }) => detail))),
      "Matched differences are descriptive and do not establish causality or statistical significance."
    ]
  };
}
function candidateMatchesAttempt(candidate, attempt, observations) {
  const exact = (candidate.evidenceOrigin?.kind ?? (candidate.harness.id.startsWith("atif.") ? "imported" : "owned")) === evidenceOrigin(attempt) && (evidenceOrigin(attempt) !== "imported" || candidate.evidenceOrigin?.profileDigest === attempt.producerProfileDigest) && candidate.id === attempt.runId && candidate.manifestDigest === attempt.manifestDigest && candidate.task.id === attempt.taskId && candidate.task.digest === attempt.taskDigest && candidate.fixture.id === attempt.fixtureId && candidate.fixture.digest === attempt.fixtureDigest && candidate.model.id === attempt.modelId && candidate.model.configurationDigest === attempt.modelConfigurationDigest && candidate.harness.id === attempt.harnessId && candidate.harness.version === attempt.harnessVersion && candidate.harness.configurationDigest === attempt.harnessConfigurationDigest && candidate.assessmentMode === attempt.assessmentMode && candidate.captureProfileDigest === attempt.captureProfileDigest && candidate.budgetDigest === attempt.budgetDigest && candidate.toolPolicyDigest === attempt.toolPolicyDigest;
  if (!exact) return false;
  const observationSet = observations.get(attemptKey(attempt));
  if (observationSet?.normalization.capabilityProfile === void 0) return false;
  return candidate.adapterVersion === observationSet.normalization.adapter.version && canonicalizeMetadata(candidate.capabilityProfile) === canonicalizeMetadata(observationSet.normalization.capabilityProfile);
}
function measureCapabilities(measure, attempts, observations) {
  if (measure === "attempt:infrastructure-failure" || measure === "attempt:terminal-completed" || measure === "verified:verifier-passed") {
    return ["family:outcome"];
  }
  if (measure.startsWith("structural:")) {
    const extractorId = measure.slice("structural:".length);
    return [...new Set(attempts.flatMap((attempt) => observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === extractorId)?.extractor.requiredCapabilities ?? []))];
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}
function candidatePairKey(left, right) {
  return canonicalizeMetadata([[left.id, left.manifestDigest], [right.id, right.manifestDigest]].sort((leftValue, rightValue) => canonicalizeMetadata(leftValue).localeCompare(canonicalizeMetadata(rightValue))));
}
function measureValue(attempt, measure, observations) {
  if (measure === "attempt:infrastructure-failure" && evidenceOrigin(attempt) === "imported" && attempt.failureClass === void 0) return void 0;
  if (measure === "attempt:infrastructure-failure") return { value: attempt.failureClass === "infrastructure" ? 1 : 0, unit: "attempt" };
  if (measure === "attempt:terminal-completed") return attempt.terminalState === void 0 ? void 0 : { value: attempt.terminalState === "completed" ? 1 : 0, unit: "attempt" };
  if (measure === "verified:verifier-passed") return attempt.assessmentMode !== "verified" || attempt.verifierStatuses.length !== 1 || !["passed", "failed"].includes(attempt.verifierStatuses[0]) ? void 0 : { value: attempt.verifierStatuses[0] === "passed" ? 1 : 0, unit: "verified-attempt" };
  if (measure.startsWith("structural:")) {
    const value = observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === measure.slice("structural:".length))?.value;
    return value?.status === "known" && (typeof value.value === "number" || typeof value.value === "boolean") ? { value: typeof value.value === "boolean" ? Number(value.value) : value.value, unit: value.unit } : void 0;
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}
function reviewOutcomeIndex(calibrations) {
  const outcomes = /* @__PURE__ */ new Map();
  for (const { selection, history } of calibrations) {
    validateReviewHistory(selection, history);
    for (const candidate of selection.candidates) {
      const key = bindingKey(candidate.assertion.id, candidate.assertion.digest);
      const outcome = {
        outcome: effectiveReviewOutcome(candidate, history.decisions),
        disputed: isDisputedReviewOutcome(candidate, history.decisions)
      };
      const current = outcomes.get(key);
      if (current !== void 0 && canonicalizeMetadata(current) !== canonicalizeMetadata(outcome)) throw new Error(`Calibration inputs conflict for assertion "${candidate.assertion.id}".`);
      outcomes.set(key, outcome);
    }
  }
  return outcomes;
}
function uniqueAttempts(entries, origins = "owned") {
  const attempts = /* @__PURE__ */ new Map();
  let duplicates = 0;
  for (const entry of entries) {
    if (!["run", "import"].includes(entry.manifestKind) || entry.runId === void 0 || entry.attemptId === void 0) continue;
    if (origins !== "separate" && evidenceOrigin(entry) !== origins) continue;
    const key = attemptKey(entry);
    const current = attempts.get(key);
    if (current === void 0) attempts.set(key, structuredClone(entry));
    else if (canonicalizeMetadata(current) === canonicalizeMetadata(entry)) duplicates += 1;
    else throw new Error(`Corpus inputs conflict for run "${entry.runId}" attempt "${entry.attemptId}".`);
  }
  return { attempts: [...attempts.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right))), duplicates };
}
function assertIndexedBundle(bundleRoot, runId, attemptId, attempts) {
  const indexed = attempts.filter((attempt) => attempt.runId === runId && attempt.attemptId === attemptId);
  if (indexed.length !== 1) throw new Error(`Derived source run "${runId}" attempt "${attemptId}" has no unique corpus entry.`);
  const actual = `sha256:${digestBytes(readBoundedFile(join6(resolve9(bundleRoot), "manifest.json"), "Derived source manifest")).value}`;
  if (actual !== indexed[0].manifestDigest) {
    throw new Error(`Derived source run "${runId}" attempt "${attemptId}" does not match the indexed manifest digest.`);
  }
}
function selectAttempts(attempts, policy) {
  if (policy === "all-attempts") return [...attempts];
  const latest = /* @__PURE__ */ new Map();
  for (const attempt of attempts) {
    const current = latest.get(attempt.runId);
    if (current === void 0 || (attempt.attemptNumber ?? -1) > (current.attemptNumber ?? -1)) latest.set(attempt.runId, attempt);
    else if ((attempt.attemptNumber ?? -1) === (current.attemptNumber ?? -1) && attempt.attemptId !== current.attemptId) {
      throw new Error(`Run "${attempt.runId}" has ambiguous latest attempts.`);
    }
  }
  return [...latest.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right)));
}
function groupAttempts(attempts, dimensions) {
  const groups = /* @__PURE__ */ new Map();
  for (const attempt of attempts) {
    const values = Object.fromEntries(dimensions.map((dimension) => [dimension, dimensionValue(attempt, dimension) ?? "unavailable"]));
    const key = canonicalizeMetadata(values);
    const group = groups.get(key) ?? [values, []];
    group[1].push(attempt);
    groups.set(key, group);
  }
  return [...groups.values()].sort(([left], [right]) => canonicalizeMetadata(left).localeCompare(canonicalizeMetadata(right)));
}
function dimensionValue(attempt, dimension) {
  return {
    task: attempt.taskId,
    model: attempt.modelId,
    harness: attempt.harnessId,
    trial: attempt.trialId,
    "capture-qualification": attempt.captureQualification,
    "evidence-origin": evidenceOrigin(attempt)
  }[dimension];
}
function matches(attempt, filters) {
  return Object.entries(filters).every(([dimension, value]) => (dimensionValue(attempt, dimension) ?? "unavailable") === value);
}
function indexedMatches(attempts, dimensions) {
  const result = /* @__PURE__ */ new Map();
  for (const attempt of attempts) {
    const key = canonicalizeMetadata(dimensions.map((dimension) => dimensionValue(attempt, dimension) ?? null));
    const values = result.get(key) ?? [];
    values.push(attempt);
    result.set(key, values);
  }
  return result;
}
function hasMissingDimension(attempt, dimensions) {
  return dimensions.some((dimension) => dimensionValue(attempt, dimension) === void 0);
}
function metric(id, population, numerator, denominator, numeratorUnit, denominatorUnit, exclusions) {
  const measurement = denominator === 0 ? unavailableMeasurement("The eligible denominator is empty.", numerator, denominatorUnit, exclusions, numeratorUnit) : availableMeasurement(numerator, denominator, numeratorUnit, denominatorUnit, exclusions);
  return { id, population, claimStatus: measurement.status === "available" ? "descriptive" : "unavailable", measurement };
}
function rateMetric(id, population, numerator, denominator, unit, exclusions) {
  return metric(id, population, numerator, denominator, unit, unit, exclusions);
}
function unavailableMetric(id, population, reason, denominator, unit, exclusions = []) {
  return { id, population, claimStatus: "unavailable", measurement: unavailableMeasurement(reason, 0, unit, exclusions, unit, denominator) };
}
function availableMeasurement(numerator, denominator, numeratorUnit, denominatorUnit, exclusions) {
  return { status: "available", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, rate: numerator / denominator, exclusions };
}
function unavailableMeasurement(reason, numerator, denominatorUnit, exclusions, numeratorUnit = denominatorUnit, denominator = 0) {
  return { status: "unavailable", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, exclusions, reason };
}
function exclusionCounts(reasons, unit) {
  const counts = /* @__PURE__ */ new Map();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count2]) => ({ reason, count: count2, unit }));
}
function uniqueBy(values, key, label) {
  const result = /* @__PURE__ */ new Map();
  for (const value of values) {
    const identity = key(value);
    const current = result.get(identity);
    if (current === void 0) result.set(identity, structuredClone(value));
    else if (canonicalizeMetadata(current) !== canonicalizeMetadata(value)) throw new Error(`Duplicate ${label} identity has conflicting content.`);
  }
  return result;
}
function assertPolicy(policy) {
  if (policy.evidenceOrigins !== void 0 && !["owned", "imported", "separate"].includes(policy.evidenceOrigins)) throw new Error("Invalid evidence-origin selection.");
  if (new Set(policy.groupBy).size !== policy.groupBy.length) throw new Error("Aggregate grouping dimensions must be unique.");
  if (!Number.isSafeInteger(policy.recurrence.minimumOccurrences) || policy.recurrence.minimumOccurrences < 2) {
    throw new Error("Aggregate recurrence minimum must be an integer of at least two.");
  }
}
function assertArtifact2(label, value) {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}
function attemptKey(attempt) {
  return `${attempt.runId}\0${attempt.attemptId}`;
}
function assertionKey2(assertion) {
  return `${assertion.runId}\0${assertion.attemptId}\0${assertion.id}`;
}
function assertionBindingKey(assertion) {
  return bindingKey(assertion.id, `sha256:${digestMetadata(assertion).value}`);
}
function bindingKey(id, digest5) {
  return `${id}\0${digest5}`;
}
function metadataDigest(value) {
  return `sha256:${digestMetadata(value).value}`;
}
function evidenceOrigin(entry) {
  return entry.manifestKind === "import" || entry.captureQualification === "imported" || entry.evidenceOrigin === "imported" ? "imported" : "owned";
}

// src/atlas.ts
init_artifacts();

// src/corpus.ts
import {
  closeSync as closeSync4,
  constants as constants4,
  fsyncSync as fsyncSync2,
  linkSync as linkSync2,
  mkdirSync as mkdirSync3,
  openSync as openSync4,
  readdirSync as readdirSync2,
  renameSync,
  rmSync,
  unlinkSync as unlinkSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { dirname as dirname6, join as join7, relative as relative5, resolve as resolve10, sep as sep5 } from "node:path";
init_artifacts();
init_contracts();
init_scheduler();
var INDEX_SCHEMA_VERSION = "ebo.corpus-index-entry/v1";
var MAX_CORPUS_MANIFESTS = 1e5;
var MAX_CORPUS_INDEX_BYTES = 512 * 1024 * 1024;
var MAX_PORTABLE_ARCHIVE_BYTES = 512 * 1024 * 1024;
var MAX_PORTABLE_ARCHIVE_MEMBERS = 1e4;
function buildCorpusIndex(corpusRoot) {
  const root = resolve10(corpusRoot);
  return discoverManifestPaths(root).map((manifestPath) => projectManifest(root, manifestPath));
}
function readCorpusIndex(path) {
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, "Corpus index", void 0, MAX_CORPUS_INDEX_BYTES)
  );
  if (text9.trim() === "") return [];
  return text9.trimEnd().split("\n").map((line, index) => {
    assertNoDuplicateJsonKeys(line);
    const entry = JSON.parse(line);
    assertCorpusIndexEntry(entry, index + 1);
    return entry;
  });
}
function validateCorpusIndex(corpusRoot, entries) {
  const issues = [];
  const indexed = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (indexed.has(entry.manifestPath)) {
      issues.push({ kind: "duplicate", manifestPath: entry.manifestPath, message: "Manifest path occurs more than once in the index." });
    } else indexed.set(entry.manifestPath, entry);
  }
  const current = new Map(buildCorpusIndex(corpusRoot).map((entry) => [entry.manifestPath, entry]));
  for (const [manifestPath, entry] of indexed) {
    const rebuilt = current.get(manifestPath);
    if (rebuilt === void 0) {
      issues.push({ kind: "missing", manifestPath, message: "Indexed manifest is missing from the corpus." });
    } else if (entry.manifestDigest !== rebuilt.manifestDigest) {
      issues.push({ kind: "digest-mismatch", manifestPath, message: "Indexed manifest digest does not match current bytes." });
    } else if (canonicalizeMetadata(entry) !== canonicalizeMetadata(rebuilt)) {
      issues.push({ kind: "stale", manifestPath, message: "Indexed fields no longer match the current manifest or evidence." });
    }
  }
  for (const [manifestPath, entry] of current) {
    if (!indexed.has(manifestPath)) {
      issues.push({ kind: "unindexed", manifestPath, message: "Corpus manifest is absent from the index." });
    }
    for (const issue of entry.issues) {
      issues.push({ kind: "evidence", manifestPath, message: `${issue.field}: ${issue.message}` });
    }
  }
  return issues.sort(compareValidationIssues);
}
function discoverManifestPaths(root) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync2(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join7(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name === "manifest.json") {
        if (!entry.isFile()) throw new Error(`Corpus manifest "${path}" is not a regular file.`);
        const locator = relative5(root, path).split(sep5).join("/");
        if (!isSafeArtifactRelativePath(locator)) throw new Error(`Corpus manifest path "${locator}" is unsafe.`);
        paths.push(locator);
        if (paths.length > MAX_CORPUS_MANIFESTS) throw new Error("Corpus exceeds the local manifest limit.");
      }
    }
  };
  visit(root);
  return paths.sort();
}
function projectManifest(root, manifestPath) {
  const bytes = readBoundedFile(join7(root, ...manifestPath.split("/")), "Corpus manifest");
  const manifestRoot = dirname6(join7(root, ...manifestPath.split("/")));
  const entry = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    manifestKind: "unknown",
    manifestPath,
    manifestDigest: digestString4(digestBytes(bytes)),
    verifierArtifactIds: [],
    verifierStatuses: [],
    captureArtifactIds: [],
    exportArtifactIds: [],
    issues: []
  };
  let document;
  try {
    document = parseJson5(bytes, `Corpus manifest ${manifestPath}`);
  } catch (error) {
    entry.issues.push({ field: "/", message: errorMessage3(error) });
    return entry;
  }
  const schemaVersion = isRecord10(document) ? document.schemaVersion : void 0;
  entry.manifestKind = schemaVersion === "run-manifest/v1" ? "run" : schemaVersion === "export-manifest/v1" ? "export" : schemaVersion === "ebo.import-manifest/v1" ? "import" : "unknown";
  entry.issues.push(...validateArtifact(manifestPath, document).map(({ field, message }) => ({ field, message })));
  if (!isRecord10(document)) return entry;
  if (typeof document.bundleId === "string") entry.bundleId = document.bundleId;
  if (entry.manifestKind === "run") projectRun(entry, document, manifestRoot);
  if (entry.manifestKind === "export") projectExport(entry, document, manifestRoot);
  if (entry.manifestKind === "import" && entry.issues.length === 0) {
    try {
      const { manifest, read } = readAtifImportAdmission(manifestRoot);
      const profile2 = selectAtifProducerProfile(manifest.producer);
      entry.runId = manifest.identity.runId;
      entry.attemptId = manifest.identity.attemptId;
      const sourceAgent = isRecord10(read.document?.agent) ? read.document.agent : void 0;
      if (typeof sourceAgent?.model_name === "string" && sourceAgent.model_name.trim() && sourceAgent.model_name.length <= 1024) entry.modelId = sourceAgent.model_name;
      entry.harnessId = profile2.status === "supported" ? profile2.profile.harness : "atif.unregistered";
      entry.harnessVersion = manifest.producer.agent.version ?? "unavailable";
      entry.captureQualification = "imported";
      entry.sharingClass = "restricted";
      entry.evidenceOrigin = "imported";
      entry.sourceFormat = manifest.producer.formatVersion;
      if (profile2.status === "supported") entry.producerProfileDigest = profile2.profileDigest;
      entry.captureArtifactIds = [manifest.source.artifactId];
    } catch (error) {
      entry.issues.push({ field: "/source", message: errorMessage3(error) });
    }
  }
  entry.issues = uniqueSourceIssues(entry.issues);
  return entry;
}
function projectRun(entry, manifest, manifestRoot) {
  entry.issues.push(...validateRunManifestEvidence(entry.manifestPath, manifest, manifestRoot).map(({ field, message }) => ({ field, message })));
  if (isRecord10(manifest.run)) {
    assignString(entry, "runId", manifest.run.id);
    if (isRecord10(manifest.run.trial)) {
      const trialIndex = numberValue(manifest.run.trial.index);
      if (trialIndex !== void 0) entry.trialId = String(trialIndex);
    }
    assignString(entry, "taskId", isRecord10(manifest.run.task) ? manifest.run.task.id : void 0);
    if (isRecord10(manifest.run.task)) assignDigest(entry, "taskDigest", manifest.run.task.digest);
    assignString(entry, "fixtureId", isRecord10(manifest.run.fixture) ? manifest.run.fixture.id : void 0);
    if (isRecord10(manifest.run.fixture)) assignDigest(entry, "fixtureDigest", manifest.run.fixture.digest);
    assignString(entry, "modelProvider", isRecord10(manifest.run.model) ? manifest.run.model.provider : void 0);
    assignString(entry, "modelId", isRecord10(manifest.run.model) ? manifest.run.model.id : void 0);
    if (isRecord10(manifest.run.model)) assignDigest(entry, "modelConfigurationDigest", manifest.run.model.configurationDigest);
    assignString(entry, "harnessId", isRecord10(manifest.run.harness) ? manifest.run.harness.id : void 0);
    assignString(entry, "harnessVersion", isRecord10(manifest.run.harness) ? manifest.run.harness.version : void 0);
    if (isRecord10(manifest.run.harness)) assignDigest(entry, "harnessConfigurationDigest", manifest.run.harness.configurationDigest);
    assignString(entry, "assessmentMode", manifest.run.assessmentMode ?? "verified");
    if (isRecord10(manifest.run.verifier)) {
      assignString(entry, "verifierLocator", manifest.run.verifier.locator);
      assignDigest(entry, "verifierDigest", manifest.run.verifier.digest);
    }
  }
  if (isRecord10(manifest.attempt)) {
    assignString(entry, "attemptId", manifest.attempt.id);
    const attemptNumber = numberValue(manifest.attempt.number);
    if (attemptNumber !== void 0) entry.attemptNumber = attemptNumber;
    assignString(entry, "retryOf", manifest.attempt.retryOf);
  }
  if (isRecord10(manifest.configuration)) {
    assignDigest(entry, "configurationDigest", manifest.configuration.digest);
    assignDigest(entry, "captureProfileDigest", manifest.configuration.captureProfileDigest);
    assignDigest(entry, "budgetDigest", manifest.configuration.budgetDigest);
    assignDigest(entry, "toolPolicyDigest", manifest.configuration.toolPolicyDigest);
  }
  if (isRecord10(manifest.terminal)) {
    assignString(entry, "terminalState", manifest.terminal.state);
    assignString(entry, "failureClass", manifest.terminal.failureClass);
    assignString(entry, "stopReason", manifest.terminal.stopReason);
  }
  projectEvidence(
    entry,
    manifestRoot,
    Array.isArray(manifest.evidence) ? manifest.evidence : [],
    isRecord10(manifest.terminal) && typeof manifest.terminal.workspaceArtifactId === "string" ? manifest.terminal.workspaceArtifactId : void 0,
    true
  );
}
function projectExport(entry, manifest, manifestRoot) {
  assignString(entry, "exportStatus", manifest.status);
  assignString(entry, "sharingClass", manifest.sharingClass);
  assignString(entry, "assessmentMode", manifest.assessmentMode ?? "verified");
  assignDigest(entry, "policyDigest", manifest.policyDigest);
  assignDigest(entry, "sourceManifestDigest", manifest.sourceManifestDigest);
  if (isRecord10(manifest.correlations)) {
    assignString(entry, "runId", manifest.correlations.runId);
    assignString(entry, "attemptId", manifest.correlations.attemptId);
  }
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  entry.exportArtifactIds = artifacts.filter(isRecord10).map(({ id }) => id).filter((id) => typeof id === "string");
  projectEvidence(entry, manifestRoot, artifacts);
  if (["ready", "exported"].includes(String(manifest.status))) {
    try {
      readApprovedPortableExport(manifestRoot);
    } catch (error) {
      entry.issues.push({ field: "/artifacts", message: errorMessage3(error) });
    }
  }
}
function projectEvidence(entry, root, descriptors, terminalWorkspaceArtifactId, terminalVerifierOnly = false) {
  for (const candidate of descriptors) {
    if (!isRecord10(candidate) || typeof candidate.id !== "string") continue;
    const descriptor = candidate;
    if (descriptor.kind === "verifier") {
      entry.verifierArtifactIds.push(descriptor.id);
      const document = readDescriptorJson(root, candidate, entry.issues);
      const workspace = isRecord10(document) && isRecord10(document.workspace) ? document.workspace : void 0;
      if (isRecord10(document) && typeof document.status === "string" && (!terminalVerifierOnly || !isRecord10(candidate.sanitizedFrom) && terminalWorkspaceArtifactId !== void 0 && workspace?.artifactId === terminalWorkspaceArtifactId)) {
        entry.verifierStatuses.push(document.status);
      }
    } else if (descriptor.kind === "capture-report") {
      entry.captureArtifactIds.push(descriptor.id);
      const document = readDescriptorJson(root, candidate, entry.issues);
      if (isRecord10(document)) {
        const structural = document.structuralQualification;
        const status = isRecord10(structural) ? structural.status : structural === void 0 ? document.qualification : void 0;
        if (["qualified", "qualified-with-gaps", "incomplete", "unqualified", "unavailable"].includes(String(status))) {
          assignString(entry, "captureQualification", status);
        } else entry.captureQualification = "unavailable";
      }
    } else if (descriptor.kind === "export-manifest") entry.exportArtifactIds.push(descriptor.id);
  }
  entry.verifierArtifactIds.sort();
  entry.verifierStatuses.sort();
  entry.captureArtifactIds.sort();
  entry.exportArtifactIds.sort();
  const harbor = descriptors.filter(isRecord10).filter((d) => d.id === "harbor-result" && d.kind === "diagnostic");
  if (harbor.length === 1) {
    const document = readDescriptorJson(root, harbor[0], entry.issues);
    const native = isRecord10(document) && isRecord10(document.nativeCapture) ? document.nativeCapture : void 0;
    const task = isRecord10(document) && isRecord10(document.task) ? document.task : void 0;
    if (isRecord10(document) && document.sourceKind === "harbor-task" && ["observational", "verified"].includes(String(document.assessmentMode)) && task?.assessmentMode === document.assessmentMode && native?.runId === entry.runId && native?.attemptId === entry.attemptId && native?.assessmentMode === entry.assessmentMode) {
      entry.captureAssessmentMode = entry.assessmentMode;
      entry.assessmentMode = String(document.assessmentMode);
    } else {
      entry.issues.push({ field: "/evidence/harbor-result", message: "Harbor assessment does not bind to this native capture." });
    }
  }
}
function readDescriptorJson(root, descriptor, issues) {
  const { id, relativePath, digest: digest5 } = descriptor;
  if (typeof id !== "string" || typeof relativePath !== "string" || typeof digest5 !== "string" || digestValue2(digest5) === void 0) return void 0;
  try {
    return parseJson5(resolveBundleArtifact(root, {
      locator: relativePath,
      digest: parseDigest(digest5)
    }), `Evidence ${id}`);
  } catch (error) {
    issues.push({ field: `/evidence/${id}`, message: errorMessage3(error) });
    return void 0;
  }
}
function readApprovedPortableExport(exportRoot) {
  const root = resolve10(exportRoot);
  const manifestBytes = readBoundedFile(join7(root, "manifest.json"), "Portable export manifest");
  const manifest = parseApprovedExportManifest(manifestBytes);
  const files = /* @__PURE__ */ new Map([["bundle/manifest.json", manifestBytes]]);
  verifyPortableArtifacts(manifest, (artifact) => {
    const bytes = resolveBundleArtifact(root, {
      locator: artifact.relativePath,
      digest: parseDigest(artifact.digest)
    }, MAX_PORTABLE_ARCHIVE_BYTES);
    files.set(`bundle/${artifact.relativePath}`, bytes);
    return bytes;
  });
  if (files.size > MAX_PORTABLE_ARCHIVE_MEMBERS) throw new Error("Portable export exceeds the archive member limit.");
  const totalBytes = [...files.values()].reduce((total, bytes) => total + bytes.length, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new Error("Portable export exceeds the archive byte limit.");
  }
  return files;
}
function parseApprovedExportManifest(bytes) {
  const manifest = parseJson5(bytes, "Portable export manifest");
  const errors = validateArtifact("manifest.json", manifest);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  if (!isRecord10(manifest) || !["ready", "exported"].includes(String(manifest.status))) {
    throw new Error("Portable export manifest must be ready or exported.");
  }
  if (!["partner", "public"].includes(String(manifest.sharingClass))) {
    throw new Error("Portable export manifest must use partner or public sharing.");
  }
  if (!Array.isArray(manifest.artifacts)) throw new Error("Portable export manifest has no artifacts.");
  assertUniqueArtifactIdentities(manifest.artifacts.map(({ id, relativePath }) => ({ id, relativePath })));
  if (JSON.stringify(manifest.artifactIds) !== JSON.stringify(manifest.artifacts.map(({ id }) => id))) {
    throw new Error("Portable export artifact index does not match its descriptors.");
  }
  return manifest;
}
function verifyPortableArtifacts(manifest, read) {
  for (const artifact of manifest.artifacts) {
    const bytes = read(artifact);
    if (bytes === void 0) throw new Error(`Portable export omits artifact ${artifact.id}.`);
    if (bytes.length !== artifact.sizeBytes || digestString4(digestBytes(bytes)) !== artifact.digest) {
      throw new Error(`Portable artifact ${artifact.id} does not match its descriptor.`);
    }
  }
}
function assertCorpusIndexEntry(value, line) {
  if (!isRecord10(value)) throw new Error(`Corpus index line ${line} is invalid.`);
  const stringArrays = [value.verifierArtifactIds, value.verifierStatuses, value.captureArtifactIds, value.exportArtifactIds];
  const optionalStrings = [
    value.bundleId,
    value.runId,
    value.trialId,
    value.attemptId,
    value.retryOf,
    value.taskId,
    value.fixtureId,
    value.modelProvider,
    value.modelId,
    value.harnessId,
    value.harnessVersion,
    value.assessmentMode,
    value.terminalState,
    value.failureClass,
    value.stopReason,
    value.verifierLocator,
    value.captureQualification,
    value.exportStatus,
    value.sharingClass,
    value.captureAssessmentMode,
    value.sourceFormat
  ];
  if (value.schemaVersion !== INDEX_SCHEMA_VERSION || !["run", "export", "import", "unknown"].includes(String(value.manifestKind)) || typeof value.manifestPath !== "string" || !isSafeArtifactRelativePath(value.manifestPath) || digestValue2(value.manifestDigest) === void 0 || stringArrays.some((items) => !Array.isArray(items) || items.some((item) => typeof item !== "string")) || optionalStrings.some((item) => item !== void 0 && typeof item !== "string") || value.evidenceOrigin !== void 0 && !["owned", "imported"].includes(String(value.evidenceOrigin)) || value.attemptNumber !== void 0 && (typeof value.attemptNumber !== "number" || !Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1) || [value.manifestDigest, value.configurationDigest, value.verifierDigest, value.policyDigest, value.sourceManifestDigest, value.producerProfileDigest].some((digest5) => digest5 !== void 0 && digestValue2(digest5) === void 0) || !Array.isArray(value.issues) || value.issues.some((issue) => !isRecord10(issue) || typeof issue.field !== "string" || typeof issue.message !== "string")) {
    throw new Error(`Corpus index line ${line} is invalid.`);
  }
}
function uniqueSourceIssues(issues) {
  return [...new Map(issues.map((issue) => [`${issue.field}\0${issue.message}`, issue])).values()].sort((left, right) => left.field.localeCompare(right.field) || left.message.localeCompare(right.message));
}
function compareValidationIssues(left, right) {
  return left.manifestPath.localeCompare(right.manifestPath) || left.kind.localeCompare(right.kind) || left.message.localeCompare(right.message);
}
function parseJson5(bytes, label) {
  const text9 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text9);
  try {
    return JSON.parse(text9);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}
function parseDigest(value) {
  const digest5 = digestValue2(value);
  if (digest5 === void 0) throw new Error("Artifact digest is invalid.");
  return { algorithm: "sha256", value: digest5.slice("sha256:".length) };
}
function digestString4(value) {
  return `sha256:${value.value}`;
}
function digestValue2(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) ? value : void 0;
}
function numberValue(value) {
  return typeof value === "number" ? value : void 0;
}
function assignString(entry, field, value) {
  if (typeof value === "string") entry[field] = value;
}
function assignDigest(entry, field, value) {
  const digest5 = digestValue2(value);
  if (digest5 !== void 0) entry[field] = digest5;
}
function errorMessage3(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRecord10(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/atlas.ts
init_scheduler();
var ATLAS_FILTERS = ["model", "harness", "task", "trial", "capture", "origin", "outcome", "review", "category", "assessment", "q"];
var digest4 = (value) => `sha256:${digestMetadata(value).value}`;
var attemptKey2 = (value) => `${value.runId}\0${value.attemptId}`;
async function loadAtlas(requestPath) {
  const request = readJson2(requestPath);
  exactKeys(request, ["schemaVersion", "aggregationRequest", "title", "operatorNarrative", "reviewPackets", "traces", "grafanaUrl", "atlasUrl", "tempoDatasourceUid", "sharing"]);
  if (request.schemaVersion !== "ebo.atlas-request/v1" || typeof request.title !== "string" || !request.title.trim() || typeof request.aggregationRequest !== "string") throw new Error("Invalid or incompatible Atlas request.");
  if (request.operatorNarrative !== void 0 && typeof request.operatorNarrative !== "string") throw new Error("Operator narrative must be text.");
  if (request.grafanaUrl !== void 0) localUrl(request.grafanaUrl);
  if (request.atlasUrl !== void 0) localUrl(request.atlasUrl);
  const traceKeys = /* @__PURE__ */ new Set();
  for (const trace of request.traces ?? []) {
    if (typeof trace.runId !== "string" || !trace.runId || typeof trace.attemptId !== "string" || !trace.attemptId || !/^[a-f0-9]{32}$/u.test(trace.traceId) || !Number.isFinite(Date.parse(trace.originalStart)) || trace.replayStart !== void 0 && !Number.isFinite(Date.parse(trace.replayStart))) throw new Error("Invalid trace identity or timestamp.");
    const key = attemptKey2(trace);
    if (traceKeys.has(key)) throw new Error("Atlas trace attempt keys must be unique; conflicting trace bindings are not allowed.");
    traceKeys.add(key);
  }
  const base = dirname7(resolve11(requestPath));
  for (const path of request.reviewPackets ?? []) {
    if (typeof path !== "string" || !statSync(resolve11(base, path), { throwIfNoEntry: false })?.isFile()) throw new Error("Configured human review packet is unavailable.");
  }
  const aggregationPath = resolve11(base, request.aggregationRequest);
  const aggregation = readArtifact(aggregationPath);
  const aggregateBase = dirname7(aggregationPath);
  const source = aggregation.sources;
  const corpusRoot = resolve11(aggregateBase, source.corpusRoot);
  const corpusEntries = readCorpusIndex(resolve11(aggregateBase, source.corpusIndex));
  const issues = validateCorpusIndex(corpusRoot, corpusEntries);
  if (issues.length) throw new Error("Atlas corpus index is stale or invalid; rebuild and validate it before querying.");
  const input = {
    lineage: { requestDigest: digest4(aggregation), corpusIndexDigest: digest4(corpusEntries) },
    corpusEntries,
    observationSets: source.observationSets.map(({ bundleRoot, path }) => ({ bundleRoot: resolve11(aggregateBase, bundleRoot), document: readArtifact(resolve11(aggregateBase, path)) })),
    assertions: source.assertions.map(({ bundleRoot, path }) => ({ bundleRoot: resolve11(aggregateBase, bundleRoot), document: readArtifact(resolve11(aggregateBase, path)) })),
    calibrations: source.calibrations.map(({ selection, history }) => ({ selection: readArtifact(resolve11(aggregateBase, selection)), history: readArtifact(resolve11(aggregateBase, history)) })),
    comparisons: aggregation.comparisons.map(({ eligibilityGates, ...comparison }) => ({ ...comparison, eligibility: eligibilityGates.map(({ request: request2, report }) => ({ request: readArtifact(resolve11(aggregateBase, request2)), report: readArtifact(resolve11(aggregateBase, report)) })) }))
  };
  const validated = await aggregateEvaluation(input, aggregation);
  const cases = [];
  const secretFindings = [];
  const located = (caseKey, location) => ({ path, ...finding }) => {
    secretFindings.push({ ...finding, caseKey, caseLocation: `${location}${path}` });
  };
  const seenAssertions = /* @__PURE__ */ new Set();
  for (const entry of selectAggregationAttempts(corpusEntries, "all-attempts", aggregation.evidenceOrigins)) {
    const ownAssertions = input.assertions.filter(({ document }) => attemptKey2(document) === attemptKey2(entry));
    const context = {
      origin: evidenceOrigin(entry),
      ...entry.sourceFormat ? { sourceFormat: entry.sourceFormat } : {},
      ...entry.producerProfileDigest ? { producerProfileDigest: entry.producerProfileDigest } : {},
      runId: entry.runId,
      attemptId: entry.attemptId,
      model: entry.modelId ?? "unavailable",
      harness: entry.harnessId ?? "unavailable",
      harnessVersion: entry.harnessVersion ?? "unavailable",
      task: entry.taskId ?? "unavailable",
      trial: entry.trialId ?? "unavailable",
      capture: entry.captureQualification ?? "unavailable",
      outcome: entry.terminalState ?? "unavailable",
      ...entry.retryOf ? { retryOf: entry.retryOf } : {}
    };
    let trace;
    const traceSource = request.traces?.find((item) => attemptKey2(item) === attemptKey2(entry));
    if (traceSource) {
      if (request.grafanaUrl && request.tempoDatasourceUid) {
        const panes = { atlas: { datasource: request.tempoDatasourceUid, queries: [{ refId: "A", queryType: "traceId", query: traceSource.traceId }], range: { from: "now-1h", to: "now" } } };
        trace = { href: `${localUrl(request.grafanaUrl)}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(panes))}`, originalStart: traceSource.originalStart, ...traceSource.replayStart ? { replayStart: traceSource.replayStart } : {} };
      }
    }
    if (!ownAssertions.length) cases.push({ ...context, key: digest4(context).slice(7), category: "unavailable", assessment: "unavailable", review: "unavailable", decisions: [], citations: [], ...trace ? { trace } : {} });
    for (const { document: assertion, bundleRoot } of ownAssertions) {
      const assertionDigest = digest4(assertion);
      if (seenAssertions.has(assertionDigest)) continue;
      seenAssertions.add(assertionDigest);
      const reviews = input.calibrations.flatMap(({ selection, history }) => selection.candidates.filter(({ assertion: binding }) => binding.id === assertion.id && binding.digest === assertionDigest).map((candidate) => ({ candidate, history })));
      const latest = reviews[0];
      const outcome = latest ? effectiveReviewOutcome(latest.candidate, latest.history.decisions) : assertion.judgment.disposition === "abstained" ? "judge-abstained" : "unreviewed";
      const review = latest && isDisputedReviewOutcome(latest.candidate, latest.history.decisions) ? "disputed" : { "judge-abstained": "abstained", unreviewed: "proposed", unresolved: "insufficient-evidence", confirmed: "confirmed", rejected: "rejected" }[outcome];
      const evidence = await createRetainedBehaviorEvidence(bundleRoot);
      const caseKey = assertionDigest.slice(7);
      const citations2 = assertion.judgment.citations.map((citation, index) => {
        const normalizedEvent = evidence.dataset.events.find(({ id }) => id === citation.eventId);
        const native = evidence.capture.records.find(({ reference }) => canonicalizeMetadata(reference) === canonicalizeMetadata(citation.nativeReference));
        if (!normalizedEvent || !native) throw new Error("Atlas citation cannot resolve to normalized and native evidence.");
        const location = `/citations/${String(index)}`;
        return { ...citation, normalizedEvent: displaySafe(normalizedEvent, located(caseKey, `${location}/normalizedEvent`)), nativeRecord: displaySafe(evidence.dataset.adapter.harness === "claude-agent-sdk" ? native.record.document : native.record, located(caseKey, `${location}/nativeRecord`)) };
      });
      const decisions = [...new Map(reviews.flatMap(({ history }) => history.decisions.filter(({ assertion: binding }) => binding.id === assertion.id && binding.digest === assertionDigest)).map((decision) => [digest4(decision), decision])).values()];
      cases.push({ ...context, key: caseKey, assertion: displaySafe(assertion, located(caseKey, "/assertion")), assertionDigest, category: assertion.behavior.categoryId, assessment: assertion.judgment.disposition === "assessed" ? assertion.judgment.assessment : "abstained", review, decisions: displaySafe(decisions, located(caseKey, "/decisions")), citations: citations2, ...trace ? { trace } : {} });
    }
  }
  return { request, aggregation, input, corpusRoot, requestPath: resolve11(requestPath), cases, sourceDigest: digest4({ request, lineage: validated.sourceLineage }), secretFindings };
}
async function queryAtlas(source, filters = {}) {
  exactKeys(filters, [...ATLAS_FILTERS]);
  for (const value of Object.values(filters)) if (typeof value !== "string" || value.length > 500) throw new Error("Invalid Atlas filter.");
  const eligible = selectAggregationAttempts(source.input.corpusEntries, source.aggregation.selectedAttemptPolicy, source.aggregation.evidenceOrigins);
  const eligibleIds = new Set(eligible.map(attemptKey2));
  const eligibleCases = source.cases.filter((item) => eligibleIds.has(attemptKey2(item)));
  const matches2 = eligibleCases.filter((item) => Object.entries(filters).every(([key, value]) => !value || (key === "q" ? [item.runId, item.attemptId, item.model, item.task, item.assertion?.judgment.rationale ?? "", item.category].join(" ").toLocaleLowerCase().includes(value.toLocaleLowerCase()) : item[key] === value)));
  const ids = new Set(matches2.map(attemptKey2));
  const corpusEntries = source.input.corpusEntries.filter((entry) => ids.has(attemptKey2(entry)));
  const report = await aggregateEvaluation({ ...source.input, lineage: { ...source.input.lineage, corpusIndexDigest: digest4(corpusEntries) }, corpusEntries, observationSets: source.input.observationSets.filter(({ document }) => ids.has(attemptKey2(document))), assertions: source.input.assertions.filter(({ document }) => ids.has(attemptKey2(document))) }, source.aggregation);
  const filterOptions = Object.fromEntries(ATLAS_FILTERS.filter((key) => key !== "q").map((key) => [key, [...new Set(eligibleCases.map((item) => String(item[key])))].sort()]));
  const sourceAttempts = new Set(source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run" || manifestKind === "import").map(attemptKey2)).size;
  const caseIndex = new Map(matches2.map(({ key }, index) => [key, index]));
  const findings = source.secretFindings.flatMap(({ caseLocation, ...finding }) => {
    const index = caseIndex.get(finding.caseKey);
    return index === void 0 ? [] : [{ ...finding, location: `/cases/${String(index)}${caseLocation}` }];
  });
  const operatorNarrative = source.request.operatorNarrative ? displaySafe({ text: source.request.operatorNarrative }, ({ path: _path, ...finding }) => {
    findings.push({ ...finding, location: "/operatorNarrative" });
  }).text : void 0;
  const secretScan = { redacted: findings.filter(({ disposition }) => disposition === "redacted").length, notSecret: findings.filter(({ disposition }) => disposition === "not-secret").length, findings };
  return { schemaVersion: "ebo.atlas-view/v1", title: source.request.title, atlasUrl: localUrl(source.request.atlasUrl ?? "http://127.0.0.1:13011"), mode: "restricted-local-only", generatedAt: (/* @__PURE__ */ new Date()).toISOString(), sourceDigest: source.sourceDigest, cohortDigest: digest4({ source: source.sourceDigest, filters, lineage: report.sourceLineage }), filters, filterOptions, report, cases: matches2, matchingCases: matches2.length, sourceAttempts, policyExcludedAttempts: sourceAttempts - eligible.length, filteredOutAttempts: eligible.length - ids.size, ...operatorNarrative === void 0 ? {} : { operatorNarrative }, reviewPackets: (source.request.reviewPackets ?? []).map((path) => pathToFileURL(resolve11(dirname7(source.requestPath), path)).href), ...source.request.grafanaUrl ? { grafanaUrl: localUrl(source.request.grafanaUrl) } : {}, secretScan };
}
function readJson2(path) {
  const text9 = readBoundedFile(path).toString("utf8");
  assertNoDuplicateJsonKeys(text9);
  return JSON.parse(text9);
}
function displaySafe(value, onFinding) {
  return sanitizeDerivedExport(value, { sharingClass: "partner", maxArtifactBytes: 16 * 1024 * 1024, maxStringBytes: 128 * 1024 }, [], onFinding);
}
function readArtifact(path) {
  const value = readJson2(path);
  const errors = validateArtifact(path, value);
  if (errors.length) throw new Error(`Invalid Atlas source: ${errors[0].field} ${errors[0].message}`);
  return value;
}
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown or invalid Atlas fields.");
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Atlas integration URL must be a local HTTP origin.");
  return url.origin;
}

// src/atlas-bundle.ts
import { Field, List, makeVector, Table, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";

// src/atlas-evidence.ts
init_artifacts();

// src/atlas-bundle.ts
function assertContainedPath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/u.test(path) || path.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new Error(`Manifest path ${JSON.stringify(path)} is not a contained relative path.`);
}

// src/atlas-viewer.ts
import { dirname as dirname8, extname, join as join9, resolve as resolve12, sep as sep6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var ATLAS_VIEWER_ROOT = resolve12(dirname8(fileURLToPath2(import.meta.url)), "..", "..", "viewer", "dist");

// src/atlas-packet.ts
var sha256 = (data) => `sha256:${createHash8("sha256").update(data).digest("hex")}`;
function roCrate(manifest) {
  return {
    "@context": ["https://w3id.org/ro/crate/1.2/context", { ebo: "urn:ebo:terms#", layer: "ebo:layer", variant: "ebo:variant", redactions: "ebo:redactions" }],
    "@graph": [
      { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", about: { "@id": "./" }, conformsTo: [{ "@id": "https://w3id.org/ro/crate/1.2" }, { "@id": "urn:ebo:profile:evidence-packet:v1" }] },
      {
        "@id": "./",
        "@type": "Dataset",
        name: `${manifest.packet.title}: evidence packet`,
        datePublished: manifest.packet.created,
        variant: manifest.packet.variant,
        mainEntity: { "@id": "index.html" },
        hasPart: manifest.files.map(({ path }) => ({ "@id": path }))
      },
      ...manifest.files.map((f) => ({
        "@id": f.path,
        "@type": "File",
        encodingFormat: f.mediaType,
        contentSize: String(f.bytes),
        sha256: f.sha256.slice(7),
        layer: f.layer,
        ...f.redactions === void 0 ? {} : { redactions: f.redactions }
      })),
      { "@id": "#build", "@type": "CreateAction", name: `${manifest.packet.builder.id} ${manifest.packet.builder.version}`, endTime: manifest.packet.created, result: { "@id": "./" } }
    ]
  };
}
function verifyPacket(root) {
  const manifest = JSON.parse(readFileSync4(join10(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== "ebo.packet/v1") throw new Error("Not an EBO packet manifest.");
  for (const { path } of [...manifest.files, ...manifest.withheld]) assertContainedPath(path);
  const walk = (dir) => readdirSync3(join10(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join10(dir, e.name)) : [join10(dir, e.name)]);
  const listed = new Set(manifest.files.map(({ path }) => path));
  const present = walk("").map((p) => relative6(".", p).replace(/\\/gu, "/")).filter((p) => p !== "manifest.json" && p !== "ro-crate-metadata.json");
  const missing2 = manifest.files.filter(({ path }) => !existsSync(join10(root, path))).map(({ path }) => path);
  const changed = manifest.files.filter(({ path, bytes, sha256: d }) => existsSync(join10(root, path)) && (statSync2(join10(root, path)).size !== bytes || sha256(readFileSync4(join10(root, path))) !== d)).map(({ path }) => path);
  const unlisted = present.filter((p) => !listed.has(p));
  const crate = join10(root, "ro-crate-metadata.json");
  if (!existsSync(crate)) missing2.push("ro-crate-metadata.json");
  else {
    const { roCrate: binding, ...rest } = manifest;
    const text9 = readFileSync4(crate, "utf8");
    if (text9 !== `${JSON.stringify(roCrate(rest), null, 2)}
` || !binding || sha256(text9) !== binding.sha256) changed.push("ro-crate-metadata.json");
  }
  return { ok: !missing2.length && !changed.length && !unlisted.length, changed, missing: missing2, unlisted };
}
export {
  createRetainedBehaviorEvidence,
  createRetainedStructuralObservationSet,
  loadAtlas,
  queryAtlas,
  roCrate,
  validateRetainedBehaviorAssertion,
  validateStructuralObservationSet,
  verifyPacket
};
