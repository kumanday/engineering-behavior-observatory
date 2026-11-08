import { writeFileSync } from "node:fs";
import { renderCoverageMatrix } from "./atif-harness-coverage-helper.js";
writeFileSync(new URL("../../docs/reference/atif-harness-coverage.md", import.meta.url), await renderCoverageMatrix());
