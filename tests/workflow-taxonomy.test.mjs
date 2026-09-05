import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkWorkflowTaxonomy,
  projectWorkflowIdentities,
  readWorkflowTaxonomy,
  renderWorkflowCatalog,
  TAXONOMY_DOC,
  TAXONOMY_PATH,
  workflowPath,
  writeWorkflowSource,
} from "../scripts/workflow-taxonomy.mjs";

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
    ...policy.entries.flatMap((entry) => [
      workflowPath(entry),
      ...(entry.compatibility ? [entry.compatibility.path] : []),
    ]),
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

test("the migrated repository has an exhaustive classified inventory and equal aliases", () => {
  const result = checkWorkflowTaxonomy(repository);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(
    result.fileCount,
    result.canonicalCount + result.compatibilityCount,
  );
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

test("compatibility cannot invent a wildcard or unreviewed baseline source", (t) => {
  const root = fixture(t);
  editPolicy(root, (policy) => {
    policy.entries[0].compatibility.path = ".github/workflows/*.yml";
  });
  rejected(root, /exact migrated path/);
  editPolicy(root, (policy) => {
    const entry = policy.entries[0];
    entry.compatibility.path = ".github/workflows/unapproved.yml";
    entry.migration.previousPath = entry.compatibility.path;
  });
  rejected(root, /reviewed baseline/);
});

test("editing only a compatibility copy fails even if its YAML remains valid", (t) => {
  const root = fixture(t);
  const entry = readWorkflowTaxonomy(root).entries.find(
    (item) => item.compatibility,
  );
  fs.appendFileSync(
    path.join(root, entry.compatibility.path),
    "\n# independent implementation drift\n",
  );
  rejected(root, /compatibility implementation drift/);
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
      .replace("  merge_group:\n    types: [checks_requested]\n", ""),
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

test("lane projection conserves every logical job and refuses divergent aliases", (t) => {
  const root = fixture(t);
  const policy = readWorkflowTaxonomy(root);
  const physical = policy.entries
    .flatMap((entry) => [
      workflowPath(entry),
      ...(entry.compatibility ? [entry.compatibility.path] : []),
    ])
    .map((file) => ({
      path: file,
      text: fs.readFileSync(path.join(root, file), "utf8"),
    }));
  const projected = projectWorkflowIdentities(root, physical);
  assert.equal(projected.length, policy.entries.length);
  for (const entry of policy.entries) {
    assert.equal(
      projected.find((item) => item.path === entry.migration.previousPath).text,
      physical.find((item) => item.path === workflowPath(entry)).text,
    );
  }
  const alias = policy.entries.find((entry) => entry.compatibility)
    .compatibility.path;
  fs.appendFileSync(path.join(root, alias), "# divergence\n");
  assert.throws(
    () => projectWorkflowIdentities(root, physical),
    /compatibility implementation drift/,
  );
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
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(
        "source-workflow-id: self-build-verify.yml",
        "source-workflow-id: verify.yml",
      ),
  );
  rejected(root, /dangling repository workflow reference verify.yml/);
});
