import { parse } from "acorn";
import path from "node:path";
import { isBuiltin } from "node:module";
import { serialize } from "node:v8";
import { createHash } from "node:crypto";
import {
  UNKNOWN,
  TAG,
  tagged,
  namespace,
  concreteArguments,
  processCalls,
  inertModules,
  inertGlobals,
} from "./javascript-values.js";
import { evaluateExpression, evaluateStatements } from "./javascript-syntax.js";
const moduleName = (value) => value.replace(/^node:/u, "");
class InvocationContext {
  constructor({ file, cwd, maxNodes }) {
    for (const key of Object.getOwnPropertyNames(InvocationContext.prototype))
      if (key !== "constructor") this[key] = this[key].bind(this);

    const edges = [],
      problems = [],
      exports = new Map(),
      active = new Set();
    const data = () => tagged("data", {});
    this.remaining = maxNodes;
    const report = (node, code, message) =>
      problems.push({ file, line: node?.loc?.start.line || 1, code, message });
    const edge = (node, value) => {
      if (value.arguments && !concreteArguments(value.arguments)) {
        report(
          node,
          "unresolved-edge-arguments",
          "Cross-module or network arguments must resolve as data",
        );
        return;
      }
      edges.push({ file, line: node.loc.start.line, ...value });
    };
    const root = new Map([
      ["require", tagged("require", {})],
      ["undefined", undefined],
      ["process", namespace("process")],
    ]);
    for (const name of inertGlobals) root.set(name, namespace(name));
    root.set("fetch", tagged("network", { name: "fetch" }));
    root.set("eval", tagged("dynamic-code", {}));
    root.set("Function", tagged("dynamic-code", {}));
    // Lexical scopes share binding cells. A copied block/function environment
    // must observe assignments to an outer binding, while declarations shadow it.
    for (const [name, value] of root) root.set(name, { value });
    const get = (scope, name) =>
      scope.has(name) ? scope.get(name).value : UNKNOWN;
    const declare = (scope, name, value) => scope.set(name, { value });

    Object.assign(this, {
      edges,
      problems,
      exports,
      active,
      data,
      report,
      edge,
      root,
      get,
      declare,
      cwd,
    });
  }
  visit() {
    if (--this.remaining < 0)
      throw Error("JavaScript invocation analysis exceeded its node budget");
  }
  expression(node, scope) {
    return evaluateExpression(this, node, scope);
  }
  statements(nodes, scope) {
    return evaluateStatements(this, nodes, scope);
  }
  checkCoercion(node, values) {
    const ctx = this;
    const { report } = ctx;

    if (
      values.some(
        (value) =>
          value === UNKNOWN ||
          (value !== null &&
            typeof value === "object" &&
            value[TAG] !== "data" &&
            !(
              value[TAG] === "data-method" && value.receiver?.[TAG] === "data"
            )),
      )
    )
      report(
        node,
        "unresolved-coercion",
        "Object or unknown-value coercion may invoke executable code",
      );
  }
  bind(pattern, value, scope) {
    const ctx = this;
    const { bind, member, expression, report, declare } = ctx;

    if (!pattern) return;
    if (pattern.type === "Identifier") declare(scope, pattern.name, value);
    else if (pattern.type === "AssignmentPattern")
      bind(
        pattern.left,
        value === undefined ? expression(pattern.right, scope) : value,
        scope,
      );
    else if (pattern.type === "ObjectPattern")
      for (const property of pattern.properties) {
        if (property.type === "RestElement")
          bind(property.argument, UNKNOWN, scope);
        else
          bind(
            property.value,
            member(value, property.key.name ?? property.key.value),
            scope,
          );
      }
    else if (pattern.type === "ArrayPattern")
      pattern.elements.forEach((item, index) =>
        bind(item, Array.isArray(value) ? value[index] : UNKNOWN, scope),
      );
    else
      report(pattern, "unresolved-binding", "Unsupported executable binding");
  }
  member(value, key) {
    const ctx = this;

    if (typeof key !== "string" && typeof key !== "number") return UNKNOWN;
    if (value?.[TAG] === "data")
      return tagged("data-method", { receiver: value, name: String(key) });
    if (value?.[TAG] === "namespace")
      return tagged("member", {
        specifier: value.specifier,
        name: String(key),
      });
    if (value === UNKNOWN || value == null) return UNKNOWN;
    if (typeof value === "string" || Array.isArray(value)) {
      if (key === "length") return value.length;
      if (/^[0-9]+$/u.test(String(key))) return value[Number(key)];
      return tagged("data-method", { receiver: value, name: String(key) });
    }
    return Object.hasOwn(value, key) ? value[key] : UNKNOWN;
  }
  imported(node, specifier) {
    const ctx = this;
    const { report, edge } = ctx;

    if (typeof specifier !== "string" || !specifier) {
      report(
        node,
        "unresolved-module",
        "Module specifier must resolve before execution",
      );
      return UNKNOWN;
    }
    edge(node, { kind: "module", specifier });
    return namespace(specifier);
  }
  invokeFunction(node, callable, args) {
    const ctx = this;
    const { bind, expression, statements, report, active } = ctx;

    if (active.has(callable.node) || active.size >= 32) {
      report(
        node,
        "recursive-invocation",
        "Invocation graph requires a bounded nonrecursive expansion",
      );
      return UNKNOWN;
    }
    active.add(callable.node);
    try {
      const scope = new Map(callable.scope);
      callable.node.params.forEach((parameter, index) =>
        bind(parameter, args[index], scope),
      );
      const value =
        callable.node.body.type === "BlockStatement"
          ? statements(callable.node.body.body, scope).value
          : expression(callable.node.body, scope);
      if (callable.node.async || callable.node.generator) {
        this.report(
          node,
          "unresolved-async-result",
          "Async and generator return behavior requires explicit resolution",
        );
        return UNKNOWN;
      }
      return value;
    } finally {
      active.delete(callable.node);
    }
  }
  subprocess(node, name, args) {
    const ctx = this;
    const { report, edge, cwd } = ctx;

    const shell = name === "exec" || name === "execSync";
    const argv = Array.isArray(args[1]) ? args[1] : [];
    const suppliedOptions = args[Array.isArray(args[1]) ? 2 : 1];
    const options =
      suppliedOptions?.[TAG] === "function" ? undefined : suppliedOptions;
    if (
      typeof args[0] !== "string" ||
      !argv.every((item) => typeof item === "string") ||
      options === UNKNOWN ||
      (options !== undefined &&
        (!options || typeof options !== "object" || options[TAG])) ||
      (options?.cwd !== undefined && typeof options.cwd !== "string") ||
      options?.env !== undefined ||
      options?.shell
    ) {
      report(
        node,
        "unresolved-process",
        "Process command, arguments, directory and shell mode must resolve",
      );
      return UNKNOWN;
    }
    const directory =
      options?.cwd === undefined
        ? cwd
        : path.posix.isAbsolute(options.cwd)
          ? options.cwd
          : path.posix.join(cwd, options.cwd);
    if (shell) edge(node, { kind: "shell", script: args[0], cwd: directory });
    else
      edge(node, {
        kind: "process",
        executable: name === "fork" ? "node" : args[0],
        argv: name === "fork" ? [args[0], ...argv] : argv,
        cwd: directory,
      });
    return UNKNOWN;
  }
  inspectCallbacks(node, args) {
    const seen = new Set();
    const callbacks = (values) => {
      this.visit();
      for (const value of values) {
        if (value?.[TAG] === "function")
          this.invokeFunction(node, value, [UNKNOWN]);
        else if (
          value &&
          typeof value === "object" &&
          !value[TAG] &&
          !seen.has(value)
        ) {
          seen.add(value);
          callbacks(Object.values(value));
        }
      }
    };
    callbacks(args);
  }
  invokeData(node, callable, args) {
    const { data, report } = this;
    const callbacks = (values) => this.inspectCallbacks(node, values);
    if (
      callable.name === "slice" &&
      args.every((value) => value === undefined || Number.isInteger(value))
    )
      return typeof callable.receiver === "string" ||
        Array.isArray(callable.receiver)
        ? callable.receiver.slice(...args)
        : data();
    if (
      callable.name === "join" &&
      Array.isArray(callable.receiver) &&
      callable.receiver.every((value) => typeof value === "string") &&
      (args[0] === undefined || typeof args[0] === "string")
    )
      return callable.receiver.join(args[0]);
    if (callable.name === "entries" && Array.isArray(callable.receiver))
      return [...callable.receiver.entries()];
    if (callable.name === "push" && Array.isArray(callable.receiver))
      return callable.receiver.push(...args);
    if (
      [
        "pop",
        "shift",
        "unshift",
        "splice",
        "reverse",
        "sort",
        "fill",
        "copyWithin",
      ].includes(callable.name)
    )
      report(
        node,
        "unsupported-mutation",
        `Unsupported data mutation: ${callable.name}`,
      );
    callbacks(args);
    return data();
  }
  invokeMember(node, callable, args) {
    const { data, report, edge, subprocess, cwd } = this;
    const callbacks = (values) => this.inspectCallbacks(node, values);
    const specifier = moduleName(callable.specifier),
      name = callable.name;
    if (specifier === "child_process") {
      callbacks(args);
      if (processCalls.has(name)) return subprocess(node, name, args);
      report(
        node,
        "unresolved-process-api",
        `Unsupported process API: ${name}`,
      );
    } else if (
      ["http", "https", "http2", "net", "tls", "dgram"].includes(specifier)
    )
      edge(node, {
        kind: "network",
        operation: `${specifier}.${name}`,
        arguments: args,
      });
    else if (specifier === "module" && name === "createRequire")
      return tagged("require", {});
    else if (
      specifier === "path" &&
      ["join", "dirname", "basename", "extname", "normalize"].includes(name) &&
      args.every((value) => typeof value === "string")
    )
      return path.posix[name](...args);
    else if (specifier === "process" && name === "cwd") return cwd;
    else if (inertModules.has(specifier) || inertGlobals.has(specifier)) {
      if (
        specifier === "Object" &&
        [
          "defineProperty",
          "defineProperties",
          "setPrototypeOf",
          "create",
        ].includes(name)
      )
        report(
          node,
          "unsupported-object-runtime",
          `Unsupported object execution semantics: ${name}`,
        );
      callbacks(args);
      return data();
    } else if (
      !specifier.startsWith("node:") &&
      !["process", "vm", "module"].includes(specifier)
    )
      edge(node, {
        kind: "module-call",
        specifier: callable.specifier,
        exportName: name,
        arguments: args,
      });
    else
      report(
        node,
        "unresolved-runtime-api",
        `Unsupported executable API: ${specifier}.${name}`,
      );
    return UNKNOWN;
  }
  invoke(node, callable, args) {
    switch (callable?.[TAG]) {
      case "function":
        return this.invokeFunction(node, callable, args);
      case "require":
        return this.imported(node, args[0]);
      case "namespace":
        if (inertGlobals.has(callable.specifier)) {
          this.inspectCallbacks(node, args);
          return this.data();
        }
        break;
      case "data-method":
        return this.invokeData(node, callable, args);
      case "member":
        return this.invokeMember(node, callable, args);
      case "network":
        this.edge(node, {
          kind: "network",
          operation: callable.name,
          arguments: args,
        });
        return UNKNOWN;
      case "dynamic-code":
        this.report(
          node,
          "dynamic-code",
          "Dynamic code cannot establish a closed invocation graph",
        );
        return UNKNOWN;
    }
    this.report(
      node,
      "unresolved-call",
      "Call target cannot be resolved from source",
    );
    return UNKNOWN;
  }
}
// No consumer code is executed. Callers must expand every returned edge and
// reject problems before treating this local analysis as a complete graph.
export function inspectJavaScriptInvocations({
  source,
  file,
  cwd = ".",
  calledExports = [],
  maxNodes = 50000,
}) {
  const context = new InvocationContext({ file, cwd, maxNodes });
  try {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1000000)
      throw Error(
        "JavaScript node budget must be an integer from 1 to 1000000",
      );
    if (typeof source !== "string" || source.length > 1024 * 1024)
      throw Error("JavaScript source exceeds the bounded input size");
    const program = parse(source, {
      ecmaVersion: "latest",
      sourceType: file.endsWith(".cjs") ? "commonjs" : "module",
      locations: true,
    });
    context.statements(program.body, context.root);
    for (const request of calledExports)
      context.invoke(
        program,
        context.exports.get(request.name),
        request.arguments || [],
      );
  } catch (error) {
    context.report(null, "analysis-failed", error.message);
  }
  return {
    ok: context.problems.length === 0,
    edges: context.edges,
    problems: context.problems,
  };
}

function resolveSourceModule(files, from, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw Error(`Dependency requires an exact source resolution: ${specifier}`);
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier),
  );
  if (target === ".." || target.startsWith("../") || target.includes("\\"))
    throw Error(`Module escapes the supplied source tree: ${specifier}`);
  if (!Object.hasOwn(files, target) || typeof files[target] !== "string")
    throw Error(`Module source is absent: ${target}`);
  if (!/\.[cm]?js$/u.test(target))
    throw Error(`Unsupported executable module: ${target}`);
  return target;
}

// This walks a supplied source snapshot. Package resolution, shell commands,
// and generated executable files remain explicit boundaries for the caller;
// an unresolved dependency cannot be silently omitted from a passing graph.
export function inspectJavaScriptModuleClosure({
  files,
  entry,
  cwd = ".",
  maxInvocations = 256,
  maxNodes = 50000,
}) {
  const edges = [],
    problems = [],
    sources = new Map(),
    visited = new Set();
  const queue = [{ file: entry, calledExports: [], ancestry: [] }];
  while (queue.length && visited.size < maxInvocations) {
    const request = queue.shift();
    const key = serialize([request.file, request.calledExports]).toString(
      "base64",
    );
    if (request.ancestry.includes(key)) {
      problems.push({
        file: request.file,
        code: "cyclic-module-invocation",
        message: "Module calls require a bounded expansion",
      });
      continue;
    }
    if (visited.has(key)) continue;
    visited.add(key);
    const source = Object.hasOwn(files, request.file)
      ? files[request.file]
      : undefined;
    const report = inspectJavaScriptInvocations({
      source,
      file: request.file,
      cwd,
      calledExports: request.calledExports,
      maxNodes,
    });
    problems.push(...report.problems);
    if (typeof source === "string")
      sources.set(
        request.file,
        createHash("sha256").update(source).digest("hex"),
      );
    for (const edge of report.edges) {
      edges.push(edge);
      if (!["module", "module-call"].includes(edge.kind)) continue;
      if (isBuiltin(edge.specifier)) {
        if (edge.kind === "module-call")
          problems.push({
            ...edge,
            code: "unresolved-builtin",
            message: "Builtin execution was not resolved locally",
          });
        continue;
      }
      try {
        const target = resolveSourceModule(files, request.file, edge.specifier);
        queue.push({
          file: target,
          calledExports:
            edge.kind === "module-call"
              ? [{ name: edge.exportName, arguments: edge.arguments }]
              : [],
          ancestry: [...request.ancestry, key],
        });
      } catch (error) {
        problems.push({
          file: request.file,
          line: edge.line,
          code: "unresolved-module-source",
          message: error.message,
        });
      }
    }
  }
  if (queue.length)
    problems.push({
      file: entry,
      code: "invocation-budget",
      message: "Module closure exceeded its invocation budget",
    });
  return {
    ok: problems.length === 0,
    sources: Object.fromEntries(sources),
    edges,
    problems,
  };
}
