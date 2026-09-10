import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  parseWorkflowDocument,
  parseYamlUses,
} from "../contracts/workflow-yaml-contract.js";

export const TAXONOMY_PATH = "architecture/workflow-taxonomy.json";
export const TAXONOMY_DOC = "docs/workflow-catalog.md";
const ROLES = ["public", "component", "self"];
const CATEGORIES = ["build", "release", "ops"];
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WORKFLOW = /^\.github\/workflows\/[.a-z0-9-]+\.ya?ml$/u;
const VERSION_TOKEN = /(?:^|[.-])v\d+(?:[.-]|$)/iu;
const PROTECTED = [
  TAXONOMY_PATH,
  "packages/core/workflow/workflow-taxonomy.mjs",
  "scripts/check-workflow-taxonomy.mjs",
  "scripts/generate-workflow-taxonomy.mjs",
  "scripts/check-workflows.sh",
  "tests/workflow-taxonomy.test.mjs",
  ".github/workflows/self-build-verify.yml",
  "package.json",
  ".buildchain/buildchain.toml",
];

export function workflowPath(entry) {
  if (entry.path) return entry.path;
  const prefix = entry.role === "component" ? "." : `${entry.role}-`;
  return `.github/workflows/${prefix}${entry.category}-${entry.purpose}.yml`;
}

export function readWorkflowTaxonomy(root) {
  const file = path.join(root, TAXONOMY_PATH);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function validateEntries(policy, errors) {
  if (policy?.schema !== "buildchain.workflow-taxonomy/v1")
    errors.push("taxonomy schema is missing or unknown");
  if (JSON.stringify(policy?.roles) !== JSON.stringify(ROLES))
    errors.push("role vocabulary must be public/component/self");
  if (JSON.stringify(policy?.categories) !== JSON.stringify(CATEGORIES))
    errors.push("category vocabulary must be build/release/ops");
  if (policy?.migrationSources || policy?.migrationBaseRevision)
    errors.push("taxonomy cannot own historical path translation");
  if (!Array.isArray(policy?.entries) || !policy.entries.length) {
    errors.push("taxonomy entries are missing");
    return [];
  }
  const ids = new Set(),
    paths = new Set();
  for (const entry of policy.entries) {
    if (!entry.id || ids.has(entry.id))
      errors.push(`duplicate or missing identity: ${entry.id}`);
    ids.add(entry.id);
    if (!ROLES.includes(entry.role)) errors.push(`${entry.id}: invalid role`);
    if (!CATEGORIES.includes(entry.category))
      errors.push(`${entry.id}: invalid category`);
    if (!SLUG.test(entry.purpose || ""))
      errors.push(`${entry.id}: invalid purpose slug`);
    if (
      entry.path &&
      !(
        (entry.id === ".build" || entry.id === "build") &&
        entry.path === `.github/workflows/${entry.id}.yml`
      )
    )
      errors.push(
        `${entry.id}: explicit path is reserved for the build facade and backbone`,
      );
    const file = workflowPath(entry);
    if (!WORKFLOW.test(file) || paths.has(file))
      errors.push(`${entry.id}: invalid or duplicate path ${file}`);
    paths.add(file);
    if (VERSION_TOKEN.test(path.posix.basename(file)))
      errors.push(
        `${entry.id}: workflow filenames cannot contain version tokens`,
      );
    validateEntryOwnership(entry, errors);
  }
  return policy.entries;
}

export function discoverWorkflowFiles(root) {
  const directory = path.join(root, ".github/workflows");
  if (!fs.existsSync(directory)) return [];
  const visit = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const file = path.join(dir, item.name);
      return item.isDirectory()
        ? visit(file)
        : /\.ya?ml$/iu.test(item.name)
          ? [path.relative(root, file).split(path.sep).join("/")]
          : [];
    });
  return visit(directory).sort();
}

function validateWorkflow(root, entry, declared, errors) {
  const file = workflowPath(entry),
    absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) return;
  const text = fs.readFileSync(absolute, "utf8"),
    document = parseWorkflowDocument(text);
  if (
    (entry.invocation === "reusable") !==
    document.triggers.includes("workflow_call")
  )
    errors.push(`${file}: workflow_call does not match registered invocation`);
  if (
    entry.invocation === "dispatch-service" &&
    !document.triggers.includes("workflow_dispatch")
  )
    errors.push(`${file}: dispatch service lacks workflow_dispatch`);
  if (
    entry.role !== "self" &&
    document.triggers.some(
      (trigger) => !["workflow_call", "workflow_dispatch"].includes(trigger),
    )
  )
    errors.push(
      `${file}: public/component entry has repository event triggers`,
    );
  if (
    text.includes("BUILDCHAIN_INVOKED_WORKFLOW:") &&
    !text.includes(`BUILDCHAIN_INVOKED_WORKFLOW: ${file}\n`)
  )
    errors.push(
      `${file}: consumer admission must bind the canonical invoked workflow`,
    );
  for (const call of parseYamlUses(text)) {
    const local = call.value.match(
      /^(?:\.\/|\$\/)(\.github\/workflows\/[^@]+)$/u,
    );
    if (local && !declared.has(local[1]))
      errors.push(
        `${file}:${call.line}: dangling workflow reference ${local[1]}`,
      );
    const remote = call.value.match(
      /^kungfu-systems\/buildchain\/(\.github\/workflows\/[^@]+)@/u,
    );
    if (remote && !declared.has(remote[1]))
      errors.push(
        `${file}:${call.line}: undeclared Buildchain workflow ${remote[1]}`,
      );
  }
  if (entry.role === "self") {
    const references = document.callJobs.flatMap((job) =>
      Object.entries(job.with)
        .filter(
          ([key, value]) =>
            /(?:source|handoff)-workflow-id$|(?:expected|candidate)-workflow-file$/u.test(
              key,
            ) && value.kind === "string",
        )
        .map(([, value]) => value.value),
    );
    for (const match of text.matchAll(
      /\bgh workflow run ([.a-z0-9-]+\.ya?ml)\b/gu,
    ))
      references.push(match[1]);
    for (const name of references) {
      const target = name.startsWith(".github/")
        ? name
        : `.github/workflows/${name}`;
      if (!declared.has(target))
        errors.push(`${file}: dangling repository workflow reference ${name}`);
    }
  }
}

function validateGateIntegration(root, errors) {
  const read = (file) =>
    fs.existsSync(path.join(root, file))
      ? fs.readFileSync(path.join(root, file), "utf8")
      : "";
  const pkg = JSON.parse(read("package.json") || "{}");
  const command = pkg.scripts?.["check:workflows"];
  if (
    command !==
    "node scripts/check-workflow-taxonomy.mjs && bash scripts/check-workflows.sh"
  )
    errors.push(
      "check:workflows must execute taxonomy before actionlint without a bypass",
    );
  if (
    !/(?:^|&&)\s*pnpm run check:workflows\s*(?:&&|$)/u.test(
      pkg.scripts?.check || "",
    )
  )
    errors.push("required check chain does not enforce check:workflows");
  const { parse: parseToml } = createRequire(import.meta.url)("smol-toml");
  const config = parseToml(read(".buildchain/buildchain.toml"));
  if (
    !config.lifecycle?.verify?.commands?.includes(
      "corepack pnpm@11.7.0 run check",
    )
  )
    errors.push(
      "declared verify lifecycle must execute the full required check",
    );
  const verify = read(".github/workflows/self-build-verify.yml");
  const document = parseWorkflowDocument(verify);
  for (const trigger of ["pull_request", "merge_group", "push"]) {
    if (!document.triggers.some((item) => item.split(":")[0] === trigger))
      errors.push(`required Verify workflow lacks ${trigger}`);
  }
  const checkJob = verify.match(/^  check:\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/mu)?.[1] || "";
  const verifyNode = "./.buildchain/workflow-shell/actions/build/verification/repository";
  const verifyAction = read("actions/build/verification/repository/action.yml");
  const sourceAction = read("actions/build/verification/qualify-source/action.yml");
  const sourceVerification = read("packages/core/build/verification/source.js");
  const sourceLifecycle = read("packages/core/build/source/lifecycle.js");
  if (!parseYamlUses(checkJob).some(call => call.value === verifyNode) ||
      !parseYamlUses(verifyAction).some(call => call.value === "./actions/build/verification/qualify-source") ||
      !/using: node24/u.test(sourceAction) ||
      !/qualify = qualifySourceLifecycle/u.test(sourceVerification) ||
      !/mode: "verify"/u.test(sourceVerification) ||
      !/lifecycle\(\{[\s\S]*stageName,[\s\S]*required: true/u.test(sourceLifecycle))
    errors.push("required Verify lifecycle integration is missing");
  const owners = read(".github/CODEOWNERS")
    .split(/\r?\n/u)
    .map((line) => line.trim());
  for (const file of PROTECTED) {
    if (!owners.includes(`/${file} @kungfu-origin`))
      errors.push(`independent review ownership missing for ${file}`);
  }
  if (
    !owners.includes("/.github/workflows/* @kungfu-origin") ||
    !owners.includes("/.github/CODEOWNERS @kungfu-origin")
  )
    errors.push(
      "workflow and CODEOWNERS review ownership must remain explicit",
    );
}

export function checkWorkflowTaxonomy(
  root,
  { integration = true, documentation = true } = {},
) {
  const errors = [],
    policy = readWorkflowTaxonomy(root),
    entries = validateEntries(policy, errors);
  if (errors.length) return { ok: false, errors };
  const declared = new Set(entries.map(workflowPath)),
    observed = new Set(discoverWorkflowFiles(root));
  for (const file of observed) {
    if (!declared.has(file)) errors.push(`unregistered workflow: ${file}`);
    if (!fs.lstatSync(path.join(root, file)).isFile())
      errors.push(`workflow must be a regular file: ${file}`);
  }
  for (const file of declared)
    if (!observed.has(file))
      errors.push(`registered workflow missing: ${file}`);
  for (const entry of entries) validateWorkflow(root, entry, declared, errors);
  if (integration) validateGateIntegration(root, errors);
  if (documentation) {
    const file = path.join(root, TAXONOMY_DOC);
    if (
      !fs.existsSync(file) ||
      fs.readFileSync(file, "utf8") !== renderWorkflowCatalog(policy)
    )
      errors.push("generated workflow catalog is stale");
  }
  return {
    ok: !errors.length,
    canonicalCount: entries.length,
    fileCount: observed.size,
    errors,
  };
}

export function writeWorkflowSource(root, relative, text) {
  const policy = readWorkflowTaxonomy(root);
  if (!policy?.entries.some((entry) => workflowPath(entry) === relative))
    throw new Error(`Unregistered workflow source: ${relative}`);
  fs.writeFileSync(path.join(root, relative), text);
}

export function renderWorkflowCatalog(policy) {
  const lines = [
    "---",
    "status: active",
    "period: ongoing",
    "theme: workflow-taxonomy",
    "doc_type: technical-reference",
    "source_level: local-files",
    "confidence: high",
    "sensitivity: public",
    "evidence_grade: B",
    "review_state: unreviewed",
    "last_reviewed: 2026-09-09",
    "ai_provenance:",
    "  model_family: GPT-6",
    "  product: Codex",
    "  generated_at: 2026-09-09",
    "  visible_context: Canonical Buildchain workflow ownership and source files",
    "  invisible_context_boundary: No private credentials or unpublished consumer state inspected",
    "---",
    "",
    "# Workflow catalog",
    "",
    "Generated from `architecture/workflow-taxonomy.json`. Every workflow has one canonical implementation; alternate paths and historical forwarding aliases are rejected.",
    "",
    "Public workflows own the consumer API. Component workflows own reusable multi-job topology. Self workflows own Buildchain repository automation. Actions own execution steps; JS adapters and Rust/WASM own implementation.",
    "",
    "Names use `public-<category>-<purpose>.yml`, `.<category>-<purpose>.yml`, and `self-<category>-<purpose>.yml`, with categories `build`, `release`, and `ops`. The primary build API and backbone use `build.yml` and `.build.yml`.",
    "",
    "Register ownership before adding a workflow. `pnpm run check:workflows` validates source, calls, required CI integration and independent review ownership. `pnpm run generate:workflows` regenerates this catalog.",
    "",
  ];
  for (const role of ROLES) {
    lines.push(
      `## ${role}`,
      "",
      "| Workflow | Category | Invocation | Status | Purpose |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of policy.entries
      .filter((e) => e.role === role)
      .sort((a, b) => workflowPath(a).localeCompare(workflowPath(b))))
      lines.push(
        `| [${path.posix.basename(workflowPath(entry))}](../${workflowPath(entry)}) | ${entry.category} | ${entry.invocation} | ${entry.status} | ${entry.summary.replaceAll("|", "\\|")} |`,
      );
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function validateEntryOwnership(entry, errors) {
    for (const field of ["summary", "owner", "rationale"])
      if (typeof entry[field] !== "string" || !entry[field].trim())
        errors.push(`${entry.id}: missing ${field}`);
    if (!["active", "preview"].includes(entry.status))
      errors.push(`${entry.id}: unsupported lifecycle status`);
    for (const field of ["compatibility", "migration", "retiredAlias"])
      if (field in entry)
        errors.push(
          `${entry.id}: ${field} is not an executable architecture contract`,
        );
    if (
      !["reusable", "dispatch-service", "repository"].includes(entry.invocation)
    )
      errors.push(`${entry.id}: invalid invocation`);
    if ((entry.role === "self") !== (entry.invocation === "repository"))
      errors.push(`${entry.id}: role and invocation disagree`);
    if (entry.role === "component" && entry.invocation !== "reusable")
      errors.push(`${entry.id}: component must be reusable`);
}
