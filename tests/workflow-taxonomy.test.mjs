import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkWorkflowTaxonomy,
  readWorkflowTaxonomy,
  renderWorkflowCatalog,
  TAXONOMY_DOC,
  TAXONOMY_PATH,
  workflowPath,
  writeWorkflowSource,
} from "../packages/core/workflow/workflow-taxonomy.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-taxonomy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = readWorkflowTaxonomy(repository);
  const files = [
    TAXONOMY_PATH,
    TAXONOMY_DOC,
    "package.json",
    ".buildchain/buildchain.toml",
    ".github/CODEOWNERS",
    "actions/build/verify-check/action.yml",
    ...policy.entries.map(workflowPath),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(repository, file), path.join(root, file));
  }
  return root;
}
function editPolicy(root, change) {
  const policy = readWorkflowTaxonomy(root);
  change(policy);
  fs.writeFileSync(path.join(root, TAXONOMY_PATH), JSON.stringify(policy));
  return policy;
}
function rejected(root, pattern) {
  const result = checkWorkflowTaxonomy(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), pattern);
}

test("the repository has exactly one canonical file per declared workflow", () => {
  const result = checkWorkflowTaxonomy(repository);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.fileCount, result.canonicalCount);
});

for (const token of ["v4", "v5", "v12"]) {
  test(`registered version token cannot bypass naming gate: ${token}`, (t) => {
    const root = fixture(t);
    editPolicy(root, (policy) => {
      const entry = policy.entries.find((item) => item.role === "public");
      const old = workflowPath(entry);
      entry.purpose = `candidate-${token}`;
      fs.renameSync(path.join(root, old), path.join(root, workflowPath(entry)));
    });
    rejected(root, /filenames cannot contain version tokens/);
  });
}

for (const field of ["compatibility", "migration", "retiredAlias"]) {
  test(`historical workflow translation is rejected: ${field}`, (t) => {
    const root = fixture(t);
    editPolicy(root, (policy) => {
      policy.entries[0][field] = { path: ".github/workflows/old.yml" };
    });
    rejected(root, /not an executable architecture contract/u);
  });
}

test("unregistered alias cannot be written or called", (t) => {
  const root = fixture(t);
  const alias = ".github/workflows/old-build.yml";
  assert.throws(
    () => writeWorkflowSource(root, alias, "stale"),
    /canonical|registered/u,
  );
  assert.equal(fs.existsSync(path.join(root, alias)), false);
  fs.appendFileSync(
    path.join(root, ".github/workflows/self-build-adopter-dogfood.yml"),
    `  stale:\n    uses: kungfu-systems/buildchain/${alias}@v4-alpha\n`,
  );
  rejected(root, /undeclared Buildchain workflow/u);
});

test("canonical public entry cannot bind consumer admission to its retired alias", (t) => {
  const root = fixture(t);
  const entry = readWorkflowTaxonomy(root).entries.find(
    (item) => item.id === "v4-adopter-delivery",
  );
  const file = path.join(root, workflowPath(entry));
  fs.appendFileSync(file, "\nenv:\n  BUILDCHAIN_INVOKED_WORKFLOW: .github/workflows/v4-adopter-delivery.yml\n");
  rejected(root, /consumer admission must bind the canonical invoked workflow/);
});

for (const filename of [
  "random.yml",
  "public-ops-anything.yml",
  "nested/public-build-hidden.yaml",
  "public-build-UPPER.YAML",
]) {
  test(`unregistered or nested workflow fails: ${filename}`, (t) => {
    const root = fixture(t);
    const file = path.join(root, ".github/workflows", filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "on:\n  workflow_call:\njobs: {}\n");
    rejected(root, /unregistered workflow/);
  });
}

test("missing file, duplicate identity and duplicate derived path fail independently", (t) => {
  const root = fixture(t);
  const policy = readWorkflowTaxonomy(root);
  fs.unlinkSync(path.join(root, workflowPath(policy.entries[0])));
  rejected(root, /registered workflow missing/);
  editPolicy(root, (value) =>
    value.entries.push(structuredClone(value.entries[0])),
  );
  rejected(root, /duplicate/);
});

for (const [field, value] of [
  ["role", "ci"],
  ["category", "recovery"],
  ["purpose", "../escape"],
  ["rationale", ""],
  ["owner", ""],
]) {
  test(`invalid or incomplete registration fails: ${field}`, (t) => {
    const root = fixture(t);
    editPolicy(root, (policy) => {
      policy.entries[0][field] = value;
    });
    rejected(root, /invalid|missing|disagree/);
  });
}

test("changing a category without moving its files cannot pass", (t) => {
  const root = fixture(t);
  editPolicy(root, (policy) => {
    policy.entries[0].category = "ops";
  });
  rejected(root, /unregistered workflow|registered workflow missing/);
});

test("public entry cannot be relabelled self while retaining workflow_call", (t) => {
  const root = fixture(t);
  editPolicy(root, (policy) => {
    policy.entries.find((entry) => entry.role === "public").role = "self";
  });
  rejected(root, /role and invocation|repository event wrappers/);
});

test("a second YAML copy cannot silently become another executable surface", (t) => {
  const root = fixture(t);
  const entry = readWorkflowTaxonomy(root).entries.find(
    (item) => item.role === "public",
  );
  fs.copyFileSync(
    path.join(root, workflowPath(entry)),
    path.join(root, ".github/workflows/old-build.yml"),
  );
  rejected(root, /unregistered workflow/u);
});

test("dangling local calls fail; shell strings do not become workflow calls", (t) => {
  const root = fixture(t);
  const entry = readWorkflowTaxonomy(root).entries.find(
    (item) => item.id === "check",
  );
  const file = workflowPath(entry);
  const text =
    "on:\n  workflow_call:\njobs:\n  call:\n    uses: ./.github/workflows/missing.yml\n";
  writeWorkflowSource(root, file, text);
  rejected(root, /dangling workflow reference/);
  writeWorkflowSource(
    root,
    file,
    "on:\n  workflow_call:\njobs:\n  run:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          uses: ./.github/workflows/not-a-call.yml\n",
  );
  const result = checkWorkflowTaxonomy(root);
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("adding a repository event to a public entry fails before it can double-trigger", (t) => {
  const root = fixture(t);
  const entry = readWorkflowTaxonomy(root).entries.find(
    (item) => item.id === "check",
  );
  const file = workflowPath(entry);
  writeWorkflowSource(
    root,
    file,
    fs
      .readFileSync(path.join(root, file), "utf8")
      .replace("on:\n", "on:\n  push:\n"),
  );
  rejected(root, /repository event triggers/);
});

test("gate cannot be removed or changed to best-effort in the required check chain", (t) => {
  const root = fixture(t);
  const file = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.scripts["check:workflows"] =
    "node scripts/check-workflow-taxonomy.mjs || true";
  fs.writeFileSync(file, JSON.stringify(pkg));
  rejected(root, /without a bypass/);
  pkg.scripts["check:workflows"] =
    "node scripts/check-workflow-taxonomy.mjs && bash scripts/check-workflows.sh";
  pkg.scripts.check = "echo passed";
  fs.writeFileSync(file, JSON.stringify(pkg));
  rejected(root, /required check chain/);
});

test("required queue trigger and independent ownership cannot disappear", (t) => {
  const root = fixture(t);
  const file = path.join(root, ".github/workflows/self-build-verify.yml");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(/  merge_group:\n    types:\n      - checks_requested\n/u, ""),
  );
  rejected(root, /lacks merge_group/);
  fs.writeFileSync(path.join(root, ".github/CODEOWNERS"), "* @someone-else\n");
  rejected(root, /independent review ownership missing/);
});

test("catalog drift fails and regeneration is deterministic", (t) => {
  const root = fixture(t);
  editPolicy(root, (policy) => {
    policy.entries[0].summary += " clarified";
  });
  rejected(root, /catalog is stale/);
  const first = renderWorkflowCatalog(readWorkflowTaxonomy(root));
  assert.equal(first, renderWorkflowCatalog(readWorkflowTaxonomy(root)));
  fs.writeFileSync(path.join(root, TAXONOMY_DOC), first);
  assert.equal(checkWorkflowTaxonomy(root).ok, true);
});

test("declared lifecycle cannot replace the full check with a passing echo", (t) => {
  const root = fixture(t);
  const file = path.join(root, ".buildchain/buildchain.toml");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace("corepack pnpm@11.7.0 run check", "echo passed"),
  );
  rejected(root, /declared verify lifecycle/);
});

test("repository dispatch and handoff parameters cannot retain removed filenames", (t) => {
  const root = fixture(t);
  const file = path.join(root, ".github/workflows/self-ops-dev-delivery.yml");
  fs.appendFileSync(file, "  invalid-handoff:\n    uses: ./.github/workflows/public-ops-dev-auto-merge.yml\n    with:\n      source-workflow-id: verify.yml\n");
  rejected(root, /dangling repository workflow reference verify.yml/);
});

test("early workflow source checks can load taxonomy before dependencies are installed", (t) => {
  const root = fixture(t);
  for (const relative of [
    "packages/core/workflow/workflow-taxonomy.mjs",
    "packages/core/contracts/workflow-yaml-contract.js",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repository, relative), target);
  }
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { checkWorkflowTaxonomy } from "./packages/core/workflow/workflow-taxonomy.mjs"; const result = checkWorkflowTaxonomy(process.cwd(), { integration: false }); if (!result.ok) throw Error(result.errors.join("\\n"));',
    ],
    { cwd: root },
  );
});

test("workflow hotspot routes retain the same logical identities as debt metrics", () => {
  const policy = readWorkflowTaxonomy(repository);
  const identities = new Set(policy.entries.map(workflowPath));
  const debt = JSON.parse(
    fs.readFileSync(
      path.join(repository, "architecture/maintainability-debt.json"),
      "utf8",
    ),
  );
  for (const file of debt.hotspots.filter((value) =>
    value.startsWith(".github/workflows/"),
  )) {
    assert.ok(
      identities.has(file),
      `hotspot must use the measured logical workflow identity: ${file}`,
    );
  }
});
