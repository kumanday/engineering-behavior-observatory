import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";
import {digestBytes, digestMetadata, freezeTaskPacket, type ExperimentConfiguration, type TaskPacket} from "../src/index.js";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
function fixture(name: string): ExperimentConfiguration {
  return JSON.parse(readFileSync(join(repositoryRoot, "tests/fixtures", name), "utf8")) as ExperimentConfiguration;
}
function fixtureArchive(): Buffer {
  const entries = [
    { path: "README.md", bytes: Buffer.from("# fixture\n") },
    { path: "package.json", bytes: Buffer.from("{}\n") },
    { path: "src", bytes: Buffer.alloc(0), type: "5" },
    { path: "src/index.ts", bytes: Buffer.from("export {};\n") },
  ];
  const blocks = entries.map(({ path, bytes, type = "0" }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write(bytes.length.toString(8).padStart(11, "0"), 124, "ascii");
    header[156] = type.charCodeAt(0);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export function bundleFixture(): { root: string; experiment: ExperimentConfiguration } {
  const root = mkdtempSync(join(tmpdir(), "ebo-scheduler-bundle-"));
  const packet = JSON.parse(readFileSync(join(repositoryRoot, "tests", "fixtures", "task-packet.valid.v1.json"), "utf8")) as Extract<TaskPacket, { assessmentMode: "verified" }>;
  const writeRef = (reference: { locator: string; digest: { algorithm: "sha256"; value: string } }, locator: string, bytes: Buffer) => {
    reference.locator = locator;
    reference.digest = digestBytes(bytes);
    const path = join(root, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };

  writeRef(packet.agentInput.fixture.source, "components/fixture.tar.gz", fixtureArchive());
  if (!("reference" in packet.controlledPerturbation) || !("locator" in packet.restricted.referenceSolution)) {
    throw new Error("Fixture packet must include referenced components.");
  }
  writeRef(packet.controlledPerturbation.reference, "components/perturbation.json", Buffer.from("{\"kind\":\"controlled\"}\n"));
  writeRef(packet.restricted.referenceSolution, "components/reference.txt", Buffer.from("reference solution\n"));
  writeRef(packet.restricted.verifier, "components/verifier.sh", Buffer.from("#!/bin/sh\nexit 0\n"));
  const preAdmission = structuredClone(packet) as unknown as Record<string, unknown>;
  delete preAdmission.admission;
  const review = Buffer.from(JSON.stringify({
    preAdmissionDigest: digestMetadata(preAdmission),
    decision: packet.admission.status,
    reviewedAt: packet.admission.review!.reviewedAt,
    reviewedBy: packet.admission.review!.reviewedBy,
  }));
  writeRef(packet.admission.review!.reviewRecord, "components/review.json", review);
  const packetPath = join(root, "packets/task-a.json");
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet));
  const freezeLocator = "freezes/task-a.json";
  freezeTaskPacket(root, "packets/task-a.json", freezeLocator);

  const experiment = fixture("experiment.18-cell.v1.json");
  experiment.id = "bundle-fixture";
  experiment.taskSet = {
    "task-a": { packetRef: { locator: "packets/task-a.json", digest: digestMetadata(packet) } },
  };
  experiment.modelSet = { "model-a": experiment.modelSet["model-a"]! };
  experiment.harnessSet = { "harness-a": experiment.harnessSet["harness-a"]! };
  experiment.trialCount = 1;
  experiment.ordering = {
    seed: "bundle-seed",
    strategy: "permuted",
    permutationAlgorithmRef: { locator: "algorithms/fisher-yates-v1.json", digest: digestBytes(Buffer.from("{\"algorithm\":\"fisher-yates-v1\"}")) },
  };
  writeRef(experiment.modelSet["model-a"]!.configurationRef, "configs/model.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.configurationRef, "configs/harness.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.nativeLimitsRef, "configs/limits.json", Buffer.from("{}"));
  writeRef(experiment.harnessSet["harness-a"]!.nativeToolPolicyRef, "configs/tools.json", Buffer.from("{}"));
  writeRef(experiment.captureProfile, "configs/capture.json", Buffer.from("{}"));
  const algorithm = Buffer.from("{\"algorithm\":\"fisher-yates-v1\"}");
  if (experiment.ordering.strategy !== "permuted" || experiment.ordering.permutationAlgorithmRef === undefined) {
    throw new Error("Fixture experiment must use a pinned permutation reference.");
  }
  writeRef(experiment.ordering.permutationAlgorithmRef, "algorithms/fisher-yates-v1.json", algorithm);
  return { root, experiment };
}

