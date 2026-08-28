function maximumFunction(metrics, field) {
  return Math.max(0, ...(metrics.functions || []).map((entry) => entry[field]));
}
function violatedFunctions(metrics, budgets) {
  return Object.fromEntries(
    (metrics.functions || [])
      .filter(
        (entry) =>
          entry.lines > budgets.newFunctionLines ||
          entry.complexity > budgets.newFunctionComplexity,
      )
      .map((entry) => [
        `${entry.name}@${entry.start}`,
        Object.fromEntries(
          [
            ["lines", entry.lines, budgets.newFunctionLines],
            ["complexity", entry.complexity, budgets.newFunctionComplexity],
          ]
            .filter(([, value, limit]) => value > limit)
            .map(([key, value]) => [key, value]),
        ),
      ]),
  );
}
function debtSurfaces(current, policy) {
  const collectCode = (files, budgets) =>
    Object.fromEntries(
      Object.entries(files || {}).flatMap(([file, metrics]) => {
        const functions = violatedFunctions(metrics, budgets);
        const measured = {
          ...(metrics.lines > budgets.newFileLines
            ? { lines: metrics.lines }
            : {}),
          ...(Object.keys(functions).length ? { functions } : {}),
        };
        return Object.keys(measured).length ? [[file, measured]] : [];
      }),
    );
  const workflowFields = [
    ["lines", "maxLines"],
    ["jobs", "maxJobs"],
    ["steps", "maxSteps"],
    ["maxStepsPerJob", "maxStepsPerJob"],
    ["decisions", "maxDecisions"],
  ];
  return {
    sources: collectCode(
      Object.fromEntries(
        Object.entries(current.files || {}).filter(
          ([file]) => !file.endsWith(".rs"),
        ),
      ),
      policy.sourceBudgets,
    ),
    rust: collectCode(
      Object.fromEntries(
        Object.entries(current.files || {}).filter(([file]) =>
          file.endsWith(".rs"),
        ),
      ),
      policy.rustBudgets,
    ),
    tests: collectCode(current.tests, policy.testBudgets),
    workflows: Object.fromEntries(
      Object.entries(current.workflows || {}).flatMap(([file, metrics]) => {
        const measured = Object.fromEntries(
          workflowFields
            .filter(
              ([metric, limit]) =>
                metrics[metric] > policy.workflowBudgets[limit],
            )
            .map(([metric]) => [metric, metrics[metric]]),
        );
        return Object.keys(measured).length ? [[file, measured]] : [];
      }),
    ),
  };
}
function metricLeaves(value, prefix = "") {
  return Object.entries(value || {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object"
      ? metricLeaves(child, path)
      : [[path, child]];
  });
}
function metricAt(value, metric) {
  return metric.split(".").reduce((current, key) => current?.[key], value);
}
function calculateDebtMeasuredExcess(debt) {
  return Object.values(debt?.surfaces || {}).reduce(
    (domainTotal, surfaces) =>
      domainTotal +
      Object.values(surfaces || {}).reduce(
        (surfaceTotal, entry) =>
          surfaceTotal +
          metricLeaves(entry.current).reduce((metricTotal, [metric, value]) => {
            const target = metricAt(entry.target, metric);
            return (
              metricTotal +
              (Number.isFinite(value) && Number.isFinite(target)
                ? Math.max(0, value - target)
                : 0)
            );
          }, 0),
        0,
      ),
    0,
  );
}
function evaluateDebtBudget({ debt, policy }) {
  const budget = policy.debtBudget;
  if (!budget) return [];
  const issues = [];
  for (const field of [
    "baselineMeasuredExcess",
    "baselineTotalExcess",
    "maxTotalExcess",
    "targetExclusive",
  ]) {
    if (!Number.isInteger(budget[field]) || budget[field] < 0) {
      issues.push(`debt budget ${field} must be a non-negative integer`);
    }
  }
  if (!String(budget.baselineProtectedHead || "").trim()) {
    issues.push("debt budget baselineProtectedHead is required");
  }
  if (issues.length) return issues;
  if (budget.maxTotalExcess > budget.baselineTotalExcess) {
    issues.push("debt budget maximum cannot exceed its frozen baseline");
  }
  if (budget.targetExclusive > budget.maxTotalExcess) {
    issues.push("debt budget target cannot exceed its frozen maximum");
  }
  const measured = calculateDebtMeasuredExcess(debt);
  const total =
    budget.baselineTotalExcess + measured - budget.baselineMeasuredExcess;
  const ledger = debt.totalExcessLedger || {};
  if (ledger.measuredExcess !== measured || ledger.current !== total) {
    issues.push(
      `debt total-excess ledger is stale: measured ${measured}, calibrated ${total}`,
    );
  }
  if (total > budget.maxTotalExcess) {
    issues.push(
      `maintainability debt total excess is ${total}; frozen maximum is ${budget.maxTotalExcess}`,
    );
  }
  return issues;
}
function evaluateDebtEntry(domain, path, entry, expected) {
  if (JSON.stringify(entry.current) !== JSON.stringify(expected))
    return [`${domain}:${path}: current measurement is stale`];
  return metricLeaves(entry.current).flatMap(([metric, measured]) => {
    const baseline = metricAt(entry.baseline, metric),
      target = metricAt(entry.target, metric);
    return [
      ...(!Number.isFinite(baseline) || measured > baseline
        ? [`${domain}:${path}:${metric}: debt widened beyond baseline`]
        : []),
      ...(!Number.isFinite(target) || target >= measured
        ? [`${domain}:${path}:${metric}: target must be lower than current`]
        : []),
    ];
  });
}
function evaluateDebtAuthority({
  current,
  policy,
  debt,
  capabilityIds,
  hotspots = [],
}) {
  const issues = [];
  if (debt?.schemaVersion !== 1)
    return ["maintainability debt schemaVersion must be 1"];
  const defaults = debt.defaults || {};
  for (const field of [
    "owner",
    "capability",
    "expiry",
    "impact",
    "recovery",
    "stopCondition",
  ]) {
    if (!String(defaults[field] || "").trim())
      issues.push(`debt defaults.${field} is required`);
  }
  if (!capabilityIds.has(defaults.capability)) {
    issues.push(
      `debt capability is unmapped: ${defaults.capability || "<empty>"}`,
    );
  }
  const expiry = String(defaults.expiry || "");
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(expiry) ||
    expiry < new Date().toISOString().slice(0, 10)
  ) {
    issues.push(`debt expiry is invalid or stale: ${expiry || "<empty>"}`);
  }
  const expected = debtSurfaces(current, policy);
  for (const domain of Object.keys(expected)) {
    const governed = debt.surfaces?.[domain] || {};
    const expectedPaths = Object.keys(expected[domain]).sort();
    const governedPaths = Object.keys(governed).sort();
    for (const path of expectedPaths.filter(
      (entry) => !governedPaths.includes(entry),
    ))
      issues.push(`${domain}:${path}: oversized surface is undeclared`);
    for (const path of governedPaths.filter(
      (entry) => !expectedPaths.includes(entry),
    ))
      issues.push(`${domain}:${path}: debt entry is stale`);
    for (const path of expectedPaths.filter((entry) =>
      governedPaths.includes(entry),
    )) {
      issues.push(
        ...evaluateDebtEntry(
          domain,
          path,
          governed[path],
          expected[domain][path],
        ),
      );
    }
  }
  const declaredHotspots = debt.hotspots || [];
  for (const path of hotspots.filter(
    (entry) => !declaredHotspots.includes(entry),
  ))
    issues.push(`hotspot:${path}: change route is undeclared`);
  for (const slice of debt.burnDownSlices || []) {
    const measured = metricAt(
      expected[slice.domain]?.[slice.path],
      slice.metric,
    );
    if (!Number.isFinite(measured) || measured !== slice.current) {
      issues.push(
        `burn-down:${slice.path}:${slice.metric}: current aggregate is stale`,
      );
    } else if (
      !Number.isFinite(slice.baseline) ||
      slice.current >= slice.baseline
    ) {
      issues.push(
        `burn-down:${slice.path}:${slice.metric}: split-only change did not reduce aggregate debt`,
      );
    }
  }
  return issues;
}
const exceptionCollections = [
  "approvedExistingDebtTransitions",
  "approvedNewFileTransitions",
  "approvedExtractedDebt",
  "approvedPublicSurfaceTransitions",
  "approvedTestDebtTransitions",
  "approvedWorkflowDebtTransitions",
];
function evaluateExceptionBudget({ policy }) {
  const budget = policy.exceptionBudget;
  if (!budget) return [];
  const issues = [];
  let total = 0;
  for (const collection of exceptionCollections) {
    const count = Object.keys(policy[collection] || {}).length;
    total += count;
    const maximum = budget.maxByCollection?.[collection];
    if (!Number.isInteger(maximum) || maximum < 0) {
      issues.push(
        `exception budget ${collection} must be a non-negative integer`,
      );
    } else if (count > maximum) {
      issues.push(
        `${collection} has ${count} exceptions; frozen maximum is ${maximum}`,
      );
    }
  }
  if (!Number.isInteger(budget.maxTotal) || budget.maxTotal < 0) {
    issues.push("exception budget maxTotal must be a non-negative integer");
  } else if (total > budget.maxTotal) {
    issues.push(
      `maintainability exceptions total ${total}; frozen maximum is ${budget.maxTotal}`,
    );
  }
  return issues;
}
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
  calculateDebtMeasuredExcess,
  debtSurfaces,
  evaluateDebtAuthority,
  evaluateDebtBudget,
  evaluateExceptionBudget,
  evaluateExceptionGovernance,
  evaluateTestBudgets,
  evaluateWorkflowBudgets,
};
