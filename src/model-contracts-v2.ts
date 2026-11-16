import { readFileSync } from "node:fs";
const definitions = (JSON.parse(readFileSync(new URL("../../schemas/consumers.v2.json", import.meta.url), "utf8")) as {
  $defs: Record<string, { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, unknown> }>;
}).$defs;
/** Model response bodies omit the artifact wrapper; EBO supplies its version and source bindings. */
function answerSchema(name: string): Record<string, unknown> {
  const schema = structuredClone(definitions[name]!);
  delete schema.properties.schemaVersion; schema.required = schema.required.filter((key) => key !== "schemaVersion");
  return schema;
}
export const ratingAnswerSchemaV2 = (): Record<string, unknown> => answerSchema("ratingAnswer");
export const semanticJudgeAnswerSchemaV2 = (): Record<string, unknown> => answerSchema("judgeAnswer");
