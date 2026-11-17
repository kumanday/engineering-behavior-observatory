import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertBehaviorCardCatalog,
  behaviorCardCatalogDigest,
  behaviorCardFamilies,
  DEFAULT_BEHAVIOR_VOCABULARY,
  loadDefaultBehaviorCardCatalog,
  renderBehaviorCardReference,
  validateArtifact,
  type BehaviorCardCatalog,
} from "../src/index.js";
import { containsPortableLocalHomePath, containsPortableSecretPattern } from "../src/exports.js";

const catalogText = readFileSync(new URL("../../ontology/behavior-cards.v3.json", import.meta.url), "utf8");
const referenceText = readFileSync(new URL("../../docs/reference/behavior-cards.md", import.meta.url), "utf8");
type Mutable<T> = T extends ReadonlyArray<infer U> ? Array<Mutable<U>> : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Draft = Mutable<BehaviorCardCatalog>;
const draft = (): Draft => JSON.parse(catalogText) as Draft;
const card = (catalog: Draft, id: string) => catalog.cards.find((item) => item.id === id)!;

test("the shipped card catalog validates and keeps its declared shape", () => {
  const catalog = loadDefaultBehaviorCardCatalog();
  assert.deepEqual(validateArtifact("behavior card catalog", JSON.parse(catalogText)), []);
  assert.equal(catalog, loadDefaultBehaviorCardCatalog());
  assert.ok(Object.isFrozen(catalog) && Object.isFrozen(catalog.cards[0]) && Object.isFrozen(catalog.cards[0]!.layers));
  assert.equal(catalog.schemaVersion, "ebo.behavior-card-catalog/v1");
  assert.equal(catalog.version, "3.0.0-draft.1");
  assert.equal(catalog.stage, "draft");
  assert.equal(catalog.codingRules.length, 4);
  const tally = (key: "kind" | "status") => Object.fromEntries([...new Set(catalog.cards.map((item) => item[key]))].sort()
    .map((value) => [value, catalog.cards.filter((item) => item[key] === value).length]));
  assert.equal(catalog.cards.length, 93);
  assert.deepEqual(tally("kind"), { dimension: 29, finding: 39, workflow: 25 });
  assert.deepEqual(tally("status"), { active: 64, "rewritten-untested": 29 });
  const families = behaviorCardFamilies(catalog);
  assert.deepEqual(families.map(({ id, cards }) => [id, cards.length]),
    [["OR", 6], ["EX", 3], ["EN", 7], ["TI", 10], ["ED", 12], ["PR", 11], ["VF", 13], ["EI", 8], ["CR", 9], ["VC", 7], ["DS", 7]]);
  assert.deepEqual(families.flatMap(({ cards }) => cards.map(({ id }) => id)), catalog.cards.map(({ id }) => id));
  for (const item of catalog.cards) {
    assert.equal(item.kind === "dimension", item.values !== undefined, item.id);
    if (item.values !== undefined) assert.ok(item.values.length >= 2, item.id);
    if (item.status === "rewritten-untested") assert.equal(typeof item.trigger, "string", item.id);
  }
  assert.match(behaviorCardCatalogDigest(catalog), /^sha256:[a-f0-9]{64}$/u);
  const reworded = draft();
  card(reworded, "OR-01").definition += " Reworded.";
  assert.notEqual(behaviorCardCatalogDigest(reworded), behaviorCardCatalogDigest(catalog));
});

test("catalog validation rejects broken references, shapes and study-internal fields", () => {
  const rejects = (mutate: (catalog: Draft) => void, pattern: RegExp) => {
    const catalog = draft();
    mutate(catalog);
    assert.throws(() => assertBehaviorCardCatalog(catalog), pattern);
  };
  assert.doesNotThrow(() => assertBehaviorCardCatalog(draft()));
  rejects((catalog) => { catalog.cards.push(structuredClone(card(catalog, "OR-01"))); }, /"OR-01" is declared more than once/u);
  rejects((catalog) => { catalog.families.push({ id: "OR", name: "Again" }); }, /family "OR" is declared more than once/u);
  rejects((catalog) => { catalog.families.push({ id: "ZZ", name: "Empty" }); }, /family "ZZ" has no cards/u);
  rejects((catalog) => { card(catalog, "OR-01").family = "QQ"; }, /undeclared family "QQ"/u);
  rejects((catalog) => { card(catalog, "OR-01").family = "EX"; }, /family prefix "EX"/u);
  rejects((catalog) => { card(catalog, "VF-03").values![1]!.name = card(catalog, "VF-03").values![0]!.name; }, /"VF-03" value names must be unique/u);
  rejects((catalog) => { card(catalog, "OR-01").parent = "OR-99"; }, /undeclared card "OR-99"/u);
  rejects((catalog) => { card(catalog, "OR-01").related = ["XX-01"]; }, /undeclared card "XX-01"/u);
  rejects((catalog) => { card(catalog, "OR-01").related = ["OR-01"]; }, /"OR-01" links to itself/u);
  rejects((catalog) => { card(catalog, "EN-02").parent = "EN-03"; }, /parent cycle/u);
  rejects((catalog) => { card(catalog, "OR-01").parent = "EN-02"; card(catalog, "EN-02").parent = "ZZ-99"; }, /"EN-02" links to undeclared card "ZZ-99"/u);
  rejects((catalog) => { delete card(catalog, "VF-03").values; }, /values/u);
  rejects((catalog) => { card(catalog, "VF-03").values = [card(catalog, "VF-03").values![0]!]; }, /fewer than 2 items/u);
  rejects((catalog) => { card(catalog, "OR-01").values = structuredClone(card(catalog, "VF-03").values!); }, /must NOT be valid/u);
  rejects((catalog) => { card(catalog, "OR-04").trigger = null; }, /trigger/u);
  rejects((catalog) => { card(catalog, "OR-01").id = "or-1"; }, /pattern/u);
  rejects((catalog) => { (card(catalog, "OR-01") as unknown as { kind: string }).kind = "habit"; }, /allowed values/u);
  rejects((catalog) => { (card(catalog, "OR-01") as unknown as { status: string }).status = "retired"; }, /allowed values/u);
  rejects((catalog) => { (card(catalog, "OR-01") as unknown as { layers: string[] }).layers = ["strategy", "strategy"]; }, /duplicate/u);
  for (const field of ["sources", "evidence", "rewrite", "statusReason"]) {
    rejects((catalog) => { (card(catalog, "OR-01") as unknown as Record<string, unknown>)[field] = {}; }, /additional properties/u);
  }
  rejects((catalog) => { (catalog as unknown as Record<string, unknown>).builtFrom = "elsewhere"; }, /additional properties/u);
});

test("the catalog and its reference page carry no local paths, credentials or study case pointers", () => {
  assert.equal(containsPortableLocalHomePath(catalogText, "application/json"), false);
  assert.equal(containsPortableSecretPattern(catalogText, "application/json"), false);
  assert.equal(containsPortableLocalHomePath(referenceText), false);
  assert.equal(containsPortableSecretPattern(referenceText, "text/plain"), false);
  for (const text of [catalogText, referenceText]) {
    assert.doesNotMatch(text, /\bS\d{3,4}\b|\bt[0-9a-f]{16}\b|\b[a-z]+:\/\/|\bruns\//u);
  }
});

test("the reference page is generated from the shipped catalog", () => {
  const catalog = loadDefaultBehaviorCardCatalog();
  assert.equal(referenceText, renderBehaviorCardReference(catalog));
  for (const { id, title } of catalog.cards) assert.ok(referenceText.includes(`### ${id} `), `${id} ${title}`);
  const anchors = new Set([...referenceText.matchAll(/^### (.+)$/gmu)].map(([, heading]) => heading!.replace(/\\(.)/gu, "$1").toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /gu, "-")));
  assert.equal(anchors.size, catalog.cards.length);
  for (const [, anchor] of referenceText.matchAll(/\]\(#([^)]+)\)/gu)) assert.ok(anchors.has(anchor!), anchor);
  const reviewed = renderBehaviorCardReference({ ...catalog, stage: "reviewed" });
  assert.match(referenceText, /The card texts are a draft\./u);
  assert.doesNotMatch(reviewed, /The card texts are a draft\./u);
});

test("the v1 behavior vocabulary stays the vocabulary of assertions and judge requests", () => {
  assert.equal(DEFAULT_BEHAVIOR_VOCABULARY.schemaVersion, "ebo.behavior-vocabulary/v1");
  assert.equal(DEFAULT_BEHAVIOR_VOCABULARY.version, "1.0.0");
  assert.equal(DEFAULT_BEHAVIOR_VOCABULARY.categories.length, 8);
  const cardIds = new Set(loadDefaultBehaviorCardCatalog().cards.map(({ id }) => id));
  for (const { id, dimensions } of DEFAULT_BEHAVIOR_VOCABULARY.categories) {
    assert.equal(cardIds.has(id), false);
    for (const dimension of dimensions) assert.equal(cardIds.has(dimension.id), false);
  }
});
