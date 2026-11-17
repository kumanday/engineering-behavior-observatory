import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const compress = promisify(gzip);

/** Compress only the declared recorder route; native payload bytes remain unchanged after decoding. */
export function createPiGzipFetch(baseUrl: string, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/u, "") + "/";
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) {
      throw new Error("Pi compressed request escaped the declared recorder route.");
    }
    if (request.method !== "POST" || request.body === null) return fetchImpl(request);
    if (request.headers.has("content-encoding")) throw new Error("Pi request already has a content encoding.");
    request.signal.throwIfAborted();
    const original = Buffer.from(await request.arrayBuffer());
    const encoded = await compress(original);
    request.signal.throwIfAborted();
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-encoding", "gzip");
    headers.set("x-ebo-native-body-bytes", String(original.byteLength));
    headers.set("x-ebo-native-body-sha256", createHash("sha256").update(original).digest("hex"));
    return fetchImpl(new Request(request, { headers, body: new Uint8Array(encoded) }));
  };
}
