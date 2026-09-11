import ts from "typescript";

const equality = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

export function auditRuntimeSourceBoundaries(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map();
  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      aliases.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function origins(node, seen = new Set()) {
    const text = node.getText(tree);
    const result = new Set();
    if (
      /\b(?:installationRoot|BUILDCHAIN_RUNTIME_ROOT|runtimeRoot)\b/u.test(text)
    )
      result.add("runtime");
    if (
      /\b(?:GITHUB_WORKSPACE|workspace|sourceRoot|consumerRoot)\b/u.test(text)
    )
      result.add("source");
    if (
      ts.isIdentifier(node) &&
      aliases.has(node.text) &&
      !seen.has(node.text)
    ) {
      for (const origin of origins(
        aliases.get(node.text),
        new Set([...seen, node.text]),
      ))
        result.add(origin);
    }
    ts.forEachChild(node, (child) => {
      for (const origin of origins(child, seen)) result.add(origin);
    });
    return result;
  }
  const issues = [];
  function inspect(node) {
    if (ts.isBinaryExpression(node) && equality.has(node.operatorToken.kind)) {
      const left = origins(node.left),
        right = origins(node.right);
      if (
        (left.has("runtime") && right.has("source")) ||
        (right.has("runtime") && left.has("source"))
      ) {
        const line =
          tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        issues.push(
          `${file}:${line}: business code cannot require runtime and source directory equality`,
        );
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(tree);
  return issues;
}
