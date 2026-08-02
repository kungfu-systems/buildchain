import crypto from "node:crypto";
import { parseWorkflowDocument } from "./workflow-yaml-contract.js";

export const WORKFLOW_CALL_CONTRACT =
  "kungfu-buildchain-workflow-call-contract/v1";
export const WORKFLOW_CALL_RECEIPT =
  "kungfu-buildchain-workflow-call-receipt/v1";

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function exactSha(value) {
  return /^[0-9a-f]{40}$/.test(String(value || "").toLowerCase());
}

function coordinate(uses) {
  const match = String(uses || "").match(
    /^([^/]+\/[^/]+)\/(\.github\/workflows\/[^@]+)@([^@]+)$/,
  );
  return match ? { repository: match[1], path: match[2], ref: match[3] } : null;
}

function permissionLevel(value) {
  if (value === "write" || value === "write-all") return 2;
  if (value === "read" || value === "read-all") return 1;
  if (value === "none" || value === "{}") return 0;
  return -1;
}

function callerPermission(permissions, name) {
  return permissions[name] || permissions["*"] || "none";
}

function validatePermissions(caller, callee) {
  const failures = [];
  for (const [name, required] of Object.entries(callee)) {
    if (name === "*") continue;
    const available = callerPermission(caller, name);
    if (
      permissionLevel(required) < 0 ||
      permissionLevel(available) < permissionLevel(required)
    ) {
      failures.push({
        code: "permission-drift",
        message: `caller permission ${name}=${available} does not satisfy callee ${required}`,
      });
    }
  }
  return failures;
}

function validateInputs(job, reusable) {
  const failures = [];
  const declared = new Map(reusable.inputs.map((entry) => [entry.name, entry]));
  for (const [name, supplied] of Object.entries(job.with)) {
    const input = declared.get(name);
    if (!input) {
      failures.push({
        code: "undeclared-input",
        message: `caller supplies undeclared input: ${name}`,
      });
      continue;
    }
    if (supplied.kind !== "expression" && supplied.kind !== input.type) {
      failures.push({
        code: "input-type-drift",
        message: `caller input ${name} is ${supplied.kind}, callee requires ${input.type}`,
      });
    }
  }
  for (const input of reusable.inputs.filter((entry) => entry.required)) {
    if (!(input.name in job.with)) {
      failures.push({
        code: "missing-required-input",
        message: `caller omits required input: ${input.name}`,
      });
    }
  }
  return failures;
}

function validateSecrets(job, reusable) {
  if (job.secrets === "inherit") {
    return [
      {
        code: "secret-inheritance-not-exact",
        message:
          "secrets: inherit cannot prove an exact reusable-workflow secret contract",
      },
    ];
  }
  const failures = [];
  const declared = new Map(
    reusable.secrets.map((entry) => [entry.name, entry]),
  );
  for (const name of Object.keys(job.secrets)) {
    if (!declared.has(name)) {
      failures.push({
        code: "undeclared-secret",
        message: `caller supplies undeclared secret: ${name}`,
      });
    }
  }
  for (const secret of reusable.secrets.filter((entry) => entry.required)) {
    if (!(secret.name in job.secrets)) {
      failures.push({
        code: "missing-required-secret",
        message: `caller omits required secret: ${secret.name}`,
      });
    }
  }
  return failures;
}

function validateEvents(actual, trusted) {
  const trustedSet = new Set(trusted);
  return actual
    .filter((event) => !trustedSet.has(event))
    .map((event) => ({
      code: "untrusted-event-drift",
      message: `caller admits untrusted event class: ${event}`,
    }));
}

function interfaceProjection(reusable) {
  return {
    inputs: reusable.inputs,
    secrets: reusable.secrets,
    outputs: reusable.outputs,
    permissions: reusable.permissions,
  };
}

function validateCoordinate(job, { repository, workflowPath, sha }) {
  const failures = [];
  const pinned = coordinate(job?.uses);
  if (!pinned) {
    return [
      {
        code: "callee-coordinate-invalid",
        message:
          "caller uses must name owner/repo/.github/workflows/file.yml@ref",
      },
    ];
  }
  if (!exactSha(pinned.ref)) {
    failures.push({
      code: "floating-callee-ref",
      message: `callee ref is not an exact commit SHA: ${pinned.ref}`,
    });
  }
  if (pinned.repository !== repository || pinned.path !== workflowPath) {
    failures.push({
      code: "callee-coordinate-drift",
      message: `caller uses ${pinned.repository}/${pinned.path}, expected ${repository}/${workflowPath}`,
    });
  }
  if (pinned.ref.toLowerCase() !== String(sha || "").toLowerCase()) {
    failures.push({
      code: "stale-pinned-ref",
      message: `caller pin ${pinned.ref} does not match checked callee ${sha}`,
    });
  }
  return failures;
}

export function evaluateWorkflowCallContract({
  callerText,
  calleeText,
  callerRepository,
  callerWorkflowPath,
  callerSha,
  callerTree,
  callerSourceState = "clean",
  calleeRepository,
  calleeWorkflowPath,
  calleeSha,
  jobId,
  trustedEventClasses = [],
  expectedContractRoot = "",
} = {}) {
  const caller = parseWorkflowDocument(callerText);
  const callee = parseWorkflowDocument(calleeText);
  const job = caller.callJobs.find((entry) => entry.id === jobId);
  const failures = [];
  if (!job)
    failures.push({
      code: "call-job-missing",
      message: `reusable-workflow call job is missing: ${jobId}`,
    });
  if (!callee.interface.reusable)
    failures.push({
      code: "callee-not-reusable",
      message: "callee does not declare on.workflow_call",
    });

  failures.push(
    ...validateCoordinate(job, {
      repository: calleeRepository,
      workflowPath: calleeWorkflowPath,
      sha: calleeSha,
    }),
  );
  if (!exactSha(calleeSha))
    failures.push({
      code: "callee-sha-invalid",
      message: "callee SHA must be an exact 40-character commit",
    });
  if (!exactSha(callerSha) || !exactSha(callerTree))
    failures.push({
      code: "caller-source-invalid",
      message: "caller SHA and tree must be exact 40-character Git object ids",
    });

  if (job && callee.interface.reusable) {
    failures.push(...validateInputs(job, callee.interface));
    failures.push(...validateSecrets(job, callee.interface));
    failures.push(
      ...validatePermissions(job.permissions, callee.interface.permissions),
    );
  }
  failures.push(...validateEvents(caller.triggers, trustedEventClasses));

  const contract = {
    schema: WORKFLOW_CALL_CONTRACT,
    caller: {
      repository: callerRepository,
      workflowPath: callerWorkflowPath,
      workflowDigest: sha256(String(callerText || "")),
      jobId,
      eventClasses: caller.triggers,
      uses: job?.uses || "",
      inputs: job?.with || {},
      secretNames:
        job?.secrets === "inherit"
          ? ["*"]
          : Object.keys(job?.secrets || {}).sort(),
      permissions: job?.permissions || {},
    },
    callee: {
      repository: calleeRepository,
      workflowPath: calleeWorkflowPath,
      sha: String(calleeSha || "").toLowerCase(),
      workflowDigest: sha256(String(calleeText || "")),
      interface: interfaceProjection(callee.interface),
    },
    trustedEventClasses: [...new Set(trustedEventClasses)].sort(),
  };
  const contractRoot = sha256(stableJson(contract));
  if (expectedContractRoot && expectedContractRoot !== contractRoot) {
    failures.push({
      code: "contract-root-mismatch",
      message: `workflow call contract root ${contractRoot} does not match accepted ${expectedContractRoot}`,
    });
  }
  const receipt = {
    schema: WORKFLOW_CALL_RECEIPT,
    contractRoot,
    caller: {
      repository: callerRepository,
      sha: String(callerSha || "").toLowerCase(),
      tree: String(callerTree || "").toLowerCase(),
      sourceState: callerSourceState,
      workflowPath: callerWorkflowPath,
      workflowDigest: contract.caller.workflowDigest,
    },
    callee: {
      repository: calleeRepository,
      sha: String(calleeSha || "").toLowerCase(),
      workflowPath: calleeWorkflowPath,
      workflowDigest: contract.callee.workflowDigest,
    },
    eventClasses: caller.triggers,
  };
  return {
    schema: "kungfu-buildchain-workflow-call-check/v1",
    ok: failures.length === 0,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    contract,
    contractRoot,
    receipt,
    receiptRoot: sha256(stableJson(receipt)),
    receiptReusable: failures.length === 0 && callerSourceState === "clean",
  };
}

export function assertWorkflowCallContract(options) {
  const report = evaluateWorkflowCallContract(options);
  if (!report.ok) {
    throw new Error(
      `Reusable workflow call contract failed:\n${report.failures.map((entry) => `${entry.code}: ${entry.message}`).join("\n")}`,
    );
  }
  return report;
}
