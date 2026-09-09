import { createHash } from "node:crypto";
import fs from "node:fs";
import { outputs, readEvidence, runtimeCommand, writeEvidence } from "./io.mjs";
import {
  command,
  environmentArguments,
  requireValue,
} from "../../runtime/action-process.mjs";

export function rootRuntime(env) {
  const sha = command(
    "git",
    ["-C", ".buildchain/runtime", "rev-parse", "--verify", "HEAD^{commit}"],
    { stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  requireValue(
    /^[0-9a-f]{40}$/u.test(sha),
    "resolved Buildchain runtime is not an exact commit SHA",
  );
  requireValue(
    !/^[0-9a-f]{40}$/u.test(env.BUILDCHAIN_REF || "") ||
      sha === env.BUILDCHAIN_REF,
    "resolved Buildchain runtime SHA does not match the immutable selector",
  );
  const bytes = writeEvidence("runtime-selection.json", {
    schema: "kungfu.buildchain.dev-delivery-runtime-selection/v1",
    repository: env.BUILDCHAIN_REPOSITORY,
    selector: env.BUILDCHAIN_REF,
    resolvedSha: sha,
  });
  outputs({
    sha,
    root: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}
export function verifyProjectCut(env) {
  fs.mkdirSync(".buildchain/dev-delivery", { recursive: true });
  fs.writeFileSync(
    ".buildchain/dev-delivery/project-cut-proof.json",
    `${env.PROJECT_CUT_PROOF_JSON}\n`,
  );
  runtimeCommand("dev-delivery-proof", [
    "verify-replay",
    "--source-proof",
    ".buildchain/dev-delivery/project-cut-proof.json",
    "--output",
    ".buildchain/dev-delivery/project-cut-verification.json",
  ]);
  const result = readEvidence("project-cut-verification.json");
  requireValue(
    result.ok === true && result.reason === "exact-project-cut-replay",
    "Project Cut replay verification failed",
  );
  outputs({
    path: ".buildchain/dev-delivery/project-cut-proof.json",
    "proof-root": readEvidence("project-cut-proof.json").proofRoot,
  });
}
export function qualifySource(env) {
  const args = environmentArguments(
    {
      repository: "GITHUB_REPOSITORY",
      branch: "TARGET_BRANCH",
      "pull-request": "EXPECTED_PR",
      "expected-head": "EXPECTED_HEAD",
      "source-patch-root": "SOURCE_PATCH_ROOT",
    },
    env,
  );
  args.push(
    "--landing-mode",
    "queue",
    "--qualification-only",
    "--output",
    ".buildchain/dev-delivery/source-admission.json",
  );
  if (env.PROJECT_CUT_PROOF_PATH)
    args.push("--project-cut-proof", env.PROJECT_CUT_PROOF_PATH);
  if (
    env.WARRANT_MODE === "required" ||
    (env.WARRANT_MODE === "shadow" && env.DRY_RUN !== "true")
  )
    args.push("--execute");
  runtimeCommand("dev-pr-auto-merge", args);
}
export function sealSourceProof(env) {
  const receiptRoot = readEvidence("source-admission.json").receiptRoot;
  requireValue(
    /^sha256:[0-9a-f]{64}$/u.test(receiptRoot || ""),
    "Source admission receipt root is missing",
  );
  const args = [
    "source",
    ...environmentArguments(
      {
        repository: "GITHUB_REPOSITORY",
        branch: "TARGET_BRANCH",
        "source-identity-root": "SOURCE_IDENTITY_ROOT",
        "source-head": "EXPECTED_HEAD",
        "source-patch-root": "SOURCE_PATCH_ROOT",
        "plan-root": "PLAN_ROOT",
        "closure-root": "CLOSURE_ROOT",
        "dependency-root": "DEPENDENCY_ROOT",
        "toolchain-root": "TOOLCHAIN_ROOT",
        "affected-paths-json": "AFFECTED_PATHS",
      },
      env,
    ),
    "--shard-evidence-roots-json",
    JSON.stringify([receiptRoot]),
    "--qualified-at",
    new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    "--output",
    ".buildchain/dev-delivery/source-proof.json",
  ];
  runtimeCommand("dev-delivery-proof", args);
  outputs({ "source-proof-root": readEvidence("source-proof.json").proofRoot });
}
