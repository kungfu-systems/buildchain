import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  inspectWorkflowJob,
  readWorkflow,
} from "../scripts/workflow-action-graph.mjs";
const root = path.resolve(import.meta.dirname, "..");

// Product commands are arbitrary code. The three execution jobs must therefore
// remain observations, without publishing credentials or authority outputs.
function assertPipelineProductBoundaries(root) {
  for (const [file, action, context, source] of [
    [
      ".ops-pipeline-execute.yml",
      "workflow/pipeline/build",
      "inputs.context",
      "source",
    ],
    [
      ".release-pipeline-products.yml",
      "publication/pipeline/build",
      "needs.materialize.outputs.context",
      "materialization.source",
    ],
    [
      ".release-pipeline-version.yml",
      "publication/version/build",
      "inputs.context",
      "preparation.source",
    ],
  ]) {
    const relative = `.github/workflows/${file}`;
    const workflow = readWorkflow(relative, root);
    const job = workflow.jobs.build;
    const label = `${relative}#build`;
    assert.deepEqual(
      job.permissions,
      { contents: "read" },
      `${label}: read-only permissions`,
    );
    for (const key of ["env", "defaults"])
      assert.equal(workflow[key], undefined, `${label}: no inherited ${key}`);
    for (const key of [
      "env",
      "defaults",
      "secrets",
      "environment",
      "container",
      "services",
      "outputs",
      "uses",
      "with",
    ])
      assert.equal(job[key], undefined, `${label}: no ${key}`);
    assert.deepEqual(
      job.steps,
      [
        {
          uses: "$/actions/runtime/environment/prepare",
          with: {
            selection: "${{ inputs.runtime-selection }}",
            token: "${{ github.token }}",
          },
        },
        {
          uses: "actions/checkout@v7.0.0",
          with: {
            repository: `\${{ fromJSON(${context}).${source}.repository }}`,
            ref: `\${{ fromJSON(${context}).${source}.commit }}`,
            path: ".buildchain/product",
            "persist-credentials": false,
          },
        },
        {
          uses: `./.buildchain/runtime/actions/${action}`,
          with: {
            context: `\${{ ${context} }}`,
            platform: "${{ matrix.platform }}",
          },
        },
      ],
      `${label}: isolated product execution steps`,
    );
    const graph = inspectWorkflowJob(relative, "build", root);
    const adapter = graph.actions.get(`actions/${action}`);
    assert.deepEqual(
      Object.keys(adapter.inputs).sort(),
      ["context", "platform"],
      label,
    );
    assert.equal(adapter.outputs, undefined, `${label}: no authority outputs`);
    assert.deepEqual(
      adapter.runs,
      { using: "node24", main: "dist/index.js" },
      label,
    );
    assert.ok(
      graph.modules.has("packages/core/workflow/pipeline/build.js"),
      label,
    );
    for (const step of graph.steps) {
      assert.equal(step.env, undefined, `${label}: no step credentials`);
      if (step.uses?.startsWith("actions/checkout@"))
        assert.equal(
          step.with?.["persist-credentials"],
          false,
          `${label}: no saved checkout credential`,
        );
    }
  }
}

test("all three product jobs reject publishing authority and hidden execution wiring", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "product-boundaries-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, ".github/workflows"), { recursive: true });
  for (const name of ["actions", "packages"])
    fs.symlinkSync(
      path.join(root, name),
      path.join(directory, name),
      "junction",
    );
  const files = [
    ".ops-pipeline-execute.yml",
    ".release-pipeline-products.yml",
    ".release-pipeline-version.yml",
  ];
  const write = (file, document) =>
    fs.writeFileSync(
      path.join(directory, ".github/workflows", file),
      YAML.stringify(document),
    );
  const documents = files.map((file) =>
    YAML.parse(
      fs.readFileSync(path.join(root, ".github/workflows", file), "utf8"),
    ),
  );
  files.forEach((file, index) => write(file, documents[index]));
  assert.doesNotThrow(() => assertPipelineProductBoundaries(directory));
  const mutations = [
    (w) => {
      w.jobs.build.permissions.contents = "write";
    },
    (w) => {
      w.jobs.build.permissions["id-token"] = "write";
    },
    (w) => {
      w.env = { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" };
    },
    (w) => {
      w.jobs.build.env = { GH_TOKEN: "${{ github.token }}" };
    },
    (w) => {
      w.jobs.build.secrets = "inherit";
    },
    (w) => {
      w.jobs.build.environment = "publisher";
    },
    (w) => {
      w.jobs.build.outputs = {
        qualified: "${{ steps.product.outputs.qualified }}",
      };
    },
    (w) => {
      w.jobs.build.steps[1].with["persist-credentials"] = true;
    },
    (w) => {
      w.jobs.build.steps[1].with.path = ".buildchain/runtime";
    },
    (w) => {
      w.jobs.build.steps[2].with.token = "${{ github.token }}";
    },
    (w) => {
      w.jobs.build.steps[2].uses =
        "./.buildchain/runtime/actions/publication/pipeline/apply";
    },
    (w) => {
      w.jobs.build.steps.push({ run: "node consumer-controller.mjs" });
    },
  ];
  files.forEach((file, index) => {
    for (const mutate of mutations) {
      const changed = structuredClone(documents[index]);
      mutate(changed);
      write(file, changed);
      assert.throws(
        () => assertPipelineProductBoundaries(directory),
        /#build:/u,
      );
      write(file, documents[index]);
    }
  });
});
