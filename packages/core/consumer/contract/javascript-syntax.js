import { UNKNOWN, TAG, tagged, namespace } from "./javascript-values.js";

function expressionLiteral(ctx, node, scope) {
  return node.value;
}
function expressionIdentifier(ctx, node, scope) {
  const { get } = ctx;
  return get(scope, node.name);
}
function expressionFunctionExpression(ctx, node, scope) {
  return tagged("function", { node, scope });
}
function expressionArrayExpression(ctx, node, scope) {
  const { expression } = ctx;
  return node.elements.map((item) => expression(item, scope));
}
function expressionObjectExpression(ctx, node, scope) {
  const { expression, report, get } = ctx;
  {
    const value = Object.create(null);
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        expression(property.argument, scope);
        report(
          property,
          "unsupported-spread",
          "Object spread requires resolved property execution",
        );
        continue;
      }
      if (property.kind === "get" || property.kind === "set")
        report(
          property,
          "unsupported-accessor",
          "Accessor execution must be resolved explicitly",
        );
      const key = property.computed
        ? expression(property.key, scope)
        : (property.key.name ?? property.key.value);
      if (typeof key !== "string" && typeof key !== "number") {
        report(
          property,
          "unresolved-property",
          "Computed property must resolve",
        );
        expression(property.value, scope);
        continue;
      }
      value[key] = expression(property.value, scope);
    }
    return value;
  }
}
function expressionMemberExpression(ctx, node, scope) {
  const { member, expression, report } = ctx;
  {
    const object = expression(node.object, scope),
      key = node.computed
        ? expression(node.property, scope)
        : node.property.name;
    if (["constructor", "prototype", "__proto__"].includes(key))
      report(
        node,
        "dynamic-prototype",
        "Prototype execution is outside the static invocation subset",
      );
    return member(object, key);
  }
}
function expressionCallExpression(ctx, node, scope) {
  const { invoke, expression } = ctx;
  const result = invoke(
    node,
    expression(node.callee, scope),
    node.arguments.map((argument) => expression(argument, scope)),
  );
  if (node.type === "NewExpression") {
    ctx.report(
      node,
      "unsupported-construction",
      "Constructor result and prototype behavior must be resolved explicitly",
    );
    return UNKNOWN;
  }
  return result;
}
function expressionImportExpression(ctx, node, scope) {
  const { imported, expression } = ctx;
  return imported(node, expression(node.source, scope));
}
function expressionAwaitExpression(ctx, node, scope) {
  const { invoke, expression, report } = ctx;
  {
    const value = expression(node.argument, scope);
    if (value && typeof value === "object" && !value[TAG])
      report(
        node,
        "unresolved-await",
        "Await may invoke a user-defined thenable",
      );
    return value;
  }
}
function expressionChainExpression(ctx, node, scope) {
  const { expression } = ctx;
  return expression(node.argument || node.expression, scope);
}
function expressionBinaryExpression(ctx, node, scope) {
  const { expression, data, checkCoercion } = ctx;
  {
    const left = expression(node.left, scope),
      right = expression(node.right, scope);
    if (
      node.operator === "+" &&
      [left, right].every((value) =>
        ["string", "number"].includes(typeof value),
      )
    )
      return left + right;
    if (
      left !== UNKNOWN &&
      right !== UNKNOWN &&
      !left?.[TAG] &&
      !right?.[TAG] &&
      ["===", "!=="].includes(node.operator)
    )
      return node.operator === "===" ? left === right : left !== right;
    if (!["===", "!=="].includes(node.operator))
      checkCoercion(node, [left, right]);
    return data();
  }
}
function expressionTemplateLiteral(ctx, node, scope) {
  const { expression, data, checkCoercion } = ctx;
  {
    const values = node.expressions.map((value) => expression(value, scope));
    checkCoercion(node, values);
    return values.every((value) => ["string", "number"].includes(typeof value))
      ? node.quasis
          .map(
            (part, index) =>
              part.value.cooked + (index < values.length ? values[index] : ""),
          )
          .join("")
      : data();
  }
}
function expressionConditionalExpression(ctx, node, scope) {
  const { expression, report } = ctx;
  {
    const value = expression(node.test || node.left, scope);
    if (value === UNKNOWN || value?.[TAG]) {
      report(
        node,
        "unresolved-condition",
        "Conditional expression requires a resolved condition",
      );
      expression(node.consequent || node.right, scope);
      if (node.alternate) expression(node.alternate, scope);
      return UNKNOWN;
    }
    if (node.test)
      return expression(value ? node.consequent : node.alternate, scope);
    const useRight =
      node.operator === "&&"
        ? Boolean(value)
        : node.operator === "||"
          ? !value
          : value == null;
    return useRight ? expression(node.right, scope) : value;
  }
}
function expressionAssignmentExpression(ctx, node, scope) {
  const { expression, data, report, get, checkCoercion } = ctx;
  {
    const value = expression(node.right, scope);
    if (node.left.type !== "Identifier" || !scope.has(node.left.name)) {
      report(
        node,
        "unsupported-assignment",
        "Assignment requires a resolved lexical binding",
      );
      return UNKNOWN;
    }
    const previous = get(scope, node.left.name);
    let assigned = value;
    if (node.operator === "+=") {
      checkCoercion(node, [previous, value]);
      assigned = [previous, value].every((item) =>
        ["string", "number"].includes(typeof item),
      )
        ? previous + value
        : data();
    } else if (node.operator !== "=") {
      report(
        node,
        "unsupported-assignment",
        `Unsupported assignment operator: ${node.operator}`,
      );
      assigned = UNKNOWN;
    }
    scope.get(node.left.name).value = assigned;
    return assigned;
  }
}
function expressionSequenceExpression(ctx, node, scope) {
  const { expression } = ctx;
  return node.expressions.map((value) => expression(value, scope)).at(-1);
}
function expressionUnaryExpression(ctx, node, scope) {
  const { expression, report, checkCoercion } = ctx;
  checkCoercion(node, [expression(node.argument, scope)]);
  report(
    node,
    "unsupported-operator",
    `Unsupported unary operator: ${node.operator}`,
  );
  return UNKNOWN;
}
function expressionUnknown(ctx, node, scope) {
  const { expression, report } = ctx;
  report(
    node,
    "unsupported-expression",
    `Unsupported executable syntax: ${node.type}`,
  );
  return UNKNOWN;
}
const expressionHandlers = {
  Literal: expressionLiteral,
  Identifier: expressionIdentifier,
  FunctionExpression: expressionFunctionExpression,
  ArrowFunctionExpression: expressionFunctionExpression,
  ArrayExpression: expressionArrayExpression,
  ObjectExpression: expressionObjectExpression,
  MemberExpression: expressionMemberExpression,
  CallExpression: expressionCallExpression,
  NewExpression: expressionCallExpression,
  ImportExpression: expressionImportExpression,
  AwaitExpression: expressionAwaitExpression,
  ChainExpression: expressionChainExpression,
  BinaryExpression: expressionBinaryExpression,
  TemplateLiteral: expressionTemplateLiteral,
  ConditionalExpression: expressionConditionalExpression,
  LogicalExpression: expressionConditionalExpression,
  AssignmentExpression: expressionAssignmentExpression,
  SequenceExpression: expressionSequenceExpression,
  UnaryExpression: expressionUnaryExpression,
  UpdateExpression: expressionUnaryExpression,
};
export function evaluateExpression(ctx, node, scope) {
  if (!node) return undefined;
  ctx.visit();
  return (expressionHandlers[node.type] || expressionUnknown)(ctx, node, scope);
}

function statementsFunctionDeclaration(ctx, node, scope) {}
function statementsImportDeclaration(ctx, node, scope) {
  const { member, imported, declare } = ctx;
  {
    imported(node, node.source.value);
    for (const item of node.specifiers)
      declare(
        scope,
        item.local.name,
        item.type === "ImportSpecifier"
          ? member(
              namespace(node.source.value),
              item.imported.name ?? item.imported.value,
            )
          : item.type === "ImportDefaultSpecifier" &&
              node.source.value.startsWith(".")
            ? member(namespace(node.source.value), "default")
            : namespace(node.source.value),
      );
    return;
  }
}
function statementsVariableDeclaration(ctx, node, scope) {
  const { bind, expression } = ctx;
  for (const item of node.declarations)
    bind(item.id, expression(item.init, scope), scope);
}
function statementsExpressionStatement(ctx, node, scope) {
  const { expression } = ctx;
  expression(node.expression, scope);
}
function statementsReturnStatement(ctx, node, scope) {
  const { expression } = ctx;
  return { returned: true, value: expression(node.argument, scope) };
}
function statementsThrowStatement(ctx, node, scope) {
  const { expression } = ctx;
  expression(node.argument, scope);
}
function statementsBlockStatement(ctx, node, scope) {
  const { statements } = ctx;
  {
    const result = statements(node.body, new Map(scope));
    if (result.returned) return result;
    return;
  }
}
function statementsIfStatement(ctx, node, scope) {
  const { expression, statements, report } = ctx;
  {
    const value = expression(node.test, scope);
    if (value === UNKNOWN || value?.[TAG])
      report(
        node,
        "unresolved-condition",
        "Conditional execution requires a resolved condition",
      );
    const branches =
      value === UNKNOWN || value?.[TAG]
        ? [node.consequent, node.alternate]
        : [value ? node.consequent : node.alternate];
    const results = branches
      .filter(Boolean)
      .map((branch) => statements([branch], new Map(scope)));
    if (
      results.length &&
      results.every((result) => result.returned) &&
      results.every((result) => result.value === results[0].value)
    )
      return results[0];
    return;
  }
}
function statementsForStatement(ctx, node, scope) {
  const { bind, expression, statements, report } = ctx;
  {
    const loop = new Map(scope);
    if (node.type === "ForOfStatement") {
      const values = expression(node.right, scope);
      if (!Array.isArray(values) || values.length > 1000)
        report(
          node,
          "unresolved-iteration",
          "Iteration requires a bounded resolved array",
        );
      else
        for (const value of values) {
          const iteration = new Map(scope);
          bind(node.left.declarations?.[0]?.id || node.left, value, iteration);
          const result = statements([node.body], iteration);
          if (result.returned) return result;
        }
      return;
    }
    report(node, "unresolved-iteration", "Loop expansion is not resolved");
    if (node.init?.type === "VariableDeclaration")
      statements([node.init], loop);
    else expression(node.init, loop);
    if (node.left?.type === "VariableDeclaration")
      for (const item of node.left.declarations) bind(item.id, UNKNOWN, loop);
    expression(node.right || node.test, loop);
    statements([node.body], loop);
    expression(node.update, loop);
    return;
  }
}
function statementsTryStatement(ctx, node, scope) {
  const { statements } = ctx;
  ctx.report(
    node,
    "unresolved-exception-path",
    "Exception paths cannot share a resolved mutable environment",
  );
  statements([node.block], new Map(scope));
  if (node.handler) statements([node.handler.body], new Map(scope));
  if (node.finalizer) statements([node.finalizer], new Map(scope));
}
function statementsExportNamedDeclaration(ctx, node, scope) {
  const { imported, expression, statements, get, declare, exports } = ctx;
  {
    if (node.declaration?.type === "FunctionDeclaration") {
      const name = node.declaration.id?.name || "default",
        value = tagged("function", { node: node.declaration, scope });
      declare(scope, name, value);
      exports.set(
        node.type === "ExportDefaultDeclaration" ? "default" : name,
        value,
      );
    } else if (node.declaration?.type === "VariableDeclaration") {
      statements([node.declaration], scope);
      for (const item of node.declaration.declarations)
        if (item.id.type === "Identifier")
          exports.set(item.id.name, get(scope, item.id.name));
    } else if (node.declaration)
      exports.set("default", expression(node.declaration, scope));
    if (node.source) imported(node, node.source.value);
    for (const item of node.specifiers || [])
      exports.set(item.exported.name, get(scope, item.local.name));
    return;
  }
}
function statementsUnknown(ctx, node, scope) {
  const { report } = ctx;
  report(
    node,
    "unsupported-statement",
    `Unsupported executable syntax: ${node.type}`,
  );
}
const statementsHandlers = {
  FunctionDeclaration: statementsFunctionDeclaration,
  EmptyStatement: statementsFunctionDeclaration,
  ImportDeclaration: statementsImportDeclaration,
  VariableDeclaration: statementsVariableDeclaration,
  ExpressionStatement: statementsExpressionStatement,
  ReturnStatement: statementsReturnStatement,
  ThrowStatement: statementsThrowStatement,
  BlockStatement: statementsBlockStatement,
  IfStatement: statementsIfStatement,
  ForStatement: statementsForStatement,
  ForOfStatement: statementsForStatement,
  ForInStatement: statementsForStatement,
  WhileStatement: statementsForStatement,
  DoWhileStatement: statementsForStatement,
  TryStatement: statementsTryStatement,
  ExportNamedDeclaration: statementsExportNamedDeclaration,
  ExportDefaultDeclaration: statementsExportNamedDeclaration,
};
export function evaluateStatements(ctx, nodes, scope) {
  for (const node of nodes)
    if (node.type === "FunctionDeclaration")
      ctx.declare(scope, node.id.name, tagged("function", { node, scope }));
  for (const node of nodes) {
    ctx.visit();
    const result = (statementsHandlers[node.type] || statementsUnknown)(
      ctx,
      node,
      scope,
    );
    if (result?.returned) return result;
  }
  return { returned: false, value: undefined };
}
