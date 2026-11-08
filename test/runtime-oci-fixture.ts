import {createHash} from "node:crypto";
import type {StudyRuntimeOptions} from "../src/study-runtimes.js";

export function fakeOciRuntimeOptions(architecture: string = process.arch): StudyRuntimeOptions {
  const config = {created: "2026-11-05T00:00:00Z", os: "linux", architecture: architecture === "x64" ? "amd64" : architecture,
    config: {Entrypoint: ["openhands-agent-server"], Env: ["PATH=/usr/bin:/bin"], WorkingDir: "/"}};
  const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const configDigest = hash(config), manifest = {schemaVersion: 2, config: {digest: configDigest}, layers: []};
  return {now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url) => url.includes("/attestations/") || url.includes("/referrers/") || /(?:\.(?:sig|att)|\/sha256-[a-f0-9]{64})$/u.test(url) ? new Response("", {status: 404}) : new Response(JSON.stringify(url.includes("tags/list") ? {tags: ["1.54.0-python"]} : url.includes("/blobs/") ? config : manifest)),
    run: async () => {throw new Error("OCI admission and Smol server ownership do not invoke Docker or other external commands in this fixture.");},
    startOpenHandsSmol: async request => {
      let stopped = false;
      return {baseUrl: "http://127.0.0.1:8000", binding: {kind: "smol-local-vm", machine: "ebo-openhands-authored", image: request.image, imageConfigDigest: request.configDigest, platform: request.platform, engineVersion: request.engineVersion}, stop: async () => {stopped = true;}, isStopped: () => stopped};
    }};
}
