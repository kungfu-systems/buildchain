import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exactObject, exactRuntime, fail, contentRoot } from "./identity.js";
function rawFileRoot(runtimeRoot, relative) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(path.join(runtimeRoot, relative)));
  return `sha256:${hash.digest("hex")}`;
}

export function executeBootstrapConformance(
  request,
  admission,
  { runtimeRoot },
) {
  exactObject(
    request.payload,
    ["schema", "expectedGovernedWorkflowCount"],
    "bootstrap conformance payload",
  );
  if (
    request.payload.schema !==
    "kungfu-buildchain-v4-universal-bootstrap-conformance/v1"
  )
    fail("bootstrap conformance payload schema is unsupported");
  if (
    !Number.isSafeInteger(request.payload.expectedGovernedWorkflowCount) ||
    request.payload.expectedGovernedWorkflowCount < 1
  )
    fail("bootstrap conformance workflow count is invalid");
  const architecture = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "architecture/universal-workflow-bootstrap.json"),
    ),
  );
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeRoot,
        "architecture/universal-workflow-train-admission.json",
      ),
    ),
  );
  if (
    architecture.bootstrapGovernedWorkflows.length !==
      request.payload.expectedGovernedWorkflowCount ||
    architecture.status !== "active" ||
    policy.allowedCapabilities.includes("workflow-contract")
  )
    fail("candidate Bootstrap conformance does not close execution semantics");
  for (const relative of architecture.bootstrapGovernedWorkflows) {
    const source = fs.readFileSync(path.join(runtimeRoot, relative), "utf8");
    if (
      relative !== architecture.bootstrap.publicWorkflow &&
      !/(?:\.\/)?\.github\/workflows\/public-ops-bootstrap\.yml/u.test(source)
    )
      fail(`candidate Bootstrap facade is not governed: ${relative}`);
  }
  return {
    schema: "kungfu-buildchain-v4-universal-bootstrap-conformance-result/v1",
    status: "candidate-engine-executed",
    runtime: exactRuntime(admission),
    governedWorkflowCount: architecture.bootstrapGovernedWorkflows.length,
    architectureRoot: rawFileRoot(
      runtimeRoot,
      "architecture/universal-workflow-bootstrap.json",
    ),
    engineRoot: engineImplementationRoot(runtimeRoot),
  };
}

export function engineImplementationRoot(runtimeRoot) {
  const files = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(runtimeRoot, relative), {
      withFileTypes: true,
    })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        files.push({ path: name, root: rawFileRoot(runtimeRoot, name) });
      else
        throw new Error(
          `Engine implementation contains an unsupported filesystem entry: ${name}`,
        );
    }
  }
  visit("packages/core");
  return contentRoot(
    "universal-workflow-engine-implementation",
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}
