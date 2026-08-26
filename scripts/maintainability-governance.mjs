function maximumFunction(metrics, field) {
  return Math.max(0, ...(metrics.functions || []).map((entry) => entry[field]));
}

const exceptionCollections = [
  "approvedExistingDebtTransitions",
  "approvedNewFileTransitions",
  "approvedExtractedDebt",
  "approvedPublicSurfaceTransitions",
  "approvedTestDebtTransitions",
  "approvedWorkflowDebtTransitions",
];

function exceptionGovernanceIssues(label, approval, policy, now) {
  const issues = [];
  const reference = approval?.governance;
  const governance =
    typeof reference === "string"
      ? policy.exceptionGovernanceProfiles?.[reference]
      : reference;
  if (!governance || typeof governance !== "object") {
    return [`${label}: maintainability exception requires governance`];
  }
  if (governance.mode === "expiry") {
    const expiresOn = String(governance.expiresOn || "");
    const parsedExpiry = new Date(`${expiresOn}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(expiresOn) ||
      Number.isNaN(parsedExpiry.valueOf()) ||
      parsedExpiry.toISOString().slice(0, 10) !== expiresOn
    ) {
      issues.push(`${label}: exception expiry must be YYYY-MM-DD`);
    } else if (expiresOn < now.toISOString().slice(0, 10)) {
      issues.push(
        `${label}: maintainability exception expired on ${expiresOn}`,
      );
    }
    if (!String(governance.owner || "").trim()) {
      issues.push(`${label}: expiring exception requires an owner`);
    }
    if (!String(governance.followUp || "").trim()) {
      issues.push(`${label}: expiring exception requires a follow-up`);
    }
    return issues;
  }
  if (governance.mode === "net-debt-reduction") {
    const metrics = governance.metrics;
    if (
      !metrics ||
      typeof metrics !== "object" ||
      Object.keys(metrics).length === 0
    ) {
      return [`${label}: net debt reduction requires bounded metrics`];
    }
    for (const [metric, reduction] of Object.entries(metrics)) {
      if (
        !Number.isFinite(reduction?.baseline) ||
        !Number.isFinite(reduction?.target) ||
        reduction.target >= reduction.baseline
      ) {
        issues.push(
          `${label}: ${metric} target must be lower than its baseline`,
        );
      }
      if (!Number.isFinite(approval?.[metric])) {
        issues.push(
          `${label}: ${metric} reduction requires a matching exception ceiling`,
        );
      } else if (approval[metric] > reduction.target) {
        issues.push(
          `${label}: ${metric} ceiling exceeds its debt-reduction target`,
        );
      }
    }
    return issues;
  }
  return [
    `${label}: exception governance mode must be expiry or net-debt-reduction`,
  ];
}

function evaluateExceptionGovernance({ policy, now = new Date() }) {
  const issues = [];
  for (const collection of exceptionCollections) {
    for (const [key, approval] of Object.entries(policy[collection] || {})) {
      issues.push(
        ...exceptionGovernanceIssues(
          `${collection}:${key}`,
          approval,
          policy,
          now,
        ),
      );
    }
  }
  if (policy.repositoryBudgets) {
    issues.push(
      ...exceptionGovernanceIssues(
        "repositoryBudgets",
        policy.repositoryBudgets,
        policy,
        now,
      ),
    );
  }
  return issues;
}

function evaluateTestBudgets({ current, baselineFiles, policy }) {
  const issues = [];
  const budgets = policy.testBudgets;
  for (const [file, metrics] of Object.entries(current.tests || {})) {
    const baseline = baselineFiles[file];
    const transition = policy.approvedTestDebtTransitions?.[file];
    if (transition && !String(transition.rationale || "").trim()) {
      issues.push(`${file}: approved test transition requires a rationale`);
    }
    const limits = baseline
      ? {
          lines:
            transition?.maxLines ??
            Math.max(baseline.lines, budgets.newFileLines),
          functionLines:
            transition?.maxFunctionLines ??
            Math.max(
              maximumFunction(baseline, "lines"),
              budgets.newFunctionLines,
            ),
          functionComplexity:
            transition?.maxFunctionComplexity ??
            Math.max(
              maximumFunction(baseline, "complexity"),
              budgets.newFunctionComplexity,
            ),
        }
      : {
          lines: transition?.maxLines ?? budgets.newFileLines,
          functionLines:
            transition?.maxFunctionLines ?? budgets.newFunctionLines,
          functionComplexity:
            transition?.maxFunctionComplexity ?? budgets.newFunctionComplexity,
        };
    if (metrics.lines > limits.lines) {
      issues.push(
        `${file}: test file has ${metrics.lines} lines; budget is ${limits.lines}`,
      );
    }
    if (maximumFunction(metrics, "lines") > limits.functionLines) {
      issues.push(
        `${file}: maximum test function length exceeds ${limits.functionLines}`,
      );
    }
    if (maximumFunction(metrics, "complexity") > limits.functionComplexity) {
      issues.push(
        `${file}: maximum test function complexity exceeds ${limits.functionComplexity}`,
      );
    }
  }
  return issues;
}

function evaluateWorkflowBudgets({ current, baselineFiles, policy }) {
  const issues = [];
  const budgets = policy.workflowBudgets;
  const fields = [
    ["lines", "maxLines"],
    ["jobs", "maxJobs"],
    ["steps", "maxSteps"],
    ["maxStepsPerJob", "maxStepsPerJob"],
    ["decisions", "maxDecisions"],
  ];
  for (const [file, metrics] of Object.entries(current.workflows || {})) {
    const baseline = baselineFiles[file];
    const transition = policy.approvedWorkflowDebtTransitions?.[file];
    if (transition && !String(transition.rationale || "").trim()) {
      issues.push(`${file}: approved workflow transition requires a rationale`);
    }
    for (const [metric, ceiling] of fields) {
      const allowed =
        transition?.[ceiling] ??
        (baseline
          ? Math.max(baseline[metric], budgets[ceiling])
          : budgets[ceiling]);
      if (metrics[metric] > allowed) {
        issues.push(
          `${file}: workflow ${metric} is ${metrics[metric]}; budget is ${allowed}`,
        );
      }
    }
  }
  return issues;
}

export {
  evaluateExceptionGovernance,
  evaluateTestBudgets,
  evaluateWorkflowBudgets,
};
