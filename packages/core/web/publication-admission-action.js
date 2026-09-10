import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import { command } from "../runtime/action-process.mjs";
import { installationRoot } from "../runtime/installation-root.js";
import { finalizeWebController } from "./controller.js";
import { assembleWebPublicationAdmission } from "./publication-admission.js";

export async function sealWebPublicationAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const observations = JSON.parse(
    core.getInput("observations-json", { required: true }),
  );
  const sourceSha =
    observations["release-intent"].outputs["production-source-sha"];
  const runtimeRoot = installationRoot(import.meta.url);
  const runtimeSha = command("git", ["-C", runtimeRoot, "rev-parse", "HEAD"], {
    stdio: "pipe",
  })
    .trim()
    .toLowerCase();
  if (runtimeSha !== observations.runtime.outputs["runtime-sha"])
    throw new Error("Web publication runtime changed after admission");
  const { receipt } = finalizeWebController({
    workspace: env.GITHUB_WORKSPACE,
    observations,
    sourceSha,
    prepublication: true,
  });
  if (!receipt.qualifying)
    throw new Error("Prepublication controller receipt did not qualify");
  const planPath = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/controller/web-surface-plan.json",
  );
  const bytes = fs.readFileSync(planPath);
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const github = getOctokit(core.getInput("token", { required: true }));
  const { data } = await github.rest.git.getCommit({
    owner,
    repo,
    commit_sha: sourceSha,
  });
  const bundle = assembleWebPublicationAdmission({
    repository: env.GITHUB_REPOSITORY,
    sourceSha,
    sourceTreeSha: data.tree.sha,
    runtimeSha,
    plan: JSON.parse(bytes),
    planFileDigest: crypto.createHash("sha256").update(bytes).digest("hex"),
    controllerReceipt: receipt,
    decision: JSON.parse(
      observations["publication-decision"].outputs["decision-json"],
    ),
    environment: request["production-environment"],
    roleArn: request["production-aws-role-arn"],
    registry: JSON.parse(
      fs.readFileSync(
        path.join(runtimeRoot, "dist/site/publication-authority-registry.json"),
        "utf8",
      ),
    ),
    runner: {
      githubActions: env.GITHUB_ACTIONS,
      environment: env.RUNNER_ENVIRONMENT,
      os: env.RUNNER_OS,
      architecture: env.RUNNER_ARCH,
      imageOs: env.ImageOS,
      imageVersion: env.ImageVersion,
    },
    run: {
      workflow: env.GITHUB_WORKFLOW,
      job: env.GITHUB_JOB,
      id: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
    },
  });
  const directory = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/web-publication-authority",
  );
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(bundle)) {
    fs.writeFileSync(
      path.join(directory, `${name}.json`),
      JSON.stringify(value, null, 2) + "\n",
    );
    core.setOutput(`${name.replaceAll("_", "-")}-json`, JSON.stringify(value));
  }
  core.setOutput("capability-digest", bundle.capability.capabilityDigest);
}
