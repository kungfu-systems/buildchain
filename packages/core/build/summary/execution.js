export function assertJobResults(jobs, plan) {
  for (const [name, enabled] of [
    ["build-native", plan.matrix.native.length > 0],
    ["build-container", plan.matrix.container.length > 0],
    ["sign", true],
    ["attest", Boolean(plan.build.attestation.subject_path)],
  ]) {
    const expected = enabled ? "success" : "skipped";
    if (jobs[name]?.result !== expected)
      throw new Error(
        `Build job ${name}: expected ${expected}, got ${jobs[name]?.result || "missing"}`,
      );
  }
}
export function buildControllerStages(plan, jobs, executions, success) {
  const stageStatus = (id) => {
    if (!plan.lifecycle[id].configured) return "skipped";
    if (executions.some((record) => record.stages[id] === "failure"))
      return "failure";
    if (
      executions.length === plan.platforms.length &&
      executions.every((record) => record.stages[id] === "success")
    )
      return "success";
    return executions.some((record) => record.stages[id])
      ? "partial"
      : "skipped";
  };
  return [
    { id: "plan", status: "success" },
    ...["install", "build", "verify"].map((id) => ({
      id,
      status: stageStatus(id),
    })),
    { id: "sign", status: jobs.sign?.result || "skipped" },
    { id: "attest", status: jobs.attest?.result || "skipped" },
    { id: "deliver", status: success ? "success" : "failure" },
  ];
}
