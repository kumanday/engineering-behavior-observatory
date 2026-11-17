import { readFileSync } from "node:fs";

import { digestMetadata, validateArtifact } from "./artifacts.js";

export type BehaviorCardKind = "workflow" | "dimension" | "finding";
export type BehaviorCardLayer = "architecture" | "evidence" | "interface" | "strategy" | "verification";
export type BehaviorCardUnit = "call-result" | "change" | "episode" | "trajectory";
export type BehaviorCardClassification = "rule" | "classifier" | "judgment";

/**
 * What a present card, or a value of a dimension card, means in a comparison. It is fixed in the ontology: no judge
 * decides it and no card result stores it. A card's kind does not give its direction.
 */
export const BEHAVIOR_DIRECTIONS = ["favourable", "unfavourable", "neutral"] as const;
export type BehaviorDirection = (typeof BEHAVIOR_DIRECTIONS)[number];

/** One named outcome of a dimension card, with the test that selects it. Names are unique within their card. */
export type BehaviorCardValue = { readonly name: string; readonly test: string; readonly direction: BehaviorDirection };

export type BehaviorCard = {
  readonly id: string;
  readonly title: string;
  /** A workflow is a common practice, a dimension has named values, a finding is a specific situation. */
  readonly kind: BehaviorCardKind;
  /** Workflow and finding cards only: what the card means when present. A dimension card states it per value. */
  readonly direction?: BehaviorDirection;
  readonly family: string;
  readonly layers: readonly BehaviorCardLayer[];
  /** The span one judgment of the card covers. */
  readonly unit: BehaviorCardUnit;
  readonly definition: string;
  /** The observable event that must occur before the card applies, on the cards that state one. */
  readonly trigger?: string;
  readonly evidenceTest: string;
  readonly nearMiss: string;
  /** What the card changes about how a record should be read. */
  readonly significance?: string;
  /** Present on dimension cards only. */
  readonly values?: readonly BehaviorCardValue[];
  /** A proposal for how the card could be decided: typed event order, a trained scorer, or a judge. */
  readonly proposedClassification: BehaviorCardClassification;
  readonly parent: string | null;
  readonly related: readonly string[];
};

export type BehaviorCardFamily = { readonly id: string; readonly name: string };

export type BehaviorOntology = {
  readonly schemaVersion: "ebo.behavior-ontology/v2";
  readonly version: string;
  /** Rules a reader applies to every card, in order. */
  readonly codingRules: readonly string[];
  readonly families: readonly BehaviorCardFamily[];
  readonly cards: readonly BehaviorCard[];
};

/** How a record names the behavior it judges: one card of one ontology version. */
export type BehaviorReference = { ontologyVersion: string; cardId: string };

/**
 * The verdict on a card. `present` and `absent` are decisions; `unknown` is the abstention, for a record that lacks
 * the steps the card's test needs. This list, `BehaviorDecision` and `resolveBehaviorDecision` are the single
 * definition every record and consumer shares.
 */
export const BEHAVIOR_VERDICTS = ["present", "absent", "unknown"] as const;
export type BehaviorVerdict = (typeof BEHAVIOR_VERDICTS)[number];

/** A verdict plus, when a dimension card is present, exactly one of the card's value names. */
export type BehaviorDecision = { verdict: BehaviorVerdict; value?: string };

let defaultOntology: BehaviorOntology | undefined;

/** The behavior ontology shipped with this package, validated once and frozen. */
export function loadDefaultBehaviorOntology(): BehaviorOntology {
  if (defaultOntology === undefined) {
    const ontology: unknown = JSON.parse(readFileSync(new URL("../../ontology/behavior-ontology.v2.json", import.meta.url), "utf8"));
    assertBehaviorOntology(ontology);
    defaultOntology = deepFreeze(ontology);
  }
  return defaultOntology;
}

/** Schema validity plus the references a schema cannot state: declared families, resolvable links and unique names. */
export function assertBehaviorOntology(ontology: unknown): asserts ontology is BehaviorOntology {
  const errors = validateArtifact("behavior ontology", ontology);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `behavior ontology ${field}: ${message}`).join("\n"));
  const { families, cards } = ontology as BehaviorOntology;
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

/** The card a record names. A reference to another ontology version or to an undeclared card fails. */
export function resolveBehaviorCard(behavior: BehaviorReference, ontology: BehaviorOntology = loadDefaultBehaviorOntology()): BehaviorCard {
  const card = behavior.ontologyVersion === ontology.version ? ontology.cards.find(({ id }) => id === behavior.cardId) : undefined;
  if (card === undefined) throw new Error(`Behavior reference does not identify one card of behavior ontology ${ontology.version}.`);
  return card;
}

/** The card a decision is about, after checking that a value is given exactly when a dimension card is present. */
export function resolveBehaviorDecision(behavior: BehaviorReference, decision: BehaviorDecision, ontology: BehaviorOntology = loadDefaultBehaviorOntology()): BehaviorCard {
  const card = resolveBehaviorCard(behavior, ontology);
  if (!BEHAVIOR_VERDICTS.includes(decision.verdict)) throw new Error(`Behavior verdict must be one of ${BEHAVIOR_VERDICTS.join(", ")}.`);
  const needsValue = card.kind === "dimension" && decision.verdict === "present";
  if (needsValue !== (decision.value !== undefined)) {
    throw new Error(needsValue ? `A present verdict on dimension card "${card.id}" needs exactly one value.` : `Only a present verdict on a dimension card carries a value; "${card.id}" got one.`);
  }
  if (needsValue && !card.values!.some(({ name }) => name === decision.value)) throw new Error(`"${decision.value}" is not a value of behavior card "${card.id}".`);
  return card;
}

/** What a decision model returns for one card: a three-way status for workflow and finding cards, and for a dimension card the probability that it applies plus one probability per value. */
export type DecisionModelProbabilities =
  | { present: number; nearMiss: number; absent: number }
  | { applies: number; values: Readonly<Record<string, number>> };

/** A probability at or above `present` is a present verdict, one below `absent` is absent, and anything between is unknown. */
export type DecisionThresholds = { present: number; absent: number };

/** The verdict and value a decision model's probabilities give under the thresholds a record states. */
export function decideFromProbabilities(card: BehaviorCard, probabilities: DecisionModelProbabilities, thresholds: DecisionThresholds): BehaviorDecision {
  if (!(thresholds.absent > 0 && thresholds.absent <= thresholds.present && thresholds.present <= 1)) throw new Error("Decision thresholds need 0 < absent <= present <= 1.");
  const dimension = card.kind === "dimension";
  if (dimension !== ("applies" in probabilities)) {
    throw new Error(dimension ? `Dimension card "${card.id}" needs the probability that it applies and one probability per value.` : `Card "${card.id}" needs present, near-miss and absent probabilities.`);
  }
  if ("applies" in probabilities) {
    const names = Object.keys(probabilities.values);
    if (names.length !== card.values!.length || names.some((name) => !card.values!.some((value) => value.name === name))) throw new Error(`Value probabilities must cover exactly the values of behavior card "${card.id}".`);
  } else if (Math.abs(probabilities.present + probabilities.nearMiss + probabilities.absent - 1) > 0.03) {
    throw new Error(`Present, near-miss and absent probabilities of card "${card.id}" do not sum to 1.`);
  }
  const decisive = "applies" in probabilities ? probabilities.applies : probabilities.present;
  const verdict: BehaviorVerdict = decisive >= thresholds.present ? "present" : decisive < thresholds.absent ? "absent" : "unknown";
  if (verdict !== "present" || !("applies" in probabilities)) return { verdict };
  // The first value in card order wins a tie, so the choice does not depend on how a producer ordered its answer.
  const value = card.values!.reduce((best, candidate) => probabilities.values[candidate.name]! > probabilities.values[best.name]! ? candidate : best).name;
  return { verdict, value };
}

/** The direction of a decision: set only for a present verdict, from the card or from the named value. */
export function behaviorDirection(card: BehaviorCard, decision: BehaviorDecision): BehaviorDirection | undefined {
  if (decision.verdict !== "present") return undefined;
  return card.kind === "dimension" ? card.values?.find(({ name }) => name === decision.value)?.direction : card.direction;
}

/** Canonical digest of an ontology: the identity of the exact card texts a result was produced against. */
export function behaviorOntologyDigest(ontology: BehaviorOntology): `sha256:${string}` {
  return `sha256:${digestMetadata(ontology).value}`;
}

/** Families in ontology order, each with its cards in ontology order. */
export function behaviorCardFamilies(ontology: BehaviorOntology): Array<BehaviorCardFamily & { cards: BehaviorCard[] }> {
  return ontology.families.map((family) => ({ ...family, cards: ontology.cards.filter((card) => card.family === family.id) }));
}

/** The reference page for an ontology. `docs/reference/behavior-ontology.md` is this text for the shipped ontology. */
export function renderBehaviorOntologyReference(ontology: BehaviorOntology): string {
  const count = (kind: BehaviorCardKind) => ontology.cards.filter((card) => card.kind === kind).length;
  const heading = (card: BehaviorCard) => `${card.id} ${card.title}`;
  const link = (id: string) => `[${id}](#${headingAnchor(heading(ontology.cards.find((card) => card.id === id)!))})`;
  const lines = [
    "# Behavior ontology reference",
    "",
    `Every card of EBO behavior ontology ${ontology.version}, generated from [\`ontology/behavior-ontology.v2.json\`](../../ontology/behavior-ontology.v2.json). [Behavior ontology](../evaluation/behavior-ontology.md) explains the card kinds, the fields and the verdicts.`,
    "",
    `${ontology.cards.length} cards in ${ontology.families.length} families: ${count("workflow")} workflow, ${count("dimension")} dimension, ${count("finding")} finding.`,
    "",
    "Each workflow and finding card has a direction, read when the card is present: favourable, unfavourable or neutral. A dimension card has one per value.",
    "",
    "## Coding rules",
    "",
    ...ontology.codingRules.map((rule, index) => `${index + 1}. ${inline(rule)}`),
    "",
  ];
  for (const family of behaviorCardFamilies(ontology)) {
    lines.push(`## ${family.id}: ${inline(family.name)}`, "",
      "| Card | Kind | Direction when present | Unit | Layers | Proposed classification |", "| :--- | :--- | :--- | :--- | :--- | :--- |",
      ...family.cards.map((card) => `| ${link(card.id)} ${inline(card.title)} | ${card.kind} | ${card.direction ?? "by value"} | ${card.unit} | ${card.layers.join(", ")} | ${card.proposedClassification} |`), "");
    for (const card of family.cards) {
      lines.push(`### ${inline(heading(card))}`, "",
        `${card.kind} · ${card.direction === undefined ? "direction by value" : `${card.direction} when present`} · unit: ${card.unit} · layers: ${card.layers.join(", ")} · proposed classification: ${card.proposedClassification}`, "",
        `**Definition.** ${inline(card.definition)}`, "");
      if (card.trigger !== undefined) lines.push(`**Trigger.** ${inline(card.trigger)}`, "");
      lines.push(`**Evidence test.** ${inline(card.evidenceTest)}`, "", `**Near miss.** ${inline(card.nearMiss)}`, "");
      if (card.significance !== undefined) lines.push(`**Why it matters.** ${inline(card.significance)}`, "");
      if (card.values !== undefined) lines.push("**Values.**", "", ...card.values.map(({ name, test, direction }) => `- **${inline(name)}** (${direction}): ${inline(test)}`), "");
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
