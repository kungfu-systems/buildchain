import fs from "node:fs";
import path from "node:path";
import { verificationIdentity, verificationCommand } from "./identity.js";
import { discoverVerification, planVersionProjection } from "./discovery.js";
import { sealVerification } from "./proof.js";
import { verifyVersionStateDelta } from "../../release/version-state/verification.js";
import { qualifySourceLifecycle } from "../source/lifecycle.js";

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};
export function verificationProvider({ workspace, env, token }) {
  const read = (endpoint, encoding) =>
    verificationCommand(
      "gh",
      ["api", endpoint],
      workspace,
      { ...env, GH_TOKEN: token },
      encoding,
    );
  return {
    fetchJson: async (endpoint) => JSON.parse(read(endpoint, "utf8")),
    fetchArchive: async (endpoint) => read(endpoint, null),
  };
}
export async function selectSourceVerification(
  { workspace, runtimeRoot, env, provider },
  {
    identity = verificationIdentity,
    discover = discoverVerification,
    regenerate = verifyVersionStateDelta,
    command = verificationCommand,
  } = {},
) {
  try {
    const git = (...args) => command("git", args, workspace, env).trim();
    if (git("status", "--porcelain", "--untracked-files=no"))
      throw new Error("dirty source");
    const event = env.GITHUB_EVENT_NAME,
      headSha = git("rev-parse", "HEAD");
    const lookup = (revision) =>
      discover({
        expected: identity({ workspace, env, revision }),
        evaluatedAtMs: Date.now(),
        ...provider,
      });
    if (event === "push" && env.GITHUB_REF?.startsWith("refs/heads/dev/")) {
      const exact = await lookup("HEAD");
      if (exact.decision === "reuse") return exact;
    }
    if (!["pull_request", "merge_group", "push"].includes(event))
      return {
        decision: "execute",
        reason: "full-execution-required-for-event",
      };
    const payload = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const baseSha =
      event === "merge_group"
        ? payload.merge_group?.base_sha
        : event === "pull_request"
          ? payload.pull_request?.base.sha
          : env.GITHUB_REF?.startsWith("refs/heads/dev/")
            ? payload.before
            : null;
    if (!/^[a-f0-9]{40}$/.test(baseSha || ""))
      throw new Error("no exact protected base");
    return await planVersionProjection({
      baseSha,
      headSha,
      discover: lookup,
      regenerate: (baseSha, headSha) =>
        regenerate({
          baseSha,
          headSha,
          cwd: workspace,
          nodeModules: path.join(runtimeRoot, "node_modules"),
        }),
    });
  } catch {
    return {
      decision: "execute",
      reason: "identity-provider-or-version-delta-unavailable",
    };
  }
}
export function startSourceVerification({ workspace, env }) {
  const started = {
    identity: verificationIdentity({ workspace, env }),
    startedAtMs: Date.now(),
  };
  write(
    path.join(workspace, ".buildchain/source-verification/start.json"),
    started,
  );
  return started;
}
export function sealSourceVerification({ workspace, env, started }) {
  if (env.GITHUB_EVENT_NAME !== "merge_group")
    throw new Error("only merge-group full executions produce reusable proof");
  if (
    verificationCommand(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      workspace,
      env,
    ).trim() ||
    JSON.stringify(started.identity) !==
      JSON.stringify(verificationIdentity({ workspace, env }))
  )
    throw new Error("source or verification identity changed during execution");
  const completedAtMs = Date.now();
  const proof = sealVerification({
    schema: "buildchain-v4-source-verification-evidence/v1",
    ...started,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME,
    validationKind: "full-source",
    exitCode: 0,
    completedAtMs,
    expiresAtMs: completedAtMs + 6 * 60 * 60 * 1000,
  });
  write(
    path.join(workspace, ".buildchain/source-verification/evidence.json"),
    proof,
  );
  return proof;
}
export function recordSourceVerification({ workspace, summaryPath }, decision) {
  write(
    path.join(workspace, ".buildchain/source-verification/decision.json"),
    decision,
  );
  if (summaryPath)
    fs.appendFileSync(
      summaryPath,
      `Source verification: **${decision.decision}** (${decision.reason}).${decision.runId ? ` Original full execution: run ${decision.runId}, attempt ${decision.runAttempt}, proof ${decision.evidenceRoot}.` : ""}\n`,
    );
}
export async function qualifyRepositorySource(
  options,
  {
    select = selectSourceVerification,
    start = startSourceVerification,
    qualify = qualifySourceLifecycle,
    seal = sealSourceVerification,
    observe = () => {},
  } = {},
) {
  const decision = await select(options);
  recordSourceVerification(options, decision);
  observe({ decision: decision.decision, "proof-sealed": "false" });
  if (decision.decision !== "execute") return { decision };
  const started =
    options.env.GITHUB_EVENT_NAME === "merge_group"
      ? start(options)
      : undefined;
  await qualify({
    ...options,
    cwd: options.workspace,
    mode: "verify",
    requireVersionState: true,
    paperAdmission: false,
  });
  const proof = started ? seal({ ...options, started }) : undefined;
  if (proof) observe({ "proof-sealed": "true" });
  return { decision, proof };
}
