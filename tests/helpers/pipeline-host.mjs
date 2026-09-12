import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { identities, runtime } from "./business-attempt.mjs";
import { compileConsumerPlan } from "../../packages/core/consumer/contract/plan.js";
import { pipelineMaterials } from "../../packages/core/workflow/pipeline/materials.js";
import { materialDigest } from "../../packages/core/providers/github/discussions/materials.js";
import { createDevDeliveryQueue } from "../../packages/core/dev-delivery/dev-delivery-warrant.js";
import { recordDigest } from "../../packages/core/release/discussion/envelope.js";
import { controlPipeline } from "../../packages/core/workflow/pipeline/controller.js";
import { readBusinessAttempt } from "../../packages/core/workflow/attempt/reader.js";

export function pipelineHostFixture() {
  const f = identities(["admission", "build", "review", "warrant", "merge"]);
  const plan = compileConsumerPlan(
    readFileSync(
      new URL(
        "../../templates/minimal-consumer/npm/.buildchain/buildchain.toml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  let snapshot,
    commit = 0;
  const assets = new Map(),
    effects = [];
  const admission = {
    eligible: true,
    repositoryId: "R1",
    plan,
    protectedPlan: plan,
    protectedSource: f.source,
    route: {
      operation: "develop",
      to: f.intent.source.targetBranch,
      from: "feature/*",
    },
    live: {
      pullRequest: 23,
      source: f.source,
      observedHead: f.source.commit,
      targetBranch: f.intent.source.targetBranch,
      baseCommit: f.generation.baseCommit,
      state: "open",
      merged: false,
      draft: false,
      ready: false,
      routeEnabled: true,
    },
  };
  const queue = createDevDeliveryQueue({
    repository: f.intent.repository,
    protectedBase: f.intent.source.targetBranch,
  });
  const provider = {
    read: async () => (snapshot ? { snapshot, commit: String(commit) } : null),
    lookup: async () =>
      snapshot ? { snapshot, commit: String(commit) } : null,
    append: async (request) => {
      assert.equal(request.expectedCommit, commit ? String(commit) : "");
      snapshot = request.snapshot;
      commit++;
    },
  };
  const archive = {
    put: async (bytes) => {
      const id = assets.size + 1;
      assets.set(id, bytes);
      return { id, size: bytes.length, digest: materialDigest(bytes) };
    },
    read: async ({ id }) => assets.get(id),
  };
  let run = {
    id: 100,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
  };
  let build;
  const host = {
    repository: f.intent.repository,
    runtime,
    writer: f.writer,
    runId: 100,
    runAttempt: 1,
    selection: { source: { sha: f.source.commit } },
    provider,
    index: { retain: async () => {}, resolve: async () => ({ snapshot }) },
    source: {
      source: async () => ({ identity: admission.live.source, plan }),
      observe: async () => structuredClone(admission),
      observeIntent: async (_intent, generation) => {
        const result = structuredClone(admission);
        if (result.live.source.commit !== generation.source.commit)
          result.live.source = null;
        return result;
      },
    },
    runs: {
      read: async () => ({ run: structuredClone(run), jobs: [] }),
      completed: async () => structuredClone(run),
      build: async () => structuredClone(build),
    },
    policy: {
      observe: async () => ({
        review: false,
        checksPassing: true,
        root: recordDigest("policy"),
      }),
    },
    delivery: () => ({ read: async () => structuredClone(queue), service: {} }),
    prepareDelivery: async ({ current }) => ({
      "pipeline-attempt": current.identity.id,
      "expected-head-sha": current.generation.source.commit,
    }),
    materialStore: (session) =>
      pipelineMaterials(archive, {
        repository: f.intent.repository,
        attempt: session.observed.history.at(-1).identity,
      }),
    project: async () => effects.push("project"),
    wake: async (attempt) => effects.push({ wake: attempt }),
    request: async (url, options) => {
      if (url.endsWith("/pulls/23"))
        return {
          base: { ref: f.intent.source.targetBranch },
          state: admission.live.state,
        };
      if (url.endsWith("/check-runs")) {
        effects.push(options.body);
        return { id: 12 };
      }
      throw new Error(url);
    },
  };
  const event = (action = "opened") =>
    controlPipeline(
      "pull_request",
      {
        repository: { full_name: host.repository },
        action,
        pull_request: { number: 23 },
      },
      { "config-path": f.source.configPath },
      host,
    );
  const wake = () =>
    controlPipeline(
      "repository_dispatch",
      {
        repository: { full_name: host.repository },
        action: "buildchain-attempt-wake",
        client_payload: { attempt: readBusinessAttempt(snapshot).attempt },
      },
      { "config-path": f.source.configPath },
      host,
    );
  return {
    f,
    host,
    admission,
    effects,
    event,
    wake,
    snapshot: () => snapshot,
    observed: () => readBusinessAttempt(snapshot),
    complete: () => {
      run = { ...run, status: "completed", conclusion: "success" };
    },
    build: (context) => {
      const body = {
        schema: "buildchain.pipeline-build-readback/v1",
        source: context.source,
        runId: 100,
        runAttempt: 1,
        jobs: context.platforms.map(({ platform }) => ({
          name: `Build product (${platform})`,
        })),
        outcome: "success",
      };
      build = { ...body, root: recordDigest(body) };
    },
  };
}
