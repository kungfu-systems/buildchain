import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as yaml } from "yaml";
import { format } from "prettier";
import { standardConsumerExample } from "../packages/core/consumer/contract/examples.js";
import { inspectConsumerContract } from "../packages/core/consumer/contract/inspection.js";
import { workflowPath } from "../packages/core/workflow/workflow-taxonomy.mjs";

const root = process.cwd(),
  check = process.argv.includes("--check");
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

function output(file, value) {
  const target = path.join(root, file);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== value)
      throw new Error(`${file}: generated contract drift`);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  }
}

function destination(name) {
  if (name === "config-path") return "normal-entry.config-path";
  if (name === "runtime-ref") return "recovery-entry.runtime-ref";
  if (/token|secret|private-key|app-id/u.test(name))
    return "setup.provider-authority";
  if (/run|resume|recover|transaction|discussion|attempt/u.test(name))
    return "attempt.material-index";
  if (/root|proof|nonce|warrant|fence|generation|candidate/u.test(name))
    return "attempt.internal-authority";
  return "internal.plan-derived-input";
}

function workflowInventory() {
  const taxonomy = JSON.parse(
    fs.readFileSync("architecture/workflow-taxonomy.json", "utf8"),
  );
  return taxonomy.entries
    .filter((entry) => ["public", "self"].includes(entry.role))
    .map((entry) => {
      const file = workflowPath(entry),
        document = yaml(fs.readFileSync(file, "utf8"));
      return {
        path: file,
        role: entry.role,
        events: Object.keys(document.on || {}).sort(),
        secrets: Object.keys(document.on?.workflow_call?.secrets || {}).sort(),
        outputs: Object.keys(document.on?.workflow_call?.outputs || {}).sort(),
        destination:
          entry.role === "self"
            ? "self-dogfood.two-callers-or-internal-component"
            : "internal-component.behind-pipeline-or-recovery",
        interfaces: ["workflow_call", "workflow_dispatch"].flatMap((trigger) =>
          Object.entries(document.on?.[trigger]?.inputs || {}).map(
            ([name, definition]) => ({
              trigger,
              name,
              definition,
              destination: destination(name),
            }),
          ),
        ),
        calls: Object.entries(document.jobs || {})
          .filter(([, job]) => job.uses)
          .map(([id, job]) => ({
            id,
            uses: job.uses,
            inputs: Object.keys(job.with || {}).sort(),
            destination: "internal.workflow-composition",
          })),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function consumerSourceInventory() {
  return tracked
    .filter(
      (file) =>
        (/^(?:templates|fixtures|\.buildchain)\//u.test(file) ||
          file === "package.json") &&
        /\.(?:ya?ml|toml|json|[cm]?js|sh|py|ps1)$/u.test(file) &&
        !file.startsWith("templates/minimal-consumer/"),
    )
    .map((file) => {
      const bytes = fs.readFileSync(file, "utf8");
      const kind = /\.ya?ml$/u.test(file)
        ? "caller"
        : /\.toml$/u.test(file)
          ? "config"
          : "consumer-source";
      return {
        path: file,
        kind,
        destination:
          kind === "caller"
            ? "replace-with-shared-pair"
            : kind === "config"
              ? "closed-toml-plan"
              : "retain-product-source; move-orchestration-into-runtime",
        commandReferences: [
          ...new Set(
            bytes.match(
              /(?:packages\/core|scripts)\/[A-Za-z0-9_./-]+\.(?:[cm]?js|sh|py|ps1)/gu,
            ) || [],
          ),
        ].sort(),
      };
    });
}

for (const type of ["npm", "binary", "paper"]) {
  const files = standardConsumerExample(type);
  if (check) {
    const directory = `templates/minimal-consumer/${type}`;
    for (const entry of fs.readdirSync(directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) continue;
      const file = path
        .relative(directory, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/");
      if (!entry.isFile() || !Object.hasOwn(files, file))
        throw new Error(
          `${directory}/${file}: undeclared generated consumer file`,
        );
    }
  }
  const inspection = inspectConsumerContract(files);
  if (!inspection.ok) throw new Error(inspection.issues.join("\n"));
  for (const [file, bytes] of Object.entries(files))
    output(`templates/minimal-consumer/${type}/${file}`, bytes);
}
output(
  "architecture/minimal-consumer-migration.json",
  await format(
    JSON.stringify({
      schema: "buildchain.consumer-migration/v1",
      stage: "contract-defined; execution-entry-not-yet-published",
      workflows: workflowInventory(),
      consumerSources: consumerSourceInventory(),
    }),
    { parser: "json" },
  ),
);
console.log(
  "Minimal consumer contract: three shared-caller examples and complete migration inventory verified.",
);
