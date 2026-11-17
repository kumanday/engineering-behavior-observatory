import { readFileSync } from "node:fs";

import { digestMetadata, validateArtifact } from "./artifacts.js";

export type BehaviorCardKind = "workflow" | "dimension" | "finding";
export type BehaviorCardStatus = "active" | "rewritten-untested";
export type BehaviorCardLayer = "architecture" | "evidence" | "interface" | "strategy" | "verification";
export type BehaviorCardUnit = "call-result" | "change" | "episode" | "trajectory";
export type BehaviorCardClassification = "rule" | "classifier" | "judgment";

/** One named outcome of a dimension card, with the test that selects it. Names are unique within their card. */
export type BehaviorCardValue = { readonly name: string; readonly test: string };

export type BehaviorCard = {
  readonly id: string;
  readonly title: string;
  /** A workflow is a common practice, a dimension has named values, a finding is a specific situation. */
  readonly kind: BehaviorCardKind;
  readonly family: string;
  readonly layers: readonly BehaviorCardLayer[];
  /** The span one judgment of the card covers. */
  readonly unit: BehaviorCardUnit;
  readonly status: BehaviorCardStatus;
  readonly definition: string;
  /** The observable event that must occur before the card applies; null when the card records none. */
  readonly trigger: string | null;
  readonly evidenceTest: string;
  readonly nearMiss: string;
  /** What the card changes about how a record should be read. */
  readonly significance?: string;
  /** Present on dimension cards only. */
  readonly values?: readonly BehaviorCardValue[];
  /** An untested proposal for how the card could be decided: typed event order, a trained scorer, or a judge. */
  readonly proposedClassification: BehaviorCardClassification;
  readonly parent: string | null;
  readonly related: readonly string[];
};

export type BehaviorCardFamily = { readonly id: string; readonly name: string };

export type BehaviorCardCatalog = {
  readonly schemaVersion: "ebo.behavior-card-catalog/v1";
  readonly version: string;
  /** A draft catalog's card texts are pending review and may change without a compatibility path. */
  readonly stage: "draft" | "reviewed";
  /** Rules a reader applies to every card, in order. */
  readonly codingRules: readonly string[];
  readonly families: readonly BehaviorCardFamily[];
  readonly cards: readonly BehaviorCard[];
};

let defaultCatalog: BehaviorCardCatalog | undefined;

/** The card catalog shipped with this package, validated once and frozen. */
export function loadDefaultBehaviorCardCatalog(): BehaviorCardCatalog {
  if (defaultCatalog === undefined) {
    const catalog: unknown = JSON.parse(readFileSync(new URL("../../ontology/behavior-cards.v3.json", import.meta.url), "utf8"));
    assertBehaviorCardCatalog(catalog);
    defaultCatalog = deepFreeze(catalog);
  }
  return defaultCatalog;
}

/** Schema validity plus the references a schema cannot state: declared families, resolvable links and unique names. */
export function assertBehaviorCardCatalog(catalog: unknown): asserts catalog is BehaviorCardCatalog {
  const errors = validateArtifact("behavior card catalog", catalog);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `behavior card catalog ${field}: ${message}`).join("\n"));
  const { families, cards } = catalog as BehaviorCardCatalog;
  const familyIds = new Set<string>();
  for (const { id } of families) {
    if (familyIds.has(id)) throw new Error(`Behavior card family "${id}" is declared more than once.`);
    familyIds.add(id);
  }
  const byId = new Map<string, BehaviorCard>();
  for (const card of cards) {
    if (byId.has(card.id)) throw new Error(`Behavior card "${card.id}" is declared more than once.`);
    byId.set(card.id, card);
    if (!familyIds.has(card.family)) throw new Error(`Behavior card "${card.id}" names undeclared family "${card.family}".`);
    if (!card.id.startsWith(`${card.family}-`)) throw new Error(`Behavior card "${card.id}" does not carry its family prefix "${card.family}".`);
    const names = (card.values ?? []).map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new Error(`Behavior card "${card.id}" value names must be unique.`);
  }
  for (const { id } of families) {
    if (!cards.some(({ family }) => family === id)) throw new Error(`Behavior card family "${id}" has no cards.`);
  }
  for (const card of cards) {
    for (const linked of [...(card.parent === null ? [] : [card.parent]), ...card.related]) {
      if (linked === card.id) throw new Error(`Behavior card "${card.id}" links to itself.`);
      if (!byId.has(linked)) throw new Error(`Behavior card "${card.id}" links to undeclared card "${linked}".`);
    }
  }
  for (const card of cards) {
    const seen = new Set([card.id]);
    for (let parent = card.parent; parent !== null; parent = byId.get(parent)!.parent) {
      if (seen.has(parent)) throw new Error(`Behavior card "${card.id}" has a parent cycle.`);
      seen.add(parent);
    }
  }
}

/** Canonical digest of a catalog: the identity a record binds when it refers to cards by id. */
export function behaviorCardCatalogDigest(catalog: BehaviorCardCatalog): `sha256:${string}` {
  return `sha256:${digestMetadata(catalog).value}`;
}

/** Families in catalog order, each with its cards in catalog order. */
export function behaviorCardFamilies(catalog: BehaviorCardCatalog): Array<BehaviorCardFamily & { cards: BehaviorCard[] }> {
  return catalog.families.map((family) => ({ ...family, cards: catalog.cards.filter((card) => card.family === family.id) }));
}

/** The reference page for a catalog. `docs/reference/behavior-cards.md` is this text for the shipped catalog. */
export function renderBehaviorCardReference(catalog: BehaviorCardCatalog): string {
  const count = (predicate: (card: BehaviorCard) => boolean) => catalog.cards.filter(predicate).length;
  const heading = (card: BehaviorCard) => `${card.id} ${card.title}`;
  const link = (id: string) => `[${id}](#${headingAnchor(heading(catalog.cards.find((card) => card.id === id)!))})`;
  const lines = [
    "# Behavior card reference",
    "",
    `Every card in [\`ontology/behavior-cards.v3.json\`](../../ontology/behavior-cards.v3.json), catalog version \`${catalog.version}\`. This page is generated from that file. [Behavior cards](../evaluation/behavior-cards.md) explains the kinds, statuses and fields.`,
    "",
    ...(catalog.stage === "draft" ? ["The card texts are a draft. The merges that produced them are pending review, and titles, tests and values may change.", ""] : []),
    `${catalog.cards.length} cards in ${catalog.families.length} families: ${count(({ status }) => status === "active")} active, ${count(({ status }) => status === "rewritten-untested")} rewritten and untested. By kind: ${count(({ kind }) => kind === "workflow")} workflow, ${count(({ kind }) => kind === "dimension")} dimension, ${count(({ kind }) => kind === "finding")} finding.`,
    "",
    "## Coding rules",
    "",
    ...catalog.codingRules.map((rule, index) => `${index + 1}. ${inline(rule)}`),
    "",
  ];
  for (const family of behaviorCardFamilies(catalog)) {
    lines.push(`## ${family.id}: ${inline(family.name)}`, "",
      "| Card | Kind | Status | Unit | Layers | Proposed classification |", "| :--- | :--- | :--- | :--- | :--- | :--- |",
      ...family.cards.map((card) => `| ${link(card.id)} ${inline(card.title)} | ${card.kind} | ${card.status} | ${card.unit} | ${card.layers.join(", ")} | ${card.proposedClassification} |`), "");
    for (const card of family.cards) {
      lines.push(`### ${inline(heading(card))}`, "",
        `${card.kind} · ${card.status} · unit: ${card.unit} · layers: ${card.layers.join(", ")} · proposed classification: ${card.proposedClassification}`, "",
        `**Definition.** ${inline(card.definition)}`, "",
        card.trigger === null ? "**Trigger.** None recorded." : `**Trigger.** ${inline(card.trigger)}`, "",
        `**Evidence test.** ${inline(card.evidenceTest)}`, "",
        `**Near miss.** ${inline(card.nearMiss)}`, "");
      if (card.significance !== undefined) lines.push(`**Why it matters.** ${inline(card.significance)}`, "");
      if (card.values !== undefined) lines.push("**Values.**", "", ...card.values.map(({ name, test }) => `- **${inline(name)}**: ${inline(test)}`), "");
      const links = [
        ...(card.parent === null ? [] : [`Parent: ${link(card.parent)}.`]),
        ...(card.related.length === 0 ? [] : [`Related: ${card.related.map(link).join(", ")}.`]),
      ];
      if (links.length > 0) lines.push(links.join(" "), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Card text as inline Markdown: escape syntax characters and keep authored line breaks. */
function inline(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/gu, "\\$&").replace(/\n/gu, "\\\n");
}

/** GitHub-style heading anchor, which the project site also generates. */
function headingAnchor(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "").replace(/ /gu, "-");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
