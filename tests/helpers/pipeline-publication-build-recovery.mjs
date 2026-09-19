import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compileConsumerPlan } from "../../packages/core/consumer/contract/plan.js";
import { consumerWorkflows } from "../../packages/core/consumer/contract/entries.js";
import { buildPipelineProducts } from "../../packages/core/workflow/pipeline/build.js";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";
import { planPipelinePublication } from "../../packages/core/publication/pipeline/plan.js";
import { deriveRecoveryPublicationPlan } from "../../packages/core/publication/pipeline/recovery-plan.js";
import { packPipelineProducts } from "../../packages/core/publication/pipeline/pack.js";
import { pipelinePublicationArtifactName } from "../../packages/core/providers/github/pipeline-publication-artifacts.js";

const rooted = (body) => ({ ...body, root: recordDigest(body) });
export async function publicationBuildRecoveryFixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "publication-build-recovery-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "source");
  fs.cpSync("templates/minimal-consumer/paper", cwd, { recursive: true });
  const contract = compileConsumerPlan(
    fs
      .readFileSync(path.join(cwd, ".buildchain/buildchain.toml"), "utf8")
      .replace(
        'platforms = ["linux-x64"]',
        'platforms = ["linux-x64", "windows-x64"]',
      ),
  );
  const source = {
    repository: "example/product",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    configPath: ".buildchain/buildchain.toml",
  };
  const oldRuntime = {
    repository: "kungfu-systems/buildchain",
    sha: "c".repeat(40),
    readerDigest: recordDigest("reader"),
  };
  const runtime = { ...oldRuntime, sha: "8".repeat(40) };
  const publisher = {
    repository: oldRuntime.repository,
    workflow: ".github/workflows/.release-pipeline-products.yml",
    workflowSha: "e".repeat(40),
    job: "apply",
  };
  const plan = planPipelinePublication({
    attempt: `attempt-${"1".repeat(64)}`,
    generation: recordDigest("generation"),
    source,
    runtime: {
      repository: oldRuntime.repository,
      commit: oldRuntime.sha,
      tree: "d".repeat(40),
    },
    publisher,
    contract,
    route: contract.channels[1],
    version: "1.0.0-alpha.1",
    sourceTimestamp: new Date().toISOString(),
  });
  const materialization = rooted({
    schema: "buildchain.pipeline-version-materialization/v1",
    planRoot: plan.root,
    protectedSource: source,
    source,
    material: { version: plan.version, changes: [] },
  });
  const oldContext = {
    schema: "buildchain.pipeline-publication-context/v1",
    attempt: plan.attempt,
    generation: plan.generation,
    plan,
    materialization,
    runId: 100,
    runAttempt: 1,
    platforms: [{ platform: "linux-x64" }, { platform: "windows-x64" }],
  };
  const execution = {
    attempt: `attempt-${"2".repeat(64)}`,
    runtime: {
      repository: runtime.repository,
      commit: runtime.sha,
      tree: "7".repeat(40),
    },
    publisher: { ...publisher, workflowSha: "9".repeat(40) },
  };
  const derived = deriveRecoveryPublicationPlan(
    plan,
    materialization,
    execution,
    recordDigest("admission"),
  );
  const provider = await publicationBuildProvider({
    root,
    cwd,
    contract,
    plan,
    derived,
    source,
    runtime,
  });
  const session = {
    observed: {
      generation: plan.generation,
      history: [
        {
          identity: { id: plan.attempt },
          generation: { id: plan.generation },
          events: [{ runtime: oldRuntime }],
        },
      ],
    },
  };
  const materials = [
    {
      id: `publication/context/${recordDigest(oldContext).slice(7)}`,
      value: oldContext,
    },
  ];
  return {
    root,
    plan,
    materialization,
    oldContext,
    derived,
    ...provider,
    session,
    materials,
  };
}

async function publicationBuildProvider({
  root,
  cwd,
  contract,
  plan,
  derived,
  source,
  runtime,
}) {
  const runs = new Map(),
    artifacts = new Map(),
    directories = new Map(),
    downloads = [];
  function producer(id, current) {
    const caller = `.github/workflows/${current ? "buildchain-recover" : "buildchain"}.yml`;
    const run = {
      id,
      run_attempt: 1,
      status: current ? "in_progress" : "completed",
      conclusion: current ? null : "failure",
      repository: { full_name: source.repository },
      head_repository: { full_name: source.repository },
      head_sha: (current ? "6" : "5").repeat(40),
      path: caller,
      event: current ? "workflow_dispatch" : "repository_dispatch",
      referenced_workflows: [
        {
          path: `kungfu-systems/buildchain/.github/workflows/public-ops-${current ? "recover" : "pipeline"}.yml@v4`,
          sha: "9".repeat(40),
        },
      ],
    };
    const platforms = current ? ["windows-x64"] : ["linux-x64", "windows-x64"];
    const jobs = platforms.map((platform, i) => ({
      id: id * 10 + i,
      run_id: id,
      run_attempt: 1,
      name: `Build publication (${platform})`,
      status: "completed",
      conclusion:
        !current && platform === "windows-x64" ? "failure" : "success",
    }));
    runs.set(id, { run, jobs });
  }
  producer(100, false);
  producer(200, true);
  // Both actual PDFs are produced locally; injected provider jobs exercise
  // provenance and scheduling contracts, not hosted Windows qualification.
  await buildPipelineProducts({ cwd, plan: contract, platform: "linux-x64" });
  for (const [id, platform, ownerPlan] of [
    [100, "linux-x64", plan],
    [200, "windows-x64", derived.plan],
  ]) {
    const directory = path.join(root, `packed-${id}`);
    packPipelineProducts({
      cwd,
      output: directory,
      plan: ownerPlan,
      source,
      platform,
    });
    directories.set(id, directory);
    artifacts.set(id, [
      {
        id,
        name: pipelinePublicationArtifactName(ownerPlan, platform),
        expired: false,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        digest: recordDigest(`archive-${id}`),
        workflow_run: { id, head_sha: runs.get(id).run.head_sha },
      },
    ]);
  }
  const host = {
    repository: source.repository,
    runtime,
    runs: { read: async (id) => structuredClone(runs.get(id)) },
    request: async (url) => {
      if (url.includes("/artifacts?")) {
        const id = Number(url.match(/runs\/(\d+)\//u)[1]);
        return {
          artifacts: structuredClone(artifacts.get(id)),
          total_count: artifacts.get(id).length,
        };
      }
      if (url.includes("actions/publication/"))
        return url.includes(".wasm")
          ? null
          : { type: "file", sha: "4".repeat(40) };
      const caller = `.github/workflows/${url.includes("buildchain-recover") ? "buildchain-recover" : "buildchain"}.yml`;
      const bytes = Buffer.from(consumerWorkflows()[caller]);
      return {
        type: "file",
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
        sha: createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex"),
      };
    },
    client: {
      downloadArtifact: async (id, options) => {
        downloads.push(id);
        fs.cpSync(directories.get(id), options.path, { recursive: true });
        return { digestMismatch: false };
      },
    },
  };
  return { host, artifacts, runs, downloads, directories };
}
