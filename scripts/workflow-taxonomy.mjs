import fs from "node:fs";
import { parse as parseToml } from "smol-toml";
import path from "node:path";
import {
  parseWorkflowDocument,
  parseYamlUses,
} from "../packages/core/workflow-yaml-contract.js";

export const TAXONOMY_PATH = "architecture/workflow-taxonomy.json";
export const TAXONOMY_DOC = "docs/workflow-catalog.md";
const ROLES = ["public", "component", "self"];
const CATEGORIES = ["build", "release", "ops"];
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WORKFLOW = /^\.github\/workflows\/[.a-z0-9-]+\.ya?ml$/u;
const PROTECTED = [
  TAXONOMY_PATH,
  "scripts/workflow-taxonomy.mjs",
  "scripts/check-workflow-taxonomy.mjs",
  "scripts/generate-workflow-taxonomy.mjs",
  "scripts/check-workflows.sh",
  "tests/workflow-taxonomy.test.mjs",
  ".github/workflows/self-build-verify.yml",
  "package.json",
  ".buildchain/buildchain.toml",
];

export function workflowPath(entry) {
  const prefix = entry.role === "component" ? "." : `${entry.role}-`;
  return `.github/workflows/${prefix}${entry.category}-${entry.purpose}.yml`;
}

export function readWorkflowTaxonomy(root) {
  const file = path.join(root, TAXONOMY_PATH);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function validateEntryRole(entry, errors) {
  if (!ROLES.includes(entry.role)) errors.push(`${entry.id}: invalid role`);
  if (!CATEGORIES.includes(entry.category))
    errors.push(`${entry.id}: invalid category`);
  if (!SLUG.test(entry.purpose || ""))
    errors.push(`${entry.id}: invalid purpose slug`);
  for (const field of ["summary", "owner", "rationale"]) {
    if (typeof entry[field] !== "string" || !entry[field].trim())
      errors.push(`${entry.id}: missing ${field}`);
  }
  if (!["active", "preview", "compatibility", "retired"].includes(entry.status))
    errors.push(`${entry.id}: invalid lifecycle status`);
  if (
    !["reusable", "dispatch-service", "repository"].includes(entry.invocation)
  )
    errors.push(`${entry.id}: invalid invocation`);
  if ((entry.role === "self") !== (entry.invocation === "repository"))
    errors.push(`${entry.id}: role and invocation disagree`);
  if (entry.role === "component" && entry.invocation !== "reusable")
    errors.push(`${entry.id}: component must be reusable`);
}

function validateMigration(policy, entry, declared, errors) {
  if (entry.migration) {
    if (
      !WORKFLOW.test(entry.migration.previousPath || "") ||
      !/^[a-f0-9]{64}$/u.test(entry.migration.originalSha256 || "")
    )
      errors.push(`${entry.id}: invalid exact migration identity`);
    if (
      policy.migrationSources?.[entry.migration.previousPath] !==
      entry.migration.originalSha256
    )
      errors.push(
        `${entry.id}: migration source is not in the reviewed baseline`,
      );
  }
  if (entry.compatibility) {
    const alias = entry.compatibility;
    if (entry.role === "self")
      errors.push(
        `${entry.id}: repository event wrappers cannot have duplicate aliases`,
      );
    if (
      !WORKFLOW.test(alias.path || "") ||
      alias.path !== entry.migration?.previousPath
    )
      errors.push(
        `${entry.id}: compatibility must name one exact migrated path`,
      );
    if (!alias.reason?.trim() || !alias.removalCondition?.trim())
      errors.push(
        `${entry.id}: compatibility requires a reason and removal condition`,
      );
    declared.push(alias.path);
  }
}

function validateEntries(policy, errors) {
  if (policy?.schema !== "buildchain.workflow-taxonomy/v1")
    errors.push("taxonomy schema is missing or unknown");
  if (JSON.stringify(policy?.roles) !== JSON.stringify(ROLES))
    errors.push("role vocabulary must be public/component/self");
  if (JSON.stringify(policy?.categories) !== JSON.stringify(CATEGORIES))
    errors.push("category vocabulary must be build/release/ops");
  if (!/^[a-f0-9]{40}$/u.test(policy?.migrationBaseRevision || ""))
    errors.push("migration baseline must be an exact commit");
  if (!Array.isArray(policy?.entries) || !policy.entries.length) {
    errors.push("taxonomy entries are missing");
    return [];
  }
  const ids = new Set();
  const paths = new Set();
  for (const entry of policy.entries) {
    if (!entry.id || ids.has(entry.id))
      errors.push(`duplicate or missing identity: ${entry.id}`);
    ids.add(entry.id);
    validateEntryRole(entry, errors);
    const canonical = workflowPath(entry);
    const declared = [canonical];
    validateMigration(policy, entry, declared, errors);
    for (const file of declared) {
      if (!WORKFLOW.test(file) || paths.has(file))
        errors.push(`${entry.id}: invalid or duplicate path ${file}`);
      paths.add(file);
    }
  }
  return policy.entries;
}

export function discoverWorkflowFiles(root) {
  const directory = path.join(root, ".github/workflows");
  if (!fs.existsSync(directory)) return [];
  const visit = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) return visit(file);
      return /\.ya?ml$/iu.test(item.name)
        ? [path.relative(root, file).split(path.sep).join("/")]
        : [];
    });
  return visit(directory).sort();
}

function validateRepositoryReferences(file, document, text, declared, errors) {
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

function validateWorkflow(root, entry, declared, errors) {
  const file = workflowPath(entry);
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) return;
  const text = fs.readFileSync(absolute, "utf8");
  const document = parseWorkflowDocument(text);
  if (entry.role === "self")
    validateRepositoryReferences(file, document, text, declared, errors);
  const reusable = document.triggers.includes("workflow_call");
  if ((entry.invocation === "reusable") !== reusable)
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
  if (entry.compatibility) {
    const alias = path.join(root, entry.compatibility.path);
    if (fs.existsSync(alias) && fs.readFileSync(alias, "utf8") !== text)
      errors.push(
        `${file}: compatibility implementation drift at ${entry.compatibility.path}`,
      );
  }
  for (const call of parseYamlUses(text)) {
    const local = call.value.match(/^\.\/(\.github\/workflows\/[^@]+)$/u);
    if (local && !declared.has(local[1]))
      errors.push(
        `${file}:${call.line}: dangling workflow reference ${local[1]}`,
      );
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
  if (
    !verify.includes("Run declared verify lifecycle") ||
    !verify.includes("--required")
  )
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
  const errors = [];
  const policy = readWorkflowTaxonomy(root);
  const entries = validateEntries(policy, errors);
  if (errors.length) return { ok: false, errors };
  const declared = new Set(
    entries.flatMap((entry) => [
      workflowPath(entry),
      ...(entry.compatibility ? [entry.compatibility.path] : []),
    ]),
  );
  const observed = new Set(discoverWorkflowFiles(root));
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
    ok: errors.length === 0,
    canonicalCount: entries.length,
    compatibilityCount: entries.filter((entry) => entry.compatibility).length,
    fileCount: observed.size,
    errors,
  };
}

// Existing lane/debt baselines name immutable pre-migration identities. Count
// one logical implementation only after proving every physical alias identical.
export function projectWorkflowIdentities(root, workflows) {
  const policy = readWorkflowTaxonomy(root);
  if (!policy) return workflows;
  const result = checkWorkflowTaxonomy(root, {
    integration: false,
    documentation: false,
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  const byPath = new Map(
    workflows.map((workflow) => [workflow.path, workflow]),
  );
  return policy.entries
    .map((entry) => {
      const workflow = byPath.get(workflowPath(entry));
      if (!workflow)
        throw new Error(`missing canonical workflow: ${workflowPath(entry)}`);
      return {
        ...workflow,
        path: entry.migration?.previousPath || workflow.path,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function writeWorkflowSource(root, relative, text) {
  const policy = readWorkflowTaxonomy(root);
  const entry = policy?.entries.find(
    (item) =>
      workflowPath(item) === relative || item.compatibility?.path === relative,
  );
  const outputs = entry
    ? [
        workflowPath(entry),
        ...(entry.compatibility ? [entry.compatibility.path] : []),
      ]
    : [relative];
  for (const file of outputs) fs.writeFileSync(path.join(root, file), text);
}

export function rewriteRepositoryWorkflowPaths(root, text) {
  for (const entry of readWorkflowTaxonomy(root)?.entries || []) {
    if (entry.role === "self" && entry.migration)
      text = text.replaceAll(entry.migration.previousPath, workflowPath(entry));
    if (entry.id === "build-surface-fixture")
      text = text.replaceAll(
        "build-surface-fixture.yml",
        path.posix.basename(workflowPath(entry)),
      );
  }
  return text;
}

export function workflowCompatibilityIdentity(root, relative, text) {
  const entry = readWorkflowTaxonomy(root)?.entries.find(
    (item) => workflowPath(item) === relative && item.compatibility,
  );
  if (!entry) return relative;
  const source = text ?? fs.readFileSync(path.join(root, relative), "utf8");
  if (
    source !==
    fs.readFileSync(path.join(root, entry.compatibility.path), "utf8")
  )
    throw new Error(`${relative}: compatibility implementation drift`);
  return entry.compatibility.path;
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
    "last_reviewed: 2026-09-05",
    "ai_provenance:",
    "  model_family: GPT-6",
    "  product: Codex",
    "  generated_at: 2026-09-05",
    "  visible_context: Repository workflow source and the approved naming scheme",
    "  invisible_context_boundary: No credentials or unpublished provider configuration inspected",
    "---",
    "",
    "# Workflow catalog",
    "",
    "Generated from `architecture/workflow-taxonomy.json`; edit that source, then run",
    "`pnpm run generate:workflows`. Every YAML file, including compatibility paths,",
    "is checked by the existing required workflow check.",
    "",
    "## Naming and ownership",
    "",
    "`public-<build|release|ops>-<purpose>.yml` is a consumer entry;",
    "`.<build|release|ops>-<purpose>.yml` is an advanced component;",
    "`self-<build|release|ops>-<purpose>.yml` is Buildchain's own automation.",
    "Public is a product role, not GitHub access control. Dispatch services are",
    "marked separately from reusable workflows. Keep workflow names, job IDs,",
    "permissions, and trigger semantics stable during path migration.",
    "",
    "## Channel rollout",
    "",
    "Canonical names become callable on a channel only after that channel publishes",
    "them. Existing `@v4`/`@v4-alpha` consumers keep their exact registered legacy",
    "paths until provider readback proves canonical availability. New examples below",
    "describe the target surface, not a claim that both channels already publish it.",
    "Compatibility files are generated byte-identical projections, not independently",
    "editable implementations. They retain full jobs to preserve called-workflow",
    "identity, permission envelopes, and required check names without extra nesting.",
    "",
    "The controller registry records the actual source path separately from a migrated",
    "repository controller contractPath. This preserves the established logical",
    "contract identity while exposing its current execution source. New workflows",
    "do not acquire historical identities. Public controllers retain their real",
    "compatibility paths while those paths remain supported.",
    "",
    "## Adding or changing a workflow",
    "",
    "Register a stable identity, role, category, purpose, owner, lifecycle status,",
    "invocation and concrete summary before creating its derived path. A new entry",
    "must explain its scope in review. New aliases cannot be invented: compatibility",
    "must name an exact migration source with a reason and removal condition.",
    "The policy, generator, checker, tests, required CI chain and CODEOWNERS require",
    "independent `kungfu-origin` review. No wildcard compatibility admission is allowed.",
    "",
    "A role, category or implementation edit must preserve or deliberately update",
    "all related declarations. Run `pnpm run generate:workflows` and",
    "`pnpm run check:workflows`; the full `pnpm run check` remains required.",
    "",
  ];
  for (const role of ROLES) {
    lines.push(
      `## ${role}`,
      "",
      "| Canonical workflow | Category | Invocation | Status | Purpose | Compatibility path |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of policy.entries
      .filter((item) => item.role === role)
      .sort((a, b) => workflowPath(a).localeCompare(workflowPath(b)))) {
      const name = path.posix.basename(workflowPath(entry));
      lines.push(
        `| [${name}](../${workflowPath(entry)}) | ${entry.category} | ${entry.invocation} | ${entry.status} | ${entry.summary.replaceAll("|", "\\|")} | ${entry.compatibility ? `\`${path.posix.basename(entry.compatibility.path)}\`` : "—"} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
