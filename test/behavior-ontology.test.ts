import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  assertBehaviorOntology,
  BEHAVIOR_DIRECTIONS,
  BEHAVIOR_PRODUCER_MODES,
  BEHAVIOR_VERDICTS,
  behaviorCardFamilies,
  behaviorDirection,
  behaviorOntologyDigest,
  decideFromProbabilities,
  loadDefaultBehaviorOntology,
  renderBehaviorOntologyReference,
  resolveBehaviorCard,
  resolveBehaviorDecision,
  validateArtifact,
  type BehaviorOntology,
} from "../src/index.js";
import { containsPortableLocalHomePath, containsPortableSecretPattern } from "../src/exports.js";
import { semanticJudgeResponseSchema } from "../src/semantic-judge.js";

const ontologyText = readFileSync(new URL("../../ontology/behavior-ontology.v2.json", import.meta.url), "utf8");
const referenceText = readFileSync(new URL("../../docs/reference/behavior-ontology.md", import.meta.url), "utf8");
type Mutable<T> = T extends ReadonlyArray<infer U> ? Array<Mutable<U>> : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Draft = Mutable<BehaviorOntology>;
const draft = (): Draft => JSON.parse(ontologyText) as Draft;
const card = (ontology: Draft, id: string) => ontology.cards.find((item) => item.id === id)!;

test("the shipped behavior ontology validates and keeps its declared shape", () => {
  const ontology = loadDefaultBehaviorOntology();
  assert.deepEqual(validateArtifact("behavior ontology", JSON.parse(ontologyText)), []);
  assert.equal(ontology, loadDefaultBehaviorOntology());
  assert.ok(Object.isFrozen(ontology) && Object.isFrozen(ontology.cards[0]) && Object.isFrozen(ontology.cards[0]!.layers));
  assert.equal(ontology.schemaVersion, "ebo.behavior-ontology/v2");
  assert.equal(ontology.version, "2.0.0");
  assert.deepEqual(Object.keys(ontology), ["schemaVersion", "version", "codingRules", "families", "cards"]);
  assert.equal(ontology.codingRules.length, 4);
  assert.equal(ontology.cards.length, 93);
  assert.deepEqual(Object.fromEntries(["dimension", "finding", "workflow"].map((kind) => [kind, ontology.cards.filter((item) => item.kind === kind).length])),
    { dimension: 29, finding: 39, workflow: 25 });
  const families = behaviorCardFamilies(ontology);
  assert.deepEqual(families.map(({ id, cards }) => [id, cards.length]),
    [["OR", 6], ["EX", 3], ["EN", 7], ["TI", 10], ["ED", 12], ["PR", 11], ["VF", 13], ["EI", 8], ["CR", 9], ["VC", 7], ["DS", 7]]);
  assert.deepEqual(families.flatMap(({ cards }) => cards.map(({ id }) => id)), ontology.cards.map(({ id }) => id));
  for (const item of ontology.cards) {
    assert.equal(item.kind === "dimension", item.values !== undefined, item.id);
    if (item.values !== undefined) assert.ok(item.values.length >= 2, item.id);
    assert.equal("status" in item, false, item.id);
  }
  assert.equal(ontology.cards.filter(({ trigger }) => trigger !== undefined).length, 29);
  assert.match(behaviorOntologyDigest(ontology), /^sha256:[a-f0-9]{64}$/u);
  const reworded = draft();
  card(reworded, "OR-01").definition += " Reworded.";
  assert.notEqual(behaviorOntologyDigest(reworded), behaviorOntologyDigest(ontology));
  // An unfrozen ontology is digested on every call, so a later edit gives a new digest.
  const before = behaviorOntologyDigest(reworded);
  card(reworded, "OR-01").definition += " Again.";
  assert.notEqual(behaviorOntologyDigest(reworded), before);
  assert.equal(behaviorOntologyDigest(ontology), behaviorOntologyDigest(structuredClone(ontology)), "the remembered digest of the frozen ontology is its content digest");
});

test("ontology validation rejects broken references, shapes and fields that are not part of a card", () => {
  const rejects = (mutate: (ontology: Draft) => void, pattern: RegExp) => {
    const ontology = draft();
    mutate(ontology);
    assert.throws(() => assertBehaviorOntology(ontology), pattern);
  };
  assert.doesNotThrow(() => assertBehaviorOntology(draft()));
  rejects((ontology) => { ontology.cards.push(structuredClone(card(ontology, "OR-01"))); }, /"OR-01" is declared more than once/u);
  rejects((ontology) => { ontology.families.push({ id: "OR", name: "Again" }); }, /family "OR" is declared more than once/u);
  rejects((ontology) => { ontology.families.push({ id: "ZZ", name: "Empty" }); }, /family "ZZ" has no cards/u);
  rejects((ontology) => { card(ontology, "OR-01").family = "QQ"; }, /undeclared family "QQ"/u);
  rejects((ontology) => { card(ontology, "OR-01").family = "EX"; }, /family prefix "EX"/u);
  rejects((ontology) => { card(ontology, "VF-03").values![1]!.name = card(ontology, "VF-03").values![0]!.name; }, /"VF-03" value names must be unique/u);
  rejects((ontology) => { card(ontology, "OR-01").parent = "OR-99"; }, /undeclared card "OR-99"/u);
  rejects((ontology) => { card(ontology, "OR-01").related = ["XX-01"]; }, /undeclared card "XX-01"/u);
  rejects((ontology) => { card(ontology, "OR-01").related = ["OR-01"]; }, /"OR-01" links to itself/u);
  rejects((ontology) => { card(ontology, "EN-02").parent = "EN-03"; }, /parent cycle/u);
  rejects((ontology) => { card(ontology, "OR-01").parent = "EN-02"; card(ontology, "EN-02").parent = "ZZ-99"; }, /"EN-02" links to undeclared card "ZZ-99"/u);
  rejects((ontology) => { delete card(ontology, "VF-03").values; }, /values/u);
  rejects((ontology) => { card(ontology, "VF-03").values = [card(ontology, "VF-03").values![0]!]; }, /fewer than 2 items/u);
  rejects((ontology) => { card(ontology, "OR-01").values = structuredClone(card(ontology, "VF-03").values!); }, /must NOT be valid/u);
  rejects((ontology) => { (card(ontology, "OR-04") as unknown as { trigger: null }).trigger = null; }, /trigger/u);
  rejects((ontology) => { card(ontology, "OR-01").id = "or-1"; }, /pattern/u);
  rejects((ontology) => { (card(ontology, "OR-01") as unknown as { kind: string }).kind = "habit"; }, /allowed values/u);
  rejects((ontology) => { (card(ontology, "OR-01") as unknown as { layers: string[] }).layers = ["strategy", "strategy"]; }, /duplicate/u);
  for (const field of ["sources", "evidence", "rewrite", "status", "statusReason"]) {
    rejects((ontology) => { (card(ontology, "OR-01") as unknown as Record<string, unknown>)[field] = "active"; }, /additional properties/u);
  }
  for (const field of ["stage", "builtFrom", "categories"]) {
    rejects((ontology) => { (ontology as unknown as Record<string, unknown>)[field] = "draft"; }, /additional properties/u);
  }
  rejects((ontology) => { (ontology as unknown as { schemaVersion: string }).schemaVersion = "ebo.behavior-vocabulary/v1"; }, /Unsupported schema version/u);
});

test("a card reference and a verdict resolve through one definition", () => {
  const behavior = (cardId: string, ontologyVersion = "2.0.0") => ({ ontologyVersion, cardId });
  assert.deepEqual([...BEHAVIOR_VERDICTS], ["present", "absent", "unknown"]);
  assert.equal(resolveBehaviorCard(behavior("VF-03")).title, "Final check relative to the last edit");
  assert.throws(() => resolveBehaviorCard(behavior("ZZ-99")), /does not identify one card of behavior ontology 2\.0\.0/u);
  assert.throws(() => resolveBehaviorCard(behavior("VF-03", "1.0.0")), /does not identify one card/u);
  assert.throws(() => resolveBehaviorCard(behavior("verification-completion")), /does not identify one card/u);
  for (const verdict of BEHAVIOR_VERDICTS) assert.equal(resolveBehaviorDecision(behavior("VF-01"), { verdict }).id, "VF-01");
  assert.throws(() => resolveBehaviorDecision(behavior("VF-01"), { verdict: "present", value: "check after the last edit" }), /Only a present verdict on a dimension card/u);
  assert.equal(resolveBehaviorDecision(behavior("VF-03"), { verdict: "present", value: "no check recorded" }).kind, "dimension");
  assert.throws(() => resolveBehaviorDecision(behavior("VF-03"), { verdict: "present" }), /needs exactly one value/u);
  assert.throws(() => resolveBehaviorDecision(behavior("VF-03"), { verdict: "present", value: "sometimes" }), /is not a value of behavior card "VF-03"/u);
  for (const verdict of ["absent", "unknown"] as const) {
    assert.equal(resolveBehaviorDecision(behavior("VF-03"), { verdict }).id, "VF-03");
    assert.throws(() => resolveBehaviorDecision(behavior("VF-03"), { verdict, value: "no check recorded" }), /Only a present verdict/u);
  }
  assert.throws(() => resolveBehaviorDecision(behavior("VF-01"), { verdict: "constructive" as never }), /must be one of present, absent, unknown/u);
});

test("direction is fixed in the ontology: on workflow and finding cards and on each value of a dimension card", () => {
  const ontology = loadDefaultBehaviorOntology();
  const count = (directions: ReadonlyArray<string | undefined>) => Object.fromEntries(BEHAVIOR_DIRECTIONS.map((direction) => [direction, directions.filter((item) => item === direction).length]));
  const of = (kind: string) => ontology.cards.filter((item) => item.kind === kind);
  assert.deepEqual(count(of("workflow").map(({ direction }) => direction)), { favourable: 23, unfavourable: 1, neutral: 1 });
  assert.deepEqual(count(of("finding").map(({ direction }) => direction)), { favourable: 9, unfavourable: 17, neutral: 13 });
  const values = of("dimension").flatMap((item) => item.values!);
  assert.equal(values.length, 68);
  assert.deepEqual(count(values.map(({ direction }) => direction)), { favourable: 21, unfavourable: 21, neutral: 26 });
  for (const item of ontology.cards) assert.equal(item.kind === "dimension", item.direction === undefined, `${item.id}: a dimension card has no direction of its own`);
  // A card's kind does not give its direction: one workflow card is unfavourable, and nine finding cards are favourable.
  assert.deepEqual(of("workflow").filter(({ direction }) => direction === "unfavourable").map(({ id, title }) => [id, title]), [["TI-03", "Identical retry after a failure"]]);
  assert.equal(of("finding").filter(({ direction }) => direction === "favourable").length, 9);

  const behavior = (cardId: string) => resolveBehaviorCard({ ontologyVersion: "2.0.0", cardId });
  assert.equal(behaviorDirection(behavior("VF-01"), { verdict: "present" }), "favourable");
  assert.equal(behaviorDirection(behavior("TI-03"), { verdict: "present" }), "unfavourable");
  assert.equal(behaviorDirection(behavior("EN-04"), { verdict: "present" }), "neutral");
  assert.equal(behaviorDirection(behavior("VF-03"), { verdict: "present", value: "check after the last edit" }), "favourable");
  assert.equal(behaviorDirection(behavior("VF-03"), { verdict: "present", value: "no check recorded" }), "unfavourable");
  for (const verdict of ["absent", "unknown"] as const) assert.equal(behaviorDirection(behavior("VF-01"), { verdict }), undefined, "only a present result has a direction");

  const rejects = (mutate: (ontology: Draft) => void, pattern: RegExp) => {
    const ontology = draft();
    mutate(ontology);
    assert.throws(() => assertBehaviorOntology(ontology), pattern);
  };
  rejects((ontology) => { delete card(ontology, "VF-01").direction; }, /direction/u);
  rejects((ontology) => { card(ontology, "VF-03").direction = "favourable"; }, /must NOT be valid/u);
  rejects((ontology) => { delete (card(ontology, "VF-03").values![0] as { direction?: string }).direction; }, /direction/u);
  rejects((ontology) => { (card(ontology, "VF-01") as unknown as { direction: string }).direction = "constructive"; }, /allowed values/u);
  assert.deepEqual((JSON.parse(readFileSync(new URL("../../schemas/behavior-ontology.v2.json", import.meta.url), "utf8")) as { $defs: { direction: { enum: string[] } } }).$defs.direction.enum, [...BEHAVIOR_DIRECTIONS]);
  // No result stores a direction: consumers look it up by ontology version and digest.
  assert.doesNotMatch(readFileSync(new URL("../../schemas/behavior-assertions.v1.json", import.meta.url), "utf8"), /direction|favourable/u);
});

test("decision-model probabilities become a verdict under stated thresholds", () => {
  const behavior = (cardId: string) => resolveBehaviorCard({ ontologyVersion: "2.0.0", cardId });
  const thresholds = { present: 0.9, absent: 0.1 };
  const threeWay = (present: number) => ({ present, nearMiss: 0, absent: 1 - present });
  assert.deepEqual(decideFromProbabilities(behavior("VF-01"), threeWay(0.9), thresholds), { verdict: "present" });
  assert.deepEqual(decideFromProbabilities(behavior("VF-01"), threeWay(0.89), thresholds), { verdict: "unknown" });
  assert.deepEqual(decideFromProbabilities(behavior("VF-01"), threeWay(0.1), thresholds), { verdict: "unknown" });
  assert.deepEqual(decideFromProbabilities(behavior("VF-01"), threeWay(0.09), thresholds), { verdict: "absent" });
  assert.deepEqual(decideFromProbabilities(behavior("VF-01"), threeWay(0.6), { present: 0.5, absent: 0.5 }), { verdict: "present" }, "equal thresholds leave no abstention band");
  const values = { "check after the last edit": 0.2, "last edit after the last check": 0.4, "no check recorded": 0.4 };
  assert.deepEqual(decideFromProbabilities(behavior("VF-03"), { applies: 0.95, values }, thresholds), { verdict: "present", value: "last edit after the last check" }, "the first value in card order wins a tie");
  assert.deepEqual(decideFromProbabilities(behavior("VF-03"), { applies: 0.05, values }, thresholds), { verdict: "absent" });
  assert.deepEqual(decideFromProbabilities(behavior("VF-03"), { applies: 0.5, values }, thresholds), { verdict: "unknown" });
  assert.throws(() => decideFromProbabilities(behavior("VF-03"), threeWay(0.9), thresholds), /needs the probability that it applies/u);
  assert.throws(() => decideFromProbabilities(behavior("VF-01"), { applies: 0.9, values }, thresholds), /needs present, near-miss and absent/u);
  assert.throws(() => decideFromProbabilities(behavior("VF-03"), { applies: 0.9, values: { ...values, other: 0.1 } }, thresholds), /must cover exactly the values/u);
  assert.throws(() => decideFromProbabilities(behavior("VF-01"), { present: 0.9, nearMiss: 0.5, absent: 0.5 }, thresholds), /do not sum to 1/u);
  for (const bad of [{ present: 0.4, absent: 0.6 }, { present: 0.9, absent: 0 }, { present: 1.1, absent: 0.1 }]) {
    assert.throws(() => decideFromProbabilities(behavior("VF-01"), threeWay(0.5), bad), /thresholds need/u);
  }
});

test("every schema and model contract states the same verdicts", () => {
  const verdicts = [...BEHAVIOR_VERDICTS];
  const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8")) as { $defs: Record<string, any> };
  const assertions = schema("behavior-assertions.v1.json").$defs;
  assert.deepEqual(assertions.verdict.enum, verdicts);
  assert.deepEqual(assertions.judgment.oneOf.map(({ $ref }: { $ref: string }) => $ref.split("/").at(-1)), ["llmJudgment", "decisionModelJudgment"]);
  assert.deepEqual(assertions.llmJudgment.oneOf.map(({ $ref }: { $ref: string }) => assertions[$ref.split("/").at(-1)!].properties.verdict.const), verdicts);
  assert.equal(assertions.decisionModelJudgment.properties.verdict.$ref, "#/$defs/verdict");
  assert.deepEqual(assertions.producerMode.enum, [...BEHAVIOR_PRODUCER_MODES]);
  assert.deepEqual(schema("aggregation.v1.json").$defs.behaviorAggregate.properties.verdicts.allOf.map((rule: any) => rule.contains.properties.verdict.const), verdicts);
  const branches = (values?: string[]) => (semanticJudgeResponseSchema(4, false, values).properties as any).judgment.anyOf as Array<{ properties: Record<string, any> }>;
  assert.deepEqual(branches().map(({ properties }) => properties.verdict.const), verdicts);
  assert.deepEqual(branches().map(({ properties }) => properties.value.type), ["null", "null", "null"]);
  assert.deepEqual(branches(["a", "b"]).map(({ properties }) => properties.value.enum ?? properties.value.type), [["a", "b"], "null", "null"]);
  // Nothing in the current schemas, ontology or sources names the retired vocabulary or its valence.
  const retired = /categoryId|dimensionId|vocabularyVersion|behavior-vocabulary|behavior-categories|constructive|context-dependent/u;
  for (const name of readdirSync(new URL("../../schemas/", import.meta.url)).filter((entry) => entry.endsWith(".json"))) {
    assert.doesNotMatch(readFileSync(new URL(`../../schemas/${name}`, import.meta.url), "utf8"), retired, name);
  }
  assert.deepEqual(readdirSync(new URL("../../ontology/", import.meta.url)), ["behavior-ontology.v2.json"]);
  for (const name of readdirSync(new URL("../../src/", import.meta.url)).filter((entry) => entry.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8"), retired, name);
  }
  for (const name of readdirSync(new URL("../../viewer/src/", import.meta.url)).filter((entry) => /\.(?:ts|css)$/u.test(entry))) {
    assert.doesNotMatch(readFileSync(new URL(`../../viewer/src/${name}`, import.meta.url), "utf8"), /error-recognition-recovery|constructive|context-dependent|\.dimension\b/u, name);
  }
  assert.equal(existsSync(new URL("../../ontology/behavior-categories.v1.json", import.meta.url)), false);
});

test("the ontology and its reference page carry no local paths, credentials, study pointers or draft markers", () => {
  assert.equal(containsPortableLocalHomePath(ontologyText, "application/json"), false);
  assert.equal(containsPortableSecretPattern(ontologyText, "application/json"), false);
  assert.equal(containsPortableLocalHomePath(referenceText), false);
  assert.equal(containsPortableSecretPattern(referenceText, "text/plain"), false);
  for (const text of [ontologyText, referenceText]) {
    assert.doesNotMatch(text, /\bS\d{3,4}\b|\bt[0-9a-f]{16}\b|\b[a-z]+:\/\/|\bruns\/|\bdraft\b|\bv3\b|rewritten-untested/iu);
  }
});

test("the reference page is generated from the shipped ontology", () => {
  const ontology = loadDefaultBehaviorOntology();
  assert.equal(referenceText, renderBehaviorOntologyReference(ontology));
  for (const { id, title } of ontology.cards) assert.ok(referenceText.includes(`### ${id} `), `${id} ${title}`);
  const anchors = new Set([...referenceText.matchAll(/^### (.+)$/gmu)].map(([, heading]) => heading!.replace(/\\(.)/gu, "$1").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /gu, "-")));
  assert.equal(anchors.size, ontology.cards.length);
  for (const [, anchor] of referenceText.matchAll(/\]\(#([^)]+)\)/gu)) assert.ok(anchors.has(anchor!), anchor);
  assert.equal([...referenceText.matchAll(/^\*\*Trigger\.\*\* /gmu)].length, 29);
});
