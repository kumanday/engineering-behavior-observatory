export function maskSourceIdentifierAssignments(source, path, ts) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const ranges = [];
  const visit = (node) => {
    const value = ts.isPropertyAssignment(node) ? node.initializer
      : ts.isVariableDeclaration(node) ? node.initializer
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right
          : undefined;
    if (value !== undefined && isSourceReference(value, ts)) ranges.push([value.getStart(file), value.end]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const [start, end] of ranges.sort(([left], [right]) => right - left)) {
    source = `${source.slice(0, start)}[REDACTED_SECRET]${source.slice(end)}`;
  }
  return source;
}

function isSourceReference(node, ts) {
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return isSourceReference(node.expression, ts);
  if (ts.isElementAccessExpression(node)) return isSourceReference(node.expression, ts)
    && (isSourceReference(node.argumentExpression, ts) || ts.isStringLiteral(node.argumentExpression)
      && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(node.argumentExpression.text));
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isSourceReference(node.expression, ts);
  // A Bearer template containing only a source reference has no credential literal.
  // Keep mixed literals and literal interpolations visible to the shared scanner.
  if (ts.isTemplateExpression(node) && node.head.text === "Bearer " && node.templateSpans.length === 1) {
    const span = node.templateSpans[0];
    return span.literal.text === "" && isSourceReference(span.expression, ts);
  }
  return false;
}

/** A root segment in an explicit session/document namespace is an identifier, not a filesystem home. */
export function maskSourceLogicalRoots(source, path, ts) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const ranges = [];
  const namespace = (node) => ts.isConditionalExpression(node)
    ? namespace(node.whenTrue) && namespace(node.whenFalse)
    : ts.isTemplateExpression(node) && ["session:", "document:"].includes(node.head.text)
      && node.templateSpans.length === 1 && node.templateSpans[0].literal.text === "";
  const visit = (node) => {
    if (ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length === 2
        && node.templateSpans.every((span) => span.literal.text === "") && namespace(node.templateSpans[0].expression)) {
      const suffix = node.templateSpans[1].expression;
      if (ts.isConditionalExpression(suffix) && ts.isTemplateExpression(suffix.whenTrue)
          && suffix.whenTrue.head.text === "/parent-tool:" && suffix.whenTrue.templateSpans.length === 1
          && suffix.whenTrue.templateSpans[0].literal.text === ""
          && ts.isStringLiteral(suffix.whenFalse) && suffix.whenFalse.text === "/root") {
        ranges.push([suffix.whenFalse.getStart(file), suffix.whenFalse.end]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const [start, end] of ranges.sort(([left], [right]) => right - left)) {
    source = `${source.slice(0, start)}"[LOGICAL_ROOT_SEGMENT]"${source.slice(end)}`;
  }
  return source;
}
