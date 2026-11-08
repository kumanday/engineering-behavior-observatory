import { createHash } from "node:crypto";
import type { StudyRuntimeOptions } from "../src/study-runtimes.js";

export function fakeOciRuntimeOptions(): StudyRuntimeOptions {
  const config = {created: "2026-11-05T00:00:00Z", os: "linux", architecture: process.arch === "x64" ? "amd64" : process.arch};
  const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const configDigest = hash(config), manifest = {schemaVersion: 2, config: {digest: configDigest}, layers: []};
  let user = "";
  return {now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url) => url.includes("/attestations/") || url.includes("/referrers/") || /\.(?:sig|att)$/u.test(url) ? new Response("", {status: 404}) : new Response(JSON.stringify(url.includes("tags/list") ? {tags: ["1.54.0-python"]} : url.includes("/blobs/") ? config : manifest)),
    run: async (_command, args) => {
      if (args[0] === "run") user = args.includes("--user") ? args[args.indexOf("--user") + 1]! : "";
      return {code: 0, stdout: args[0] === "run" ? "a".repeat(64) : args[0] === "container" ? JSON.stringify([{Image: configDigest, Config: {Image: `ghcr.io/openhands/agent-server@${hash(manifest)}`, User: user}, State: {Running: true}, NetworkSettings: {Ports: {"8000/tcp": [{HostIp: "127.0.0.1", HostPort: "8000"}]}}}]) : args.includes("inspect") ? JSON.stringify([{Id: configDigest}]) : "", stderr: ""};
    }};
}
