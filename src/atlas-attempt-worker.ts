import { processAttempt, type AttemptJob } from "./atlas-bundle.js";

// An Atlas bundle attempt worker process: one attempt at a time, returning its rows and documents by job index.
process.on("message", (message: { index: number; job: AttemptJob }) => {
  processAttempt(message.job).then(
    (result) => process.send!({ index: message.index, result }),
    (error: unknown) => process.send!({ index: message.index, error: error instanceof Error ? error.message : String(error) }));
});
