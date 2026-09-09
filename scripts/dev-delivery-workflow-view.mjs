import fs from "node:fs";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
const actionPrefix =
  "./.buildchain/workflow-shell/.github/actions/dev-delivery/";
const expression = (value) =>
  value
    .trim()
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");

export function workflowJobs(text) {
  const start = text.indexOf("\njobs:\n");
  if (start < 0) throw new Error("Workflow jobs are missing");
  return [
    ...text
      .slice(start + 7)
      .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm),
  ].map((m) => ({ id: m[1], text: m[0] }));
}

export function nodeCalls(job) {
  return job.text
    .split(/(?=^      - )/m)
    .slice(1)
    .map((text) => {
      const uses = text.match(/^        uses: (.+)$/m)?.[1];
      if (!uses?.startsWith(actionPrefix)) return null;
      const id = text.match(/^        id: (.+)$/m)?.[1];
      const inputs = Object.fromEntries(
        [...text.matchAll(/^          ([\w-]+): (.+)$/gm)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      return { id, node: uses.slice(actionPrefix.length), inputs, text };
    })
    .filter(Boolean);
}

export function actionText(node, root = repositoryRoot) {
  if (!/^[a-z]+$/.test(node)) throw new Error("Invalid delivery node");
  return fs.readFileSync(
    path.join(root, `.github/actions/dev-delivery/${node}/action.yml`),
    "utf8",
  );
}

function actionOutputs(text) {
  const block = text.match(/^outputs:\n([\s\S]*?)(?=^runs:)/m)?.[1] || "";
  return Object.fromEntries(
    [
      ...block.matchAll(
        /^  ([\w-]+):\n\s+description:[^\n]*\n\s+value: (.+)$/gm,
      ),
    ].map((m) => [m[1], expression(m[2])]),
  );
}

// Expand only the actual reachable calls, resolving every exported predecessor
// value. This lets existing security assertions inspect executed operations,
// rather than merely finding matching text in unreferenced action files.
export function expandDevDeliveryWorkflow(relative, root = repositoryRoot) {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  let output = text.slice(0, text.indexOf("\njobs:\n") + 7);
  for (const job of workflowJobs(text)) {
    const calls = nodeCalls(job);
    if (!calls.length) {
      output += job.text;
      continue;
    }
    const exports = {};
    for (const call of calls) {
      for (const [key, value] of Object.entries(
        actionOutputs(actionText(call.node, root)),
      )) {
        exports[`steps.${call.id}.outputs.${key}`] = value;
      }
    }
    const resolveExports = (value) =>
      value.replace(
        /steps\.[\w-]+\.outputs\.[\w-]+/g,
        (ref) => exports[ref] || ref,
      );
    output += resolveExports(
      job.text.slice(0, job.text.indexOf("    steps:\n") + 11),
    );
    for (const call of calls) {
      if (call.inputs["request-json"] !== "${{ toJSON(inputs) }}")
        throw new Error("Delivery request must preserve typed workflow inputs");
      if (
        call.inputs["needs-json"] &&
        call.inputs["needs-json"] !== "${{ toJSON(needs) }}"
      )
        throw new Error(
          "Delivery dependencies must preserve exact job results",
        );
      const source = actionText(call.node, root);
      for (let step of source
        .split("  steps:\n")[1]
        .split(/(?=^    - )/m)
        .filter((s) => s.trim())) {
        if (["native", "settle"].includes(call.node)) {
          const guard = step.match(
            /^      if: \$\{\{ inputs\.phase == '([^']+)' && \((.*)\) \}\}$/m,
          );
          if (!guard)
            throw new Error(
              "Every multi-domain step requires a literal phase guard",
            );
          if (guard[1] !== call.inputs.phase) continue;
          let condition = guard[2];
          if (condition === "success()")
            step = step.replace(guard[0] + "\n", "");
          else {
            condition = condition.replace(/^success\(\) && \((.*)\)$/, "$1");
            step = step.replace(guard[0], `      if: ${condition}`);
          }
        }
        if ((call.node === "land" && step.includes("      id: merge\n")) || (call.node === "reserve" && step.includes("      id: submit\n"))) {
          if (
            call.inputs["predecessors-ok"] !== "${{ job.status == 'success' }}" ||
            !call.text.includes("        if: always()")
          )
            throw new Error(
              "Delivery mutation must retain parent failure state and unconditional reporting",
            );
          step = step.replace(
            /^      if: inputs\.predecessors-ok == 'true' && \((.*)\)$/m,
            "      if: $1",
          );
        }
        step = step
          .replace(/fromJSON\(inputs\.request-json\)/g, "inputs")
          .replace(/fromJSON\(inputs\.needs-json\)/g, "needs")
          .replace(
            /inputs\.github-token \|\| github\.token/g,
            "secrets.github-token || github.token",
          );
        // Public inputs now retain their original names; replace only explicit
        // predecessor ports, never ordinary public request fields.
        for (const [key, value] of Object.entries(call.inputs)) {
          if (
            [
              "request-json",
              "needs-json",
              "github-token",
              "phase",
              "predecessors-ok",
            ].includes(key)
          )
            continue;
          step = step.replaceAll(
            `inputs.${key}`,
            resolveExports(expression(value)),
          );
        }
        output +=
          step
            .split("\n")
            .map((line) => (line ? "  " + line : ""))
            .join("\n") + "\n";
      }
    }
  }
  return output;
}

export function normalizeWorkflowOperations(text) {
  const lines = text.split("\n");
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*shell: bash\s*$/.test(line)) continue;
    result.push(
      line
        .replace(/\s+$/, "")
        .replace(/^(\s*if:) \$\{\{\s*(.*?)\s*\}\}$/, "$1 $2"),
    );
    const block = line.match(/^(\s*)(-\s+)?[\w-]+:\s*[>|][+-]?\s*$/);
    if (!block) continue;
    const indent = block[1].length + (block[2]?.length || 0);
    const scalar = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() && next.match(/^\s*/)[0].length <= indent) break;
      scalar.push(next);
      index += 1;
    }
    // Keep shell/data bytes, including internal blank lines and trailing spaces.
    // YAML separator lines after the scalar do not change its content.
    while (scalar.length && !scalar.at(-1).trim()) scalar.pop();
    result.push(...scalar);
  }
  return result.join("\n") + "\n";
}
