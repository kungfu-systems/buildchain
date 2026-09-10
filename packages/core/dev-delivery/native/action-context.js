import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
export function deliveryActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  const expectedSha = core.getInput("runtime-sha", { required: true });
  if (
    !/^[a-f0-9]{40}$/u.test(expectedSha) ||
    command(
      "git",
      ["-C", runtimeRoot, "rev-parse", "--verify", "HEAD^{commit}"],
      { stdio: "pipe" },
    ).trim() !== expectedSha
  )
    throw new Error(
      "Delivery action runtime differs from admitted immutable commit",
    );
  return {
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot,
    runtimeSha: expectedSha,
    run: {
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    runner: {
      name: env.RUNNER_NAME,
      os: env.RUNNER_OS,
      arch: env.RUNNER_ARCH,
      environment: core.getInput("runner-environment"),
    },
  };
}

export function selectedDeliveryActionContext(core, env) {
  const runtimeRoot = installationRoot(import.meta.url);
  const selector = core.getInput("runtime-ref", { required: true });
  if (
    !/^(?:v4(?:-alpha)?|[0-9a-f]{40}|train\/v4\/v4\.\d+\/[a-z0-9][a-z0-9._-]*)$/u.test(
      selector,
    )
  )
    throw new Error("Unsupported delivery runtime selector");
  const runtimeSha = command(
    "git",
    ["-C", runtimeRoot, "rev-parse", "--verify", "HEAD^{commit}"],
    { stdio: "pipe" },
  ).trim();
  if (
    !/^[0-9a-f]{40}$/u.test(runtimeSha) ||
    (/^[0-9a-f]{40}$/u.test(selector) && selector !== runtimeSha)
  )
    throw new Error("Delivery runtime differs from immutable selector");
  return {
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeRoot,
    runtimeSha,
  };
}
