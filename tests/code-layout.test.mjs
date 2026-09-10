import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCodeLayout,
  inspectModuleDependencies,
  inspectWorkflowNodes,
  inspectPublicActionNodes,
  inspectRequestJsonFields,
  inspectCompositeSteps,
} from "../scripts/check-code-layout.mjs";
import { inspectWorkflowJob } from "../scripts/workflow-action-graph.mjs";
import { actionInventory } from "../packages/core/contracts/action-inventory.js";

function fixture(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(entries)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

test("module dependency gate rejects static, dynamic and re-export upward edges", (t) => {
  const root = fixture(t, {
    "packages/core/build/entry.js":
      'import "../../../scripts/tool.mjs";\nexport {x} from "../../../actions/build/node/index.js";\nawait import("./missing.js");\n',
    "scripts/tool.mjs": "",
    "actions/build/node/index.js": "export const x = 1;",
  });
  const { edges, issues } = inspectModuleDependencies(root, [
    "packages/core/build/entry.js",
  ]);
  assert.equal(edges.length, 3);
  assert.equal(issues.length, 3);
  assert.match(issues.join("\n"), /runtime dependency escapes.*scripts\/tool/u);
  assert.match(
    issues.join("\n"),
    /runtime dependency escapes.*actions\/build/u,
  );
  assert.match(issues.join("\n"), /missing module.*missing\.js/u);
});

test("module gate parses syntax rather than matching strings or comments", (t) => {
  const root = fixture(t, {
    "packages/core/build/entry.js":
      '// import "../../../scripts/tool.mjs";\nconst example = \'import "./missing.js"\';\nexport {x} from "../contracts/value.js";',
    "packages/core/contracts/value.js": "export const x = 1;",
  });
  const result = inspectModuleDependencies(root, [
    "packages/core/build/entry.js",
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.length, 1);
});

test("workflow budgets count implementation separately from API metadata", () => {
  const budgets = { workflowStepsPerJob: 2, workflowInlineScriptLines: 0 };
  const source =
    "on:\n  workflow_call:\n    inputs:\n      request:\n        type: string\n        description: |\n          many lines of API documentation\njobs:\n  qualify:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v7\n      - uses: ./actions/build/source/qualify\n";
  assert.deepEqual(inspectWorkflowNodes(source, "workflow", budgets), []);
  assert.match(
    inspectWorkflowNodes(
      source.replace(
        "uses: ./actions/build/source/qualify",
        'run: node -e "execute()"',
      ),
      "workflow",
      budgets,
    ).join("\n"),
    /contains executable implementation/u,
  );
  assert.match(
    inspectWorkflowNodes(
      source + "      - uses: ./actions/build/source/extra\n",
      "workflow",
      budgets,
    ).join("\n"),
    /3 steps exceed 2/u,
  );
});

test("bundle discovery includes post cleanup and runtime wasm under nested action owners", (t) => {
  const root = fixture(t, {
    "actions/build/credential/island/action.yml":
      "runs:\n  using: node24\n  main: dist/index.js\n  post: dist/cleanup.js\n",
    "actions/build/credential/island/dist/index.js":
      "export const main = true;",
    "actions/build/credential/island/dist/cleanup.js":
      'new URL("./buildchain-domain.wasm", import.meta.url);',
  });
  assert.deepEqual(actionInventory(root)[0].bundles, [
    "actions/build/credential/island/dist/index.js",
    "actions/build/credential/island/dist/cleanup.js",
    "actions/build/credential/island/dist/buildchain-domain.wasm",
  ]);
});

test("CLI boundary rejects undeclared binaries and implementation growth in the entrypoint", (t) => {
  const policy = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/code-layout.json", import.meta.url),
      "utf8",
    ),
  );
  policy.publicActionNodes = [];
  const root = fixture(t, {
    "architecture/code-layout.json": JSON.stringify(policy),
    "architecture/action-taxonomy.json": JSON.stringify({
      schema: "buildchain.action-taxonomy/v1",
      domains: {},
    }),
    "bin/buildchain.mjs": 'import "../packages/core/runtime/entry.mjs";\n',
    "packages/core/runtime/entry.mjs": "export const entry = true;\n",
    ".github/workflows/entry.yml": "jobs: {}\n",
  });
  fs.mkdirSync(path.join(root, "actions"));
  assert.deepEqual(checkCodeLayout(root).issues, []);
  fs.writeFileSync(
    path.join(root, "bin/hidden.mjs"),
    "export const implementation = true;\n",
  );
  assert.match(
    checkCodeLayout(root).issues.join("\n"),
    /undeclared CLI entrypoint/u,
  );
  fs.writeFileSync(
    path.join(root, "bin/buildchain.mjs"),
    Array.from(
      { length: 30 },
      (_, index) => `export function command${index}() {}`,
    ).join("\n"),
  );
  assert.match(
    checkCodeLayout(root).issues.join("\n"),
    /exceed thin CLI entry budget/u,
  );
});

test("composite code cannot hide in empty run, shell, working-directory or github-script", () => {
  const inspect = (step) =>
    inspectCompositeSteps({ runs: { steps: [step] } }, "fixture");
  assert.deepEqual(
    inspect({
      uses: "./actions/build/source/admit",
      with: { "expected-sha": "a".repeat(40) },
    }),
    [],
  );
  for (const step of [
    { run: "" },
    {
      uses: "actions/github-script@v8",
      with: { script: "await import('./business.mjs')" },
    },
    { uses: "./actions/build/source/admit", shell: "bash" },
    { uses: "./actions/build/source/admit", "working-directory": "." },
  ])
    assert.ok(inspect(step).length > 0);
});

test("action inventory rejects the old flat group/operation layout", (t) => {
  const root = fixture(t, {
    "actions/build/ungrouped/action.yml":
      "runs:\n  using: composite\n  steps: []\n",
  });
  assert.throws(
    () => actionInventory(root),
    /requires a responsibility group and operation/,
  );
});

test("matrix input rewriting cannot corrupt an output property name", () => {
  assert.deepEqual(
    inspectCompositeSteps(
      {
        outputs: {
          matrix: { value: "${{ steps.plan.outputs.gate-matrix-json }}" },
        },
      },
      "fixture",
    ),
    [],
  );
  assert.match(
    inspectCompositeSteps(
      {
        outputs: {
          matrix: {
            value:
              "${{ steps.plan.outputs.gate-fromJSON(inputs.matrix-json)-json }}",
          },
        },
      },
      "fixture",
    ).join("\n"),
    /invalid expression call/,
  );
});

test("public Action registry rejects duplicate and missing executable nodes", () => {
  const actions = [{ directory: "actions/build/lifecycle/validate" }];
  assert.deepEqual(
    inspectPublicActionNodes(actions, ["build/lifecycle/validate"]),
    [],
  );
  assert.match(
    inspectPublicActionNodes(actions, [
      "build/lifecycle/validate",
      "build/lifecycle/validate",
    ]).join("\n"),
    /duplicate public Action/,
  );
  assert.match(
    inspectPublicActionNodes(actions, ["build/missing"]).join("\n"),
    /unknown public Action/,
  );
  assert.match(
    inspectPublicActionNodes(actions, undefined).join("\n"),
    /must be an array/,
  );
});

test("JSON request fields remain closed through nested composite delegation", (t) => {
  const action = (steps) =>
    JSON.stringify({
      inputs: { "request-json": {} },
      runs: { using: "composite", steps },
    });
  const root = fixture(t, {
    "workflow.yml": JSON.stringify({
      on: { workflow_call: { inputs: { runtime: { type: "string" } } } },
      jobs: {
        run: {
          steps: [
            {
              uses: "./actions/build/fixture/outer",
              with: { "request-json": "${{ toJSON(inputs) }}" },
            },
          ],
        },
      },
    }),
    "actions/build/fixture/outer/action.yml": action([
      {
        uses: "./actions/build/fixture/inner",
        with: { "request-json": "${{ inputs.request-json }}" },
      },
    ]),
    "actions/build/fixture/inner/action.yml": action([
      {
        uses: "actions/setup-node@v6",
        with: {
          "node-version": "${{ fromJSON(inputs.request-json).runtime }}",
        },
      },
    ]),
  });
  const inspect = () =>
    inspectRequestJsonFields(inspectWorkflowJob("workflow.yml", "run", root));
  assert.deepEqual(inspect(), []);
  fs.writeFileSync(
    path.join(root, "actions/build/fixture/inner/action.yml"),
    action([
      {
        uses: "actions/setup-node@v6",
        with: {
          "node-version":
            "${{ fromJSON(inputs.request-json).retired-runtime }}",
        },
      },
    ]),
  );
  assert.deepEqual(inspect(), [
    "actions/build/fixture/inner: undeclared request field retired-runtime",
  ]);
});

test("composite boundary gate rejects stale job status and lost failed-checkout diagnostics", async (t) => {
  const { inspectCompositeAdmission } =
    await import("../scripts/check-code-layout.mjs");
  const action = "actions/build/fixture/execute/action.yml";
  const root = fixture(t, {
    [action]: `runs:\n  using: composite\n  steps:\n    - id: source-boundary\n      if: \${{ always() }}\n      uses: ./.buildchain/workflow-shell/actions/build/source/admit\n      with:\n        source-checkout-outcome: \${{ inputs.source-checkout-outcome }}\n`,
  });
  const steps = [
    { id: "source", uses: "actions/checkout@v7" },
    {
      uses: "actions/checkout@v7",
      with: { path: ".buildchain/workflow-shell" },
      if: "${{ always() }}",
    },
    {
      id: "node",
      uses: "./.buildchain/workflow-shell/actions/build/fixture/execute",
      if: "${{ always() }}",
      with: { "source-checkout-outcome": "${{ steps.source.outcome }}" },
    },
  ];
  const workflow = { jobs: { build: { steps } } };
  assert.deepEqual(inspectCompositeAdmission(root, workflow), []);
  steps[2].with.status = "${{ job.status }}";
  assert.match(
    inspectCompositeAdmission(root, workflow).join("\n"),
    /freeze live/,
  );
  delete steps[2].with.status;
  delete steps[1].if;
  assert.match(
    inspectCompositeAdmission(root, workflow).join("\n"),
    /cannot reach node diagnostics/,
  );
  steps[1].if = "${{ always() }}";
  fs.writeFileSync(
    path.join(root, action),
    "runs:\n  using: composite\n  steps:\n    - run: execute-business\n",
  );
  assert.match(
    inspectCompositeAdmission(root, workflow).join("\n"),
    /can execute node business/,
  );
});

test("workflow API declarations reject null and sequence ports before provider parsing", () => {
  const budgets = { workflowStepsPerJob: 2, workflowInlineScriptLines: 0 };
  for (const field of ["inputs", "outputs", "secrets"]) {
    for (const value of ["", " []", " invalid"]) {
      const source = `on:\n  workflow_call:\n    ${field}:${value}\njobs: {}\n`;
      assert.match(
        inspectWorkflowNodes(source, "fixture", budgets).join("\n"),
        /must be a mapping/,
      );
    }
  }
  for (const source of [
    "on: workflow_call\njobs: {}\n",
    "on:\n  workflow_call:\n    inputs: {}\njobs: {}\n",
  ])
    assert.deepEqual(inspectWorkflowNodes(source, "fixture", budgets), []);
});
