import { writeFileSync } from "node:fs";
import { loadDefaultBehaviorOntology, renderBehaviorOntologyReference } from "../src/behavior-ontology.js";
writeFileSync(new URL("../../docs/reference/behavior-ontology.md", import.meta.url), renderBehaviorOntologyReference(loadDefaultBehaviorOntology()));
