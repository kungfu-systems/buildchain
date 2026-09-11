import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { fileURLToPath } from "node:url";

const prepare = "actions/runtime/environment/prepare/action.yml";
const preparation = "$/actions/runtime/environment/prepare";
const entryActions = new Set([
  "$/actions/runtime/selection/resolve",
  preparation,
  "$/actions/runtime/environment/activate",
]);
function yamlFiles(root, directory) {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory())
        return ["node_modules", "dist"].includes(entry.name)
          ? []
          : yamlFiles(root, file);
      return /\.ya?ml$/u.test(file) ? [file] : [];
    });
}
function auditCheckout(step, { file, at, prepared }, issues) {
  if (!step.uses?.startsWith("actions/checkout")) return 0;
  const directory = step.with?.path || ".";
  const acquired =
    /^\.buildchain\/(?:runtime|workflow-shell|bootstrap|attester-runtime|authority-runtime|policy-runtime|release-tail-runtime)$/u.test(
      directory,
    );
  if (acquired && (file !== prepare || directory !== ".buildchain/runtime"))
    issues.push(`${at}: execution code acquisition belongs only to ${prepare}`);
  if (prepared && directory === ".")
    issues.push(`${at}: source checkout erases the prepared runtime`);
  if (
    file !== prepare &&
    /(?:runtime[-_.]sha|job\.workflow_sha|BUILDCHAIN_RUNTIME_SHA)/u.test(
      JSON.stringify(step.with || {}),
    )
  )
    issues.push(`${at}: source checkout must not select execution code`);
  return Number(acquired);
}
function auditAction(step, { file, at, prepared }, issues) {
  const uses = step.uses || "";
  if (uses.startsWith("$/") && !entryActions.has(uses))
    issues.push(`${at}: business code must load from the selected runtime`);
  if (
    uses.startsWith("./actions/") ||
    /^\.\/\.buildchain\/(?!runtime\/).*\/actions\//u.test(uses)
  )
    issues.push(`${at}: noncanonical business action location`);
  if (
    file.startsWith(".github/workflows/") &&
    uses.startsWith("./.buildchain/runtime/actions/") &&
    !prepared
  )
    issues.push(`${at}: business action runs before preparation`);
  if (file.startsWith("actions/") && uses === preparation)
    issues.push(`${at}: business composites cannot prepare a second runtime`);
}
export function auditRuntimeEntry(root) {
  const issues = [];
  const files = [
    ...yamlFiles(root, "actions"),
    ...yamlFiles(root, ".github/workflows"),
  ];
  let acquisitions = 0;
  for (const file of files) {
    const doc = YAML.parse(fs.readFileSync(path.join(root, file), "utf8"));
    for (const [job, node] of Object.entries(
      doc.jobs || { action: doc.runs },
    )) {
      let preparations = 0;
      for (const step of node?.steps || []) {
        if (step.uses === preparation) preparations++;
        const context = {
          file,
          at: `${file}:${job}:${step.id || step.name || step.uses}`,
          prepared: preparations > 0,
        };
        auditAction(step, context, issues);
        acquisitions += auditCheckout(step, context, issues);
      }
      if (preparations > 1)
        issues.push(`${file}:${job}: runtime is prepared more than once`);
    }
  }
  if (acquisitions !== 1)
    issues.push(
      `Expected exactly one execution-code acquisition owner; found ${acquisitions}`,
    );
  return { files: files.length, acquisitions, issues };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = auditRuntimeEntry(path.resolve(import.meta.dirname, ".."));
  console.log(JSON.stringify(result));
  if (result.issues.length) process.exitCode = 1;
}
