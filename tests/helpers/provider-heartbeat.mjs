export const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

export function admission() {
  return {
    observation: {
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v4/v4.0",
      stateRoot: ROOT("1"),
      activeWarrant: {
        candidateId: ROOT("2"),
        fencingToken: ROOT("3"),
        generation: 4,
        issuedAt: "2026-08-15T00:00:00.000Z",
        heartbeatAt: "2026-08-15T00:00:00.000Z",
        expiresAt: "2026-08-15T00:01:00.000Z",
      },
    },
  };
}

export function jobs(completed, callerPath = "") {
  const providerName = (name) =>
    callerPath ? `${callerPath} / ${name}` : name;
  return {
    jobs: [
      {
        id: 10,
        name: providerName("Reserve exact delivery candidate"),
        status: "completed",
        conclusion: "success",
        runner_name: "GitHub Actions 10",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:00.000Z",
        completed_at: "2026-08-15T00:00:05.000Z",
      },
      {
        id: 11,
        name: providerName("Credentialless native execution"),
        status: completed ? "completed" : "in_progress",
        conclusion: completed ? "success" : null,
        runner_name: "GitHub Actions 11",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:00.000Z",
        completed_at: completed ? "2026-08-15T00:00:20.000Z" : null,
      },
      {
        id: 12,
        name: providerName("Credentialless native evidence seal"),
        status: completed ? "completed" : "queued",
        conclusion: completed ? "success" : null,
        runner_name: completed ? "GitHub Actions 12" : "",
        runner_group_name: completed ? "GitHub Actions" : "",
        labels: completed ? ["X64", "ubuntu-24.04"] : [],
        started_at: completed ? "2026-08-15T00:00:21.000Z" : null,
        completed_at: completed ? "2026-08-15T00:00:25.000Z" : null,
      },
      {
        id: 13,
        name: providerName("Credentialed independent Warrant heartbeat"),
        status: completed ? "completed" : "in_progress",
        conclusion: completed ? "success" : null,
        runner_name: "GitHub Actions 13",
        runner_group_name: "GitHub Actions",
        labels: ["macos-15", "ARM64"],
        started_at: "2026-08-15T00:00:01.000Z",
        completed_at: completed ? "2026-08-15T00:00:26.000Z" : null,
      },
      {
        id: 14,
        name: providerName("Credentialed provider finalizer"),
        status: "in_progress",
        conclusion: null,
        runner_name: "GitHub Actions 14",
        runner_group_name: "GitHub Actions",
        labels: ["ubuntu-24.04", "X64"],
        started_at: "2026-08-15T00:00:27.000Z",
        completed_at: null,
      },
    ],
  };
}
