import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";

// Runner's action manifest schema, distinct from workflow expression contexts:
// https://github.com/actions/runner/blob/main/src/Runner.Worker/action_yaml.json
const contexts = [
  "github",
  "inputs",
  "strategy",
  "matrix",
  "steps",
  "job",
  "runner",
  "env",
];
const hashFiles = { name: "hashFiles", minArgs: 1, maxArgs: 255 };
const statusFunctions = ["always", "failure", "cancelled", "success"].map(
  (name) => ({ name, minArgs: 0, maxArgs: 0 }),
);
const read = (file) => YAML.parse(fs.readFileSync(file, "utf8"));
const parse = (expression, names, functions = []) =>
  new Parser(new Lexer(expression).lex().tokens, names, functions).parse();
function sources(value) {
  const text = String(value),
    result = [];
  let cursor = 0;
  while ((cursor = text.indexOf("${{", cursor)) !== -1) {
    const start = cursor + 3;
    let quoted = false,
      closed = false;
    for (cursor = start; cursor < text.length; cursor++) {
      if (text[cursor] === "'") quoted = !quoted;
      else if (!quoted && text.slice(cursor, cursor + 2) === "}}") {
        result.push(text.slice(start, cursor).trim());
        cursor += 2;
        closed = true;
        break;
      }
    }
    assert.ok(closed, "Unclosed workflow expression");
  }
  return result;
}
function evaluate(value, context) {
  const [source] = sources(value);
  assert.ok(source, value);
  return new Evaluator(
    parse(source, Object.keys(context)),
    JSON.parse(JSON.stringify(context), data.reviver),
  )
    .evaluate()
    .coerceString();
}

test("all composite expressions load under the runner action context contract", () => {
  const failures = [];
  const check = (value, label, names = contexts, functions = [hashFiles]) => {
    for (const expression of sources(value)) {
      try {
        parse(expression, names, functions);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
    }
  };
  for (const file of fs.globSync("actions/**/action.yml")) {
    const action = read(file);
    if (action.runs.using !== "composite") continue;
    for (const [name, input] of Object.entries(action.inputs || {}))
      check(input.default || "", `${file} input ${name}`, [
        "github",
        "strategy",
        "matrix",
        "job",
        "runner",
      ]);
    for (const [name, output] of Object.entries(action.outputs || {}))
      check(output.value, `${file} output ${name}`, contexts, []);
    for (const [index, step] of action.runs.steps.entries()) {
      for (const [name, value] of Object.entries(step)) {
        if (name === "if") {
          const condition =
            typeof value === "string" && !value.includes("${{")
              ? `\${{ ${value} }}`
              : value;
          check(condition, `${file} step ${index} if`, contexts, [
            hashFiles,
            ...statusFunctions,
          ]);
        } else if (["with", "env"].includes(name)) {
          for (const [key, expression] of Object.entries(value))
            check(expression, `${file} step ${index} ${name}.${key}`);
        } else check(value, `${file} step ${index} ${name}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

const bindings = [
  [
    ".release-authority",
    "publication/authority/admit",
    "auditor-app-id",
    "KUNGFU_GOVERNANCE_AUDITOR_APP_ID",
  ],
  [
    "public-release-signing-authority",
    "release/signing/detached",
    "key-id",
    "BUILDCHAIN_DETACHED_KEY_ID",
  ],
  [
    "public-release-signing-authority",
    "release/signing/macos",
    "certificate-sha1",
    "BUILDCHAIN_MACOS_CERTIFICATE_SHA1",
  ],
  [
    "public-release-signing-authority",
    "release/signing/macos",
    "team-id",
    "BUILDCHAIN_MACOS_EXPECTED_TEAM_ID",
  ],
  [
    "public-release-signing-authority",
    "release/signing/windows",
    "certificate-sha1",
    "BUILDCHAIN_WINDOWS_CERTIFICATE_SHA1",
  ],
  [
    "public-release-signing-authority",
    "release/signing/windows",
    "timestamp-url",
    "BUILDCHAIN_WINDOWS_TIMESTAMP_URL",
  ],
  [
    ".build-gate-profile",
    "build/gate/execute",
    "cache-mirror-url-template",
    "BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE",
  ],
  [
    ".build-gate-profile",
    "build/gate/execute",
    "cache-reference-repository-template",
    "BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE",
  ],
];
test("workflow variables cross only their declared action input boundaries", () => {
  for (const [workflow, action, input, variable] of bindings) {
    const caller = Object.values(read(`.github/workflows/${workflow}.yml`).jobs)
      .flatMap((job) => job.steps || [])
      .find((step) => step.uses?.endsWith(`/actions/${action}`));
    const definition = read(`actions/${action}/action.yml`);
    assert.ok(definition.inputs[input], `${action}: ${input}`);
    assert.equal(
      evaluate(caller.with[input], { vars: { [variable]: "scoped-value" } }),
      "scoped-value",
    );
    assert.equal(evaluate(caller.with[input], { vars: {} }), "");
    assert.ok(
      JSON.stringify(definition.runs.steps).includes(`inputs.${input}`),
      `${action}: unused ${input}`,
    );
  }
});

test("checkout request overrides keep precedence over workflow cache defaults", () => {
  const action = read("actions/build/gate/execute/action.yml");
  for (const step of action.runs.steps.filter((value) =>
    value.uses.endsWith("/providers/source/checkout"),
  )) {
    for (const [field, request, fallback] of [
      [
        "mirror-url-template",
        "checkout-cache-mirror-url-template",
        "cache-mirror-url-template",
      ],
      [
        "reference-repository-template",
        "checkout-cache-reference-repository-template",
        "cache-reference-repository-template",
      ],
    ]) {
      const inputs = { "request-json": "{}", [fallback]: "workflow-default" };
      assert.equal(evaluate(step.with[field], { inputs }), "workflow-default");
      inputs["request-json"] = JSON.stringify({
        [request]: "explicit-request",
      });
      assert.equal(evaluate(step.with[field], { inputs }), "explicit-request");
      inputs["request-json"] = "{}";
      inputs[fallback] = "";
      assert.equal(evaluate(step.with[field], { inputs }), "");
    }
  }
});

test("auditor token minting requires live mode and both explicit credential inputs", () => {
  const step = read(
    "actions/publication/authority/admit/action.yml",
  ).runs.steps.find((value) => value.id === "governance-auditor");
  for (const dryRun of [true, false])
    for (const appId of ["", "app-id"])
      for (const key of ["", "fixture-private-key"]) {
        const inputs = {
          "request-json": JSON.stringify({ "dry-run": dryRun }),
          "auditor-app-id": appId,
          "auditor-private-key": key,
        };
        assert.equal(
          evaluate(step.if, { inputs }),
          String(!dryRun && Boolean(appId) && Boolean(key)),
        );
      }
});

test("status projections preserve runner job cancellation and composite action success semantics", () => {
  // The runner uses job.status for cancelled(), and github.action_status for
  // success()/failure() in composite MAIN steps (Runner.Worker/Expressions).
  const actions = [
    "web/staging/deploy",
    "web/production/deploy",
    "web/preview/deploy",
    "web/preview/cleanup",
    "release/propagation/deliver",
    "paper/publication/settle",
  ];
  for (const action of actions) {
    const field = action.startsWith("web/")
      ? "job-status"
      : action.startsWith("paper/")
        ? "aggregate-outcome"
        : "cancelled";
    const step = read(`actions/${action}/action.yml`).runs.steps.find(
      (value) => value.with?.[field],
    );
    for (const jobStatus of ["success", "failure", "cancelled"])
      for (const actionStatus of ["", "success", "failure", "cancelled"]) {
        const expected =
          field === "cancelled"
            ? String(jobStatus === "cancelled")
            : jobStatus === "cancelled"
              ? "cancelled"
              : field === "aggregate-outcome"
                ? !actionStatus || actionStatus === "success"
                  ? "success"
                  : "failure"
                : actionStatus === "failure"
                  ? "failure"
                  : "success";
        assert.equal(
          evaluate(step.with[field], {
            job: { status: jobStatus },
            github: { action_status: actionStatus },
          }),
          expected,
          `${action}: ${jobStatus}/${actionStatus}`,
        );
      }
  }
});
