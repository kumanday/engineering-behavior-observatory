import { createHash } from "node:crypto";
import type { StudyRuntimeOptions } from "../src/study-runtimes.js";

export function fakeOciRuntimeOptions(): StudyRuntimeOptions {
  const config = {created: "2026-11-05T00:00:00Z", os: "linux", architecture: process.arch === "x64" ? "amd64" : process.arch};
  const hash = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
  const configDigest = hash(config), manifest = {schemaVersion: 2, config: {digest: configDigest}, layers: []};
  return {now: () => "2026-11-07T12:00:00Z", query: async () => ({}), fetch: async (url) => new Response(JSON.stringify(url.includes("tags/list") ? {tags: ["1.54.0-python"]} : url.includes("/blobs/") ? config : manifest)),
    run: async (_command, args) => ({code: 0, stdout: args.includes("inspect") ? JSON.stringify([{Id: configDigest}]) : "", stderr: ""})};
}
