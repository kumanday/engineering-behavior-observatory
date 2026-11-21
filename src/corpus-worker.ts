import { projectCorpusManifest } from "./corpus.js";

// A corpus index worker process: projects a slice of manifests and returns their entries by slice index.
process.on("message", (message: { index: number; root: string; paths: string[] }) => {
  try { process.send!({ index: message.index, entries: message.paths.map((path) => projectCorpusManifest(message.root, path)) }); }
  catch (error) { process.send!({ index: message.index, error: error instanceof Error ? error.message : String(error) }); }
});
