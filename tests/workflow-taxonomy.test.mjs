import assert from "node:assert/strict";
import {
  CONSUMER_UPGRADE_PATH,
  readConsumerUpgrade,
  renderCompatibilityWorkflow,
} from "../packages/core/consumer/compatibility-workflows.js";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { validateConsumerWiring } from "../packages/core/consumer/contract/local-validation.js";
import { inspectConsumerContract } from "../packages/core/consumer/contract/inspection.js";
import { standardConsumerExample } from "../packages/core/consumer/contract/examples.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkWorkflowTaxonomy,
  discoverWorkflowFiles,
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
    CONSUMER_UPGRADE_PATH,
    "package.json",
    ".buildchain/buildchain.toml",
    ".github/CODEOWNERS",
    "actions/build/verification/repository/action.yml",
    "actions/build/verification/qualify-source/action.yml",
    "packages/core/build/verification/source.js",
    "packages/core/build/source/lifecycle.js",
    ...policy.entries.map(workflowPath),
    ...readConsumerUpgrade(repository).entries.map((entry) => entry.path),
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
function consumerFiles(root) {
  return {
    ...standardConsumerExample("npm"),
    ...Object.fromEntries(
      [
        TAXONOMY_PATH,
        CONSUMER_UPGRADE_PATH,
        ...discoverWorkflowFiles(root),
      ].map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
    ),
  };
}

test("the repository has exactly one canonical file per declared workflow", () => {
  const result = checkWorkflowTaxonomy(repository);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(
    result.fileCount,
    result.canonicalCount + result.compatibilityCount,
  );
});

test("consumer upgrade contracts cannot disappear while their policy is registered", (t) => {
  const root = fixture(t);
  fs.unlinkSync(path.join(root, CONSUMER_UPGRADE_PATH));
  rejected(root, /upgrade contract is missing/u);
});

test("compatibility paths must use a registered canonical implementation", (t) => {
  const root = fixture(t);
  const contract = readConsumerUpgrade(root);
  contract.entries[0].target = ".github/workflows/unregistered.yml";
  fs.writeFileSync(
    path.join(root, CONSUMER_UPGRADE_PATH),
    JSON.stringify(contract),
  );
  rejected(root, /Invalid consumer upgrade entry/u);
});

test("compatibility workflow cannot independently change execution or permissions", (t) => {
  const root = fixture(t);
  const entry = readConsumerUpgrade(root).entries.find((entry) =>
    entry.path.endsWith("build.yml"),
  );
  const file = path.join(root, entry.path);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, "utf8").replace("contents: read", "contents: write"),
  );
  rejected(root, /compatibility workflow drift/u);
});

test("consumer validation admits registered implementation libraries without a repository identity exception", (t) => {
  const root = fixture(t);
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
  const result = validateConsumerWiring(root, ".buildchain/buildchain.toml");
  assert.ok(["v4", "v4-alpha"].includes(result.channel));
  const inspection = inspectConsumerContract(consumerFiles(root), {
    channel: result.channel,
  });
  assert.equal(inspection.ok, true, inspection.issues.join("\n"));
  assert.deepEqual(
    result.workflows.sort(),
    Object.keys(consumerWorkflows()).sort(),
  );
  fs.appendFileSync(
    path.join(root, ".github/workflows/buildchain.yml"),
    "env:\n  HIDDEN: true\n",
  );
  assert.throws(
    () => validateConsumerWiring(root, ".buildchain/buildchain.toml"),
    /workflow bytes differ/,
  );
});

for (const kind of ["unregistered", "component-event", "extra-root"])
  test(`implementation inventory cannot conceal ${kind} consumer wiring`, (t) => {
    const root = fixture(t);
    if (kind === "unregistered") {
      fs.writeFileSync(
        path.join(root, ".github/workflows/.hidden.yml"),
        "on: workflow_call\njobs: {}\n",
      );
    } else if (kind === "component-event") {
      const component = readWorkflowTaxonomy(root).entries.find(
        (entry) => entry.role === "component",
      );
      fs.writeFileSync(
        path.join(root, workflowPath(component)),
        "on:\n  workflow_call: {}\n  push: {}\njobs: {}\n",
      );
    } else {
      editPolicy(root, (policy) => {
        const entry = {
          ...policy.entries.find((item) => item.id === "buildchain"),
          id: "shadow",
          purpose: "shadow",
        };
        delete entry.path;
        policy.entries.push(entry);
        fs.writeFileSync(
          path.join(root, workflowPath(entry)),
          "on: push\njobs: {}\n",
        );
      });
    }
    assert.throws(
      () => validateConsumerWiring(root, ".buildchain/buildchain.toml"),
      /unregistered workflow|repository event triggers|repository event roots/,
    );
    assert.match(
      inspectConsumerContract(consumerFiles(root)).issues.join("\n"),
      /unregistered workflow|repository event triggers|repository event roots/,
    );
  });

test("public consumer contracts contain only normal pipeline and exact-attempt recovery", () => {
  const entries = readWorkflowTaxonomy(repository).entries;
  assert.deepEqual(
    entries
      .filter((entry) => entry.role === "public")
      .map(workflowPath)
      .sort(),
    [
      ".github/workflows/public-ops-pipeline.yml",
      ".github/workflows/public-ops-recover.yml",
    ],
  );
  assert.equal(
    entries.find((entry) => entry.id === "artifact-signing-authority").role,
    "component",
  );
});

test("registering a product-specific public entry fails even with a valid file and catalog", (t) => {
  const root = fixture(t);
  const policy = editPolicy(root, (value) => {
    const entry = value.entries.find((item) => item.id === "paper-release");
    const old = workflowPath(entry);
    entry.role = "public";
    fs.renameSync(path.join(root, old), path.join(root, workflowPath(entry)));
  });
  fs.writeFileSync(
    path.join(root, TAXONOMY_DOC),
    renderWorkflowCatalog(policy),
  );
  rejected(
    root,
    /consumer public entries must be exactly pipeline and recover/,
  );
});

test("removing recovery cannot leave a seemingly valid one-entry consumer contract", (t) => {
  const root = fixture(t);
  editPolicy(root, (policy) => {
    policy.entries = policy.entries.filter((entry) => entry.id !== "recover");
  });
  rejected(
    root,
    /consumer public entries must be exactly pipeline and recover/,
  );
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
    path.join(root, ".github/workflows/buildchain.yml"),
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
  fs.appendFileSync(
    file,
    "\nenv:\n  BUILDCHAIN_INVOKED_WORKFLOW: .github/workflows/v4-adopter-delivery.yml\n",
  );
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
  for (const alias of readConsumerUpgrade(root).entries.filter(
    (item) => item.target === file,
  ))
    fs.writeFileSync(
      path.join(root, alias.path),
      renderCompatibilityWorkflow(
        alias,
        fs.readFileSync(path.join(root, file), "utf8"),
      ),
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
  const file = path.join(root, ".github/workflows/buildchain.yml");
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, "utf8")
      .replace(/  merge_group:\n    types: \[checks_requested\]\n/u, ""),
  );
  rejected(root, /generated pipeline caller drift/);
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
  rejected(root, /declared product verification/);
});

test("repository dispatch and handoff parameters cannot retain removed filenames", (t) => {
  const root = fixture(t);
  const file = path.join(root, ".github/workflows/buildchain.yml");
  fs.appendFileSync(
    file,
    "  invalid-handoff:\n    uses: ./.github/workflows/.ops-dev-auto-merge.yml\n    with:\n      source-workflow-id: verify.yml\n",
  );
  rejected(root, /dangling repository workflow reference verify.yml/);
});

test("early workflow source checks can load taxonomy before dependencies are installed", (t) => {
  const root = fixture(t);
  for (const relative of [
    "packages/core/workflow/workflow-taxonomy.mjs",
    "packages/core/consumer/compatibility-workflows.js",
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

test("installed normal and recovery entries preserve the generated public contract", () => {
  const { channel } = validateConsumerWiring(repository);
  for (const [file, expected] of Object.entries(consumerWorkflows(channel))) {
    assert.equal(
      fs.readFileSync(path.join(repository, file), "utf8"),
      expected,
    );
  }
});
