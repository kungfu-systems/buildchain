import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { actionInventory } from "../packages/core/contracts/action-inventory.js";
import { inspectActionTaxonomy } from "../packages/core/contracts/action-taxonomy.js";
import {
  inspectWorkflowJob,
  localActionDirectory,
} from "./workflow-action-graph.mjs";

function filesBelow(root, relative) {
  return fs
    .readdirSync(path.join(root, relative), {
      withFileTypes: true,
      recursive: true,
    })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .filter(
      (file) => !file.includes("/node_modules/") && !file.includes("/dist/"),
    );
}

export function inspectModuleDependencies(root, files) {
  const issues = [];
  const edges = [];
  for (const file of files.filter((file) => /\.(?:mjs|cjs|js)$/u.test(file))) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        const parent = node.parent;
        const declaration =
          (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node;
        const call =
          ts.isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            ["require", "require.resolve"].includes(
              parent.expression.getText(source),
            ));
        if ((declaration || call) && node.text.startsWith(".")) {
          const target = path.posix.normalize(
            path.posix.join(path.posix.dirname(file), node.text),
          );
          edges.push({ from: file, to: target });
          if (!fs.existsSync(path.join(root, target)))
            issues.push(`${file}: missing module ${target}`);
          if (
            file.startsWith("packages/core/") &&
            !target.startsWith("packages/core/")
          )
            issues.push(
              `${file}: runtime dependency escapes its layer: ${target}`,
            );
          if (
            file.startsWith("bin/") &&
            !target.startsWith("bin/") &&
            !target.startsWith("packages/core/")
          )
            issues.push(
              `${file}: CLI dependency escapes its layers: ${target}`,
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { edges, issues };
}

function scriptLines(step) {
  return Math.max(
    ...[step.run, step.with?.script].map((value) =>
      typeof value === "string" ? value.trim().split("\n").length : 0,
    ),
  );
}

export function inspectCompositeSteps(metadata, label) {
  const issues = [];
  if (/\boutputs\.[\w-]*(?:fromJSON|toJSON)\(/u.test(JSON.stringify(metadata)))
    issues.push(
      `${label}: output property contains an invalid expression call`,
    );
  for (const step of metadata.runs?.steps || []) {
    const location = `${label}/${step.id || step.name || "step"}`;
    if (typeof step.uses !== "string" || !step.uses.trim())
      issues.push(
        `${location}: composite steps must invoke an action with uses`,
      );
    for (const key of ["run", "shell", "working-directory"])
      if (Object.hasOwn(step, key))
        issues.push(`${location}: composite cannot own ${key}`);
    if (Object.hasOwn(step.with || {}, "script"))
      issues.push(
        `${location}: composite cannot pass executable script to another action`,
      );
  }
  return issues;
}

export function inspectWorkflowNodes(source, label, budgets) {
  const issues = [];
  const workflow = parseYaml(source);
  for (const event of ["workflow_call", "workflow_dispatch"]) {
    const declaration = workflow.on?.[event];
    for (const field of ["inputs", "outputs", "secrets"]) {
      if (!declaration || !Object.hasOwn(declaration, field)) continue;
      const value = declaration[field];
      if (!value || typeof value !== "object" || Array.isArray(value))
        issues.push(
          `${label}: ${event}.${field} must be a mapping when declared`,
        );
    }
  }
  for (const [id, job] of Object.entries(workflow.jobs || {})) {
    if (!job.steps) continue;
    if (job.steps.length > budgets.workflowStepsPerJob)
      issues.push(
        `${label}#${id}: ${job.steps.length} steps exceed ${budgets.workflowStepsPerJob} semantic nodes`,
      );
    for (const step of job.steps) {
      if (scriptLines(step) > budgets.workflowInlineScriptLines)
        issues.push(
          `${label}#${id}/${step.id || step.name}: workflow contains executable implementation`,
        );
    }
  }
  return issues;
}

export function inspectCompositeAdmission(root, workflow, label = "workflow") {
  const issues = [];
  for (const [name, job] of Object.entries(workflow.jobs || {})) {
    for (const step of job.steps || []) {
      if (
        Object.values(step.with || {}).some((value) =>
          /^\$\{\{\s*(?:toJSON\(\s*)?job\.status\s*\)?\s*\}\}$/.test(
            String(value),
          ),
        )
      )
        issues.push(`${label}#${name}: action inputs freeze live job.status`);
    }
    for (let index = 0; index + 2 < (job.steps?.length || 0); index++) {
      const [source, loader, call] = job.steps.slice(index, index + 3);
      if (
        !source.uses?.startsWith("actions/checkout@") ||
        source.with?.path ||
        !loader.uses?.startsWith("actions/checkout@") ||
        call.id !== "node" ||
        !call.uses?.startsWith("./.buildchain/")
      )
        continue;
      const outcome = `\${{ steps.${source.id}.outcome }}`;
      const actionPath = `${call.uses.replace(/^\.\/\.buildchain\/(?:workflow-shell|runtime)\//, "")}/action.yml`;
      if (
        loader.if !== "${{ always() }}" ||
        call.if !== "${{ always() }}" ||
        call.with?.["source-checkout-outcome"] !== outcome
      ) {
        issues.push(
          `${label}#${name}: source checkout failure cannot reach node diagnostics`,
        );
        continue;
      }
      const metadata = parseYaml(
        fs.readFileSync(path.join(root, actionPath), "utf8"),
      );
      const guard = metadata.runs.steps?.[0];
      if (
        guard?.id !== "source-boundary" ||
        guard.if !== "${{ always() }}" ||
        localActionDirectory(guard.uses) !== "actions/build/source/admit" ||
        guard.with?.["source-checkout-outcome"] !==
          "${{ inputs.source-checkout-outcome }}"
      )
        issues.push(
          `${label}#${name}: failed source checkout can execute node business steps`,
        );
    }
  }
  return issues;
}

export function inspectPublicActionNodes(actions, publicNodes) {
  const issues = [];
  if (!Array.isArray(publicNodes))
    return ["public Action registry must be an array"];
  const known = new Set(
    actions.map((action) => action.directory.replace(/^actions\//u, "")),
  );
  const seen = new Set();
  for (const node of publicNodes) {
    if (seen.has(node)) issues.push(`duplicate public Action node: ${node}`);
    if (!known.has(node)) issues.push(`unknown public Action node: ${node}`);
    seen.add(node);
  }
  return issues;
}

export function inspectRequestJsonFields(graph, requestFields) {
  const issues = [];
  const workflowInputs =
    graph.workflow.on?.workflow_call?.inputs ||
    graph.workflow.on?.workflow_dispatch?.inputs ||
    {};
  const scopes = new Map([
    [
      "",
      { inputs: new Set(Object.keys(workflowInputs)), request: requestFields },
    ],
  ]);
  for (const step of graph.steps) {
    const scope = scopes.get(step.ancestry.join(" > "));
    if (scope?.request) {
      for (const match of JSON.stringify(step).matchAll(
        /fromJSON\(inputs\.request-json\)\.([a-zA-Z0-9-]+)/gu,
      )) {
        if (!scope.request.has(match[1]))
          issues.push(
            `${step.ancestry.at(-1) || "workflow"}: undeclared request field ${match[1]}`,
          );
      }
    }
    const directory = localActionDirectory(step.uses);
    if (!directory) continue;
    const value = step.with?.["request-json"];
    const request =
      value === "${{ toJSON(inputs) }}"
        ? scope?.inputs
        : value === "${{ inputs.request-json }}"
          ? scope?.request
          : undefined;
    scopes.set([...step.ancestry, directory].join(" > "), {
      inputs: new Set(Object.keys(graph.actions.get(directory).inputs || {})),
      request,
    });
  }
  return [...new Set(issues)];
}

export function checkCodeLayout(root) {
  const policy = JSON.parse(
    fs.readFileSync(path.join(root, "architecture/code-layout.json"), "utf8"),
  );
  const issues = [];
  if (policy.schema !== "buildchain.code-layout/v1")
    throw new Error("unsupported code layout schema");
  const capabilities = new Set(policy.capabilities);
  for (const entry of fs.readdirSync(path.join(root, "packages/core"), {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory()
        ? !capabilities.has(entry.name)
        : !policy.runtimeRootFiles.includes(entry.name)
    )
      issues.push(`packages/core/${entry.name}: undeclared runtime owner`);
  }
  const actions = actionInventory(root);
  issues.push(
    ...inspectActionTaxonomy(
      actions,
      JSON.parse(
        fs.readFileSync(
          path.join(root, "architecture/action-taxonomy.json"),
          "utf8",
        ),
      ),
    ),
  );
  issues.push(...inspectPublicActionNodes(actions, policy.publicActionNodes));
  for (const file of filesBelow(root, "bin")) {
    if (!policy.cliEntrypoints?.includes(file))
      issues.push(`${file}: undeclared CLI entrypoint`);
    const lines = fs
      .readFileSync(path.join(root, file), "utf8")
      .trim()
      .split("\n").length;
    if (lines > policy.budgets.cliEntryLines)
      issues.push(`${file}: ${lines} lines exceed thin CLI entry budget`);
  }
  for (const action of actions) {
    if (!capabilities.has(action.capability))
      issues.push(`${action.directory}: undeclared capability`);
    const metadata = fs.readFileSync(
      path.join(root, action.directory, "action.yml"),
      "utf8",
    );
    if (action.using === "composite") {
      issues.push(
        ...inspectCompositeSteps(parseYaml(metadata), action.directory),
      );
      const implementation = metadata
        .slice(metadata.search(/^runs:/mu))
        .trim()
        .split("\n").length;
      if (implementation > policy.budgets.compositeImplementationLines)
        issues.push(
          `${action.directory}: composite implementation has ${implementation} lines`,
        );
      for (const step of parseYaml(metadata).runs.steps) {
        if (scriptLines(step) > policy.budgets.compositeInlineScriptLines)
          issues.push(
            `${action.directory}/${step.id || step.name}: inline implementation exceeds ${policy.budgets.compositeInlineScriptLines} lines`,
          );
      }
    }
    for (const file of filesBelow(root, action.directory).filter((file) =>
      /\.(mjs|cjs|js)$/u.test(file),
    )) {
      const lines = fs
        .readFileSync(path.join(root, file), "utf8")
        .trim()
        .split("\n").length;
      if (lines > policy.budgets.actionEntryLines)
        issues.push(`${file}: ${lines} lines exceed thin entry budget`);
    }
  }
  const runtimeFiles = [
    ...filesBelow(root, "packages/core"),
    ...filesBelow(root, "bin"),
    ...filesBelow(root, "actions"),
  ];
  const dependencies = inspectModuleDependencies(root, runtimeFiles);
  issues.push(...dependencies.issues);
  for (const file of filesBelow(root, ".github/workflows").filter((file) =>
    /\.ya?ml$/u.test(file),
  )) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const workflow = parseYaml(source);
    issues.push(...inspectCompositeAdmission(root, workflow, file));
    issues.push(...inspectWorkflowNodes(source, file, policy.budgets));
    const schemaPath = policy.workflowRequestSchemas?.[file];
    const requestFields = schemaPath
      ? new Set(
          Object.keys(
            JSON.parse(fs.readFileSync(path.join(root, schemaPath), "utf8"))
              .properties,
          ),
        )
      : undefined;
    for (const jobId of Object.keys(workflow.jobs || {})) {
      issues.push(
        ...inspectRequestJsonFields(
          inspectWorkflowJob(file, jobId, root),
          requestFields,
        ).map((issue) => `${file}#${jobId}: ${issue}`),
      );
    }
  }
  return {
    issues,
    actionCount: actions.length,
    moduleEdges: dependencies.edges.length,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = checkCodeLayout(path.resolve(import.meta.dirname, ".."));
  if (result.issues.length) {
    console.error(result.issues.join("\n"));
    process.exitCode = 1;
  } else console.log(JSON.stringify(result));
}
