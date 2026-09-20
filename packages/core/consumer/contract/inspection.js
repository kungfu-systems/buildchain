import path from "node:path";
import { createHash } from "node:crypto";
import { inspectJavaScriptModuleClosure } from "./javascript.js";
import { consumerWorkflows } from "./entries.js";
import { compileConsumerPlan, CONFIG_PATH } from "./plan.js";
import { checkWorkflowTaxonomy } from "../../workflow/workflow-taxonomy.mjs";

const INTERNAL_WIRING = [
  /\b(?:request-json|native-roots-json|used-nonces-json|warrant-result|source-proof|integration-proof)\b/iu,
  /\bbuildchain\s+(?:dev\s+(?:warrant|proof)|release|promote|recover|publish)\b/iu,
  /\b(?:(?:npm|pnpm|yarn)\s+publish|gh\s+release\s+(?:create|upload)|gh\s+run\s+download)\b/iu,
  /actions\/download-artifact@/u,
  /\.buildchain\/runtime\/|packages\/core\/(?:publication|release|dev-delivery)\//u,
  /\b(?:fencingToken|candidateRoot|sourceProofRoot|usedNonces|generationRoot|compareAndSwap)\b/u,
  /buildchain[-./][\w-]*(?:warrant|proof|fence|nonce|candidate|authority|transaction)/iu,
];

// The supplied file map must be the complete tracked consumer tree, including
// package scripts and invoked sources. Product data is not consumer wiring.
// Unknown product code stays diagnostic. controlIssues is usable only with the
// runtime's read-only product jobs; it does not certify a resolved source graph.
export function inspectConsumerContract(
  files,
  { channel = "v4", configPath = CONFIG_PATH } = {},
) {
  const issues = [];
  let plan;
  try {
    plan = compileConsumerPlan(files[configPath]);
  } catch (error) {
    issues.push(`${configPath}: ${error.message}`);
  }
  const workflows = consumerWorkflows(channel, configPath);
  for (const [file, expected] of Object.entries(workflows))
    if (files[file] !== expected)
      issues.push(`${file}: must match the generated thin caller`);
  if (
    Object.keys(files).some(
      (file) =>
        /^\.github\/workflows\/.*\.ya?ml$/iu.test(file) &&
        !Object.hasOwn(workflows, file),
    )
  ) {
    try {
      const inventory = checkWorkflowTaxonomy("", {
        files,
        integration: false,
        documentation: false,
      });
      issues.push(
        ...inventory.errors.map(
          (error) => `extra consumer workflow inventory: ${error}`,
        ),
      );
    } catch (error) {
      issues.push(`extra consumer workflow inventory: ${error.message}`);
    }
  }
  for (const file of [configPath, ...Object.keys(workflows)]) {
    const source = files[file];
    for (const pattern of INTERNAL_WIRING)
      if (pattern.test(String(source)))
        issues.push(
          `${file}: consumer owns internal orchestration (${pattern.source})`,
        );
  }
  const controlIssues = [...issues];
  const commandClosures = (plan?.products || []).map((product) => ({
    product: product.id,
    ...inspectConsumerCommandClosure({
      files,
      cwd: product.directory || ".",
      commands: ["install", "build", "verify"].flatMap(
        (stage) => product[stage] || [],
      ),
    }),
  }));
  for (const closure of commandClosures)
    for (const problem of closure.problems) {
      const issue = `${problem.file || closure.product}: ${problem.code}: ${problem.message || "consumer owns internal orchestration"}`;
      issues.push(issue);
      if (problem.code === "internal-orchestration") controlIssues.push(issue);
    }
  return {
    ok: issues.length === 0,
    issues,
    controlIssues,
    plan,
    commandClosures,
  };
}

// A bounded source graph, not an approval to execute tools. Every non-source
// executable remains a boundary until its actual implementation is resolved.
export function inspectConsumerCommandClosure({
  files,
  commands,
  cwd = ".",
  maxCommands = 256,
}) {
  if (
    !Array.isArray(commands) ||
    !Number.isSafeInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > 10000
  )
    throw Error(
      "Command traversal requires an array and a budget from 1 to 10000",
    );
  cwd = consumerPath(".", cwd);
  const graph = { edges: [], sources: {}, problems: [], boundaries: [] };
  const pending = commands.map((script) => ({
    kind: "shell",
    script,
    cwd,
    file: "<product>",
    ancestry: [],
  }));
  const seen = new Set();
  while (pending.length && seen.size < maxCommands) {
    const request = pending.shift();
    const key = JSON.stringify([
      request.kind,
      request.script,
      request.executable,
      request.argv,
      request.cwd,
    ]);
    if (request.ancestry.includes(key)) {
      graph.problems.push({ file: request.file, code: "command-cycle" });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const enqueue = (entry) =>
      pending.push({ ...entry, ancestry: [...request.ancestry, key] });
    try {
      expandConsumerCommand(files, request, graph, enqueue);
    } catch (error) {
      graph.problems.push({
        file: request.file,
        code: "unresolved-command",
        message: error.message,
      });
    }
  }
  if (pending.length)
    graph.problems.push({
      code: "command-budget",
      message: "Command graph exceeded its bounded expansion",
    });
  const sourceResolved = graph.problems.length === 0;
  return {
    ...graph,
    sourceResolved,
    commandEdgesResolved: sourceResolved && graph.boundaries.length === 0,
  };
}

function escapedShellCharacter(source, index, quote) {
  if (index >= source.length) throw Error("Incomplete shell escape");
  const char = source[index];
  if (char === "\n") return "";
  return quote === '"' && !/[\\$`"]/.test(char) ? `\\${char}` : char;
}

function commandWords(source) {
  if (typeof source !== "string" || source.length > 1024 * 1024)
    throw Error("Expected bounded shell source");
  const commands = [];
  let words = [],
    word = "",
    quote = "",
    active = false;
  const flushWord = () => {
    if (active) words.push(word);
    word = "";
    active = false;
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\" && quote !== "'") {
      const value = escapedShellCharacter(source, ++index, quote);
      word += value;
      active ||= value.length > 0;
    } else if (quote) {
      if (char === quote) quote = "";
      else {
        if (quote === '"' && /[$`]/u.test(char))
          throw Error("Shell expansion requires resolved execution context");
        word += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      active = true;
    } else if (/[$`(){}<>*?\[\]]/u.test(char))
      throw Error(
        "Shell expansion or control syntax requires explicit resolution",
      );
    else if (char === "#" && !active) {
      while (index < source.length && source[index] !== "\n") index++;
      flushCommand();
    } else if (char === ";" || char === "\n") flushCommand();
    else if (char === "&" || char === "|") {
      if (source[index + 1] !== char)
        throw Error(
          "Pipelines and background execution require explicit resolution",
        );
      flushCommand();
      index++;
    } else if (/\s/u.test(char)) flushWord();
    else {
      word += char;
      active = true;
    }
  }
  if (quote) throw Error("Unclosed shell quote");
  flushCommand();
  return commands;
}

function consumerPath(cwd, file) {
  if (
    typeof file !== "string" ||
    file.includes("\\") ||
    path.posix.isAbsolute(file)
  )
    throw Error(
      "Executable paths must resolve inside the supplied consumer tree",
    );
  const resolved = path.posix.normalize(path.posix.join(cwd, file));
  if (
    path.posix.isAbsolute(resolved) ||
    resolved === ".." ||
    resolved.startsWith("../")
  )
    throw Error("Executable path escapes consumer tree");
  return resolved;
}

function sourceBytes(files, file, graph) {
  if (!Object.hasOwn(files, file) || typeof files[file] !== "string")
    throw Error(`Executable source is absent: ${file}`);
  graph.sources[file] = createHash("sha256").update(files[file]).digest("hex");
  return files[file];
}

function expandPackageCommand(files, request, graph, enqueue) {
  const file = consumerPath(request.cwd, "package.json");
  const manifest = JSON.parse(sourceBytes(files, file, graph));
  const [operation, name, ...args] = request.argv;
  let keys = [`pre${name}`, name, `post${name}`];
  if (operation !== "run") {
    graph.boundaries.push({ ...request, code: "package-manager-operation" });
    if (
      request.executable !== "npm" ||
      request.argv.length !== 1 ||
      !["install", "ci"].includes(operation)
    )
      return;
    keys =
      "preinstall install postinstall prepublish preprepare prepare postprepare dependencies".split(
        " ",
      );
  } else {
    if (!name || args.length)
      throw Error("Package script arguments require explicit resolution");
    if (typeof manifest.scripts?.[name] !== "string")
      throw Error(`Package script is absent: ${name}`);
  }
  // Include lifecycle hooks conservatively even for a manager that disables them.
  for (const key of keys) {
    if (!Object.hasOwn(manifest.scripts || {}, key)) continue;
    const script = manifest.scripts[key];
    if (typeof script !== "string")
      throw Error(`Package script must be text: ${key}`);
    enqueue({ kind: "shell", script, cwd: request.cwd, file });
  }
}

function expandJavaScriptCommand(files, request, graph, enqueue) {
  if (request.argv.length !== 1 || request.argv[0].startsWith("-"))
    throw Error(
      "Node options, test runners and script arguments require explicit resolution",
    );
  const file = consumerPath(request.cwd, request.argv[0]);
  sourceBytes(files, file, graph);
  const report = inspectJavaScriptModuleClosure({
    files,
    entry: file,
    cwd: request.cwd,
  });
  Object.assign(graph.sources, report.sources);
  graph.problems.push(...report.problems);
  for (const edge of report.edges) {
    if (["process", "shell"].includes(edge.kind)) enqueue(edge);
    else {
      graph.edges.push(edge);
      if (edge.kind === "network") graph.boundaries.push(edge);
    }
  }
}

function expandConsumerCommand(files, request, graph, enqueue) {
  if (request.kind === "shell") {
    const cwd = request.cwd;
    for (const [executable, ...argv] of commandWords(request.script)) {
      if (executable === "cd")
        throw Error(
          "Shell directory changes require conditional execution resolution",
        );
      enqueue({ kind: "process", executable, argv, cwd, file: request.file });
    }
    return;
  }
  const { executable, argv, cwd, file } = request;
  graph.edges.push({ kind: "process", executable, argv, cwd, file });
  // Tool operands are data; inspect command positions and protocol switches.
  const invocation = [
    executable,
    ...argv.filter(
      (arg, index) =>
        arg.startsWith("--") ||
        (executable === "node" && index === 0) ||
        (/^(?:npm|pnpm|yarn|gh|buildchain)$/u.test(executable) && index < 3),
    ),
  ].join(" ");
  if (INTERNAL_WIRING.some((pattern) => pattern.test(invocation))) {
    graph.problems.push({
      file,
      code: "internal-orchestration",
      executable,
      argv,
    });
    return;
  }
  if (
    executable === "corepack" &&
    /^(?:npm|pnpm|yarn)(?:@[\d.]+)?$/u.test(argv[0] || "")
  ) {
    enqueue({
      ...request,
      executable: argv[0].split("@")[0],
      argv: argv.slice(1),
    });
  } else if (["npm", "pnpm", "yarn"].includes(executable))
    expandPackageCommand(files, request, graph, enqueue);
  else if (executable === "node")
    expandJavaScriptCommand(files, request, graph, enqueue);
  else if (["sh", "bash"].includes(executable)) {
    if (argv.length === 2 && ["-c", "-lc"].includes(argv[0]))
      enqueue({ kind: "shell", script: argv[1], cwd, file });
    else if (argv.length === 1 && !argv[0].startsWith("-")) {
      const target = consumerPath(cwd, argv[0]);
      enqueue({
        kind: "shell",
        script: sourceBytes(files, target, graph),
        cwd,
        file: target,
      });
    } else
      throw Error(
        "Shell options and script arguments require explicit resolution",
      );
  } else if (executable.startsWith("./") || executable.startsWith("../")) {
    const target = consumerPath(cwd, executable);
    const source = sourceBytes(files, target, graph);
    if (/^#!\/usr\/bin\/env node(?:\r?\n|$)/u.test(source))
      enqueue({ ...request, executable: "node", argv: [executable, ...argv] });
    else if (/^#!\/(?:usr\/bin\/env |bin\/)(?:ba)?sh(?:\r?\n|$)/u.test(source))
      enqueue({ ...request, executable: "bash", argv: [executable, ...argv] });
    else throw Error(`Executable interpreter is unresolved: ${target}`);
  } else
    graph.boundaries.push({
      kind: "process",
      executable,
      argv,
      cwd,
      file,
      code: "external-executable",
    });
}
