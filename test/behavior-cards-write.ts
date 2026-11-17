import { writeFileSync } from "node:fs";
import { loadDefaultBehaviorCardCatalog, renderBehaviorCardReference } from "../src/behavior-cards.js";
writeFileSync(new URL("../../docs/reference/behavior-cards.md", import.meta.url), renderBehaviorCardReference(loadDefaultBehaviorCardCatalog()));
