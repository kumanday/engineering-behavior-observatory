import { validateBundle, type BundleValidationJob } from "./bundle-validation.js";

// A validation worker process: one bundle at a time, reporting the error message, if any, by job index.
process.on("message", (message: { index: number; job: BundleValidationJob }) => {
  validateBundle(message.job).then(
    () => process.send!({ index: message.index }),
    (error: unknown) => process.send!({ index: message.index, error: error instanceof Error ? error.message : String(error) }));
});
