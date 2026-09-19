import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { signedPublicationFixture } from "./helpers/pipeline-publication-signed.mjs";
import {
  canonicalJson,
  recordDigest,
} from "../packages/core/release/discussion/envelope.js";
import {
  consumerWorkflows,
  PIPELINE_ENTRY,
} from "../packages/core/consumer/contract/entries.js";
import { planPipelinePublication } from "../packages/core/publication/pipeline/plan.js";
import { pipelineReleaseEvidence } from "../packages/core/publication/pipeline/documents.js";
import { preparePipelineSigning } from "../packages/core/publication/pipeline/signing.js";
import { readPipelineStableProducts } from "../packages/core/publication/pipeline/stable-products.js";

const issuedAt = "2026-09-13T00:00:00.000Z";
function rooted(value) {
  const { root, ...body } = value;
  return { ...body, root: recordDigest(body) };
}
function asset(id, name, bytes) {
  return {
    id,
    name,
    state: "uploaded",
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes,
  };
}

async function fixture(t) {
  const job = {
    id: 201,
    run_id: 200,
    run_attempt: 1,
    name: "Build publication (linux-x64)",
    status: "completed",
    conclusion: "success",
    completed_at: "2026-09-12T23:59:50Z",
  };
  const f = await signedPublicationFixture(t, { jobs: [job], issuedAt });
  const { plan: alphaPlan } = f.context;
  const qualified = f.retained.qualified;
  const contract = f.f.admission.plan;
  const plan = planPipelinePublication({
    ...alphaPlan,
    contract,
    version: alphaPlan.version,
    source: { ...qualified.source, commit: "8".repeat(40) },
    intentSource: qualified.source,
    route: contract.channels[2],
  });
  const candidate = {
    id: 7,
    tag: alphaPlan.tag,
    sha: qualified.source.commit,
    tree: qualified.source.tree,
    publishedAt: "2026-09-13T00:01:00Z",
  };
  const source = rooted({
    schema: "buildchain.pipeline-stable-source/v1",
    planRoot: plan.root,
    contractRoot: plan.contractRoot,
    source: qualified.source,
    candidate,
  });
  const evidence = pipelineReleaseEvidence({
    plan: alphaPlan,
    qualified,
    capsules: f.retained.capsules,
    documents: f.retained.documents,
    bundle: Buffer.from("injected signature bundle"),
  });
  const state = {
    assets: [
      ...evidence.map(({ name, bytes }, index) =>
        asset(index + 1, name, bytes),
      ),
      asset(
        10,
        "buildchain.release.json",
        Buffer.from(`${canonicalJson(f.retained.documents.passport)}\n`),
      ),
    ],
    jobs: [
      job,
      {
        id: 202,
        run_id: 200,
        run_attempt: 1,
        name: "Qualify and sign products",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-09-13T00:00:30Z",
      },
    ],
    calls: [],
    signatures: 0,
  };
  const repository = f.host.repository;
  const caller = ".github/workflows/buildchain.yml";
  const callerBytes = Buffer.from(
    consumerWorkflows("v4", qualified.source.configPath)[caller],
  );
  const run = {
    id: 200,
    run_attempt: 1,
    head_sha: qualified.build.providerSource,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    path: caller,
    event: "repository_dispatch",
    status: "completed",
    conclusion: "failure",
    referenced_workflows: [
      {
        path: `kungfu-systems/buildchain/${PIPELINE_ENTRY}@v4`,
        sha: "2".repeat(40),
      },
      {
        path: `kungfu-systems/buildchain/${alphaPlan.publisher.workflow}@v4`,
        sha: alphaPlan.publisher.workflowSha,
      },
    ],
  };
  const host = {
    repository,
    token: "fixture",
    async request(endpoint, options = {}) {
      assert.equal(options.method || "GET", "GET");
      state.calls.push(endpoint);
      if (
        endpoint ===
        `/repos/${repository}/releases/7/assets?per_page=100&page=1`
      )
        return state.assets.map(({ bytes, ...value }) =>
          structuredClone(value),
        );
      assert.equal(
        endpoint,
        `/repos/${repository}/contents/${caller}?ref=${run.head_sha}`,
      );
      return {
        type: "file",
        encoding: "base64",
        size: callerBytes.length,
        sha: createHash("sha1")
          .update(`blob ${callerBytes.length}\0`)
          .update(callerBytes)
          .digest("hex"),
        content: callerBytes.toString("base64"),
      };
    },
    runs: {
      async read(id, attempt) {
        assert.equal(id, 200);
        assert.equal(attempt, 1);
        return { run: structuredClone(run), jobs: structuredClone(state.jobs) };
      },
    },
    github: {
      rest: {
        repos: {
          async getReleaseAsset(input) {
            assert.equal(`${input.owner}/${input.repo}`, repository);
            assert.equal(input.headers.accept, "application/octet-stream");
            return {
              data: state.assets.find(({ id }) => id === input.asset_id).bytes,
            };
          },
        },
      },
    },
  };
  const prepared = preparePipelineSigning({
    ...f.context,
    qualified,
    directory: path.join(f.root, "public-evidence-signature"),
    evaluatedAt: issuedAt,
  });
  const execute = (command, args) => {
    state.signatures++;
    assert.equal(command, "gh");
    for (const [flag, expected] of [
      ["--repo", repository],
      ["--signer-digest", alphaPlan.publisher.workflowSha],
      ["--source-digest", qualified.build.providerSource],
      ["--predicate-type", prepared.predicateType],
    ])
      assert.equal(args[args.indexOf(flag) + 1], expected);
    assert.ok(args.includes("--deny-self-hosted-runners"));
    return JSON.stringify([
      {
        verificationResult: {
          statement: {
            predicateType: prepared.predicateType,
            predicate: prepared.predicate,
            subject: [{ digest: { sha256: prepared.subjectDigest } }],
          },
        },
      },
    ]);
  };
  return { f, plan, source, host, state, execute, run };
}

function changeDocument(state, name, mutate) {
  const index = state.assets.findIndex(
    (value) => value.name === `buildchain.${name}.json`,
  );
  const current = state.assets[index],
    value = JSON.parse(current.bytes);
  const changed = mutate(value) || value;
  state.assets[index] = asset(
    current.id,
    current.name,
    Buffer.from(`${canonicalJson(changed)}\n`),
  );
}

test("Stable product qualification verifies published bytes, signature and actual original jobs without renewing historical authority", async (t) => {
  const f = await fixture(t);
  assert.ok(
    Date.parse(f.f.retained.qualified.qualification.expiresAt) < Date.now(),
  );
  const result = await readPipelineStableProducts(f.plan, f.source, f.host, {
    execute: f.execute,
  });
  assert.equal(result.root, rooted(result).root);
  assert.equal(result.canary.candidateSha, f.source.candidate.sha);
  assert.equal(result.canary.completedAt, "2026-09-13T00:00:30.000Z");
  assert.equal(result.canary.status, "success");
  assert.equal(result.alphaPlanRoot, f.f.context.plan.root);
  assert.equal(result.assets.length, 6);
  assert.equal(f.state.signatures, 1);
  // A later failed follow-up does not erase exact successful signed builds.
  assert.equal(f.run.conclusion, "failure");
});

test("new evidence contains the immutable plan while historical transactions retain their original bytes", async (t) => {
  const f = await fixture(t),
    { plan } = f.f.context;
  const input = {
    plan,
    ...f.f.retained,
    bundle: Buffer.from("injected signature bundle"),
  };
  const current = pipelineReleaseEvidence(input);
  const { evidenceVersion, ...old } = plan;
  const historical = pipelineReleaseEvidence({ ...input, plan: rooted(old) });
  assert.deepEqual(
    historical,
    current.filter(({ id }) => id !== "plan"),
  );
  assert.deepEqual(
    JSON.parse(current.find(({ id }) => id === "plan").bytes),
    plan,
  );
  assert.throws(
    () =>
      pipelineReleaseEvidence({
        ...input,
        plan: rooted({ ...plan, evidenceVersion: 2 }),
      }),
    /Unsupported/,
  );
});

test("missing published plans remain missing qualification rather than successful canaries", async (t) => {
  const f = await fixture(t);
  f.state.assets = f.state.assets.filter(
    ({ name }) => name !== "buildchain.plan.json",
  );
  assert.deepEqual(
    await readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    {
      status: "missing",
      missing: ["buildchain.plan.json"],
    },
  );
  assert.equal(f.state.signatures, 0);
});

test("rehashed public documents cannot substitute their source, publisher, outputs, signature or Passport", async (t) => {
  const f = await fixture(t),
    original = f.state.assets;
  for (const [label, name, mutate, pattern] of [
    [
      "source",
      "qualification",
      (v) => rooted({ ...v, source: { ...v.source, commit: "0".repeat(40) } }),
      /exact Alpha/,
    ],
    [
      "publisher",
      "plan",
      (v) =>
        rooted({
          ...v,
          publisher: { ...v.publisher, repository: "example/attacker" },
        }),
      /central publisher/,
    ],
    [
      "outputs",
      "qualification",
      (v) => rooted({ ...v, artifacts: [] }),
      /every declared output/,
    ],
    [
      "signature",
      "plan",
      (v) =>
        rooted({ ...v, runtime: { ...v.runtime, commit: "0".repeat(40) } }),
      /differ|plan/,
    ],
    [
      "Passport",
      "release",
      (v) => ({ ...v, signingRoot: `sha256:${"0".repeat(64)}` }),
      /Passport/,
    ],
    [
      "invocation",
      "invocation",
      (v) => ({ ...v, candidate: { ...v.candidate, tree: "0".repeat(40) } }),
      /invocation/,
    ],
  ])
    await t.test(label, async () => {
      f.state.assets = [...original];
      changeDocument(f.state, name, mutate);
      await assert.rejects(
        readPipelineStableProducts(f.plan, f.source, f.host, {
          execute: f.execute,
        }),
        pattern,
      );
    });
  f.state.assets = original;
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: () => {
        throw new Error("signature rejected");
      },
    }),
    /signature rejected/,
  );
});

test("provider readback rejects ambiguous assets, corrupted bytes and changed successful jobs", async (t) => {
  const f = await fixture(t),
    original = f.state.assets;
  f.state.assets = [...original, { ...original[0], id: 99 }];
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /ambiguous/,
  );
  f.state.assets = original.map((value, index) =>
    index ? value : { ...value, bytes: Buffer.from("corrupt") },
  );
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /provider bytes/,
  );
  f.state.assets = original;
  f.state.jobs[0] = { ...f.state.jobs[0], conclusion: "failure" };
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /job changed/,
  );
});

test("source substitution fails before provider access even with a recomputed observation root", async (t) => {
  const f = await fixture(t);
  const source = rooted({
    ...f.source,
    candidate: { ...f.source.candidate, sha: "0".repeat(40) },
  });
  await assert.rejects(
    readPipelineStableProducts(f.plan, source, f.host),
    /admitted source/,
  );
  assert.deepEqual(f.state.calls, []);
});

test("public product evidence reads every asset page and rejects a changing asset inventory", async (t) => {
  const f = await fixture(t),
    request = f.host.request;
  let reads = 0;
  f.host.request = async (endpoint, options) => {
    if (endpoint.includes("/releases/7/assets?")) {
      reads++;
      if (endpoint.endsWith("page=1"))
        return Array.from({ length: 100 }, (_, index) => ({
          id: 1000 + index,
          name: `product-${index}`,
        }));
      assert.ok(endpoint.endsWith("page=2"));
      return f.state.assets.map(({ bytes, ...value }) => value);
    }
    return request(endpoint, options);
  };
  assert.equal(
    (
      await readPipelineStableProducts(f.plan, f.source, f.host, {
        execute: f.execute,
      })
    ).canary.status,
    "success",
  );
  assert.equal(reads, 4);
  f.host.request = async (endpoint, options) => {
    if (endpoint.includes("/releases/7/assets?")) {
      reads++;
      return f.state.assets.map(({ bytes, ...value }, index) =>
        reads === 6 && index === 0 ? { ...value, id: 999 } : value,
      );
    }
    return request(endpoint, options);
  };
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /changed during provider readback/,
  );
});

test("a valid signature cannot substitute another provider signing job or publisher definition", async (t) => {
  const f = await fixture(t);
  const signer = f.state.jobs[1];
  f.state.jobs.push({ ...signer, id: 999 });
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /exact successful provider job/,
  );
  f.state.jobs.pop();
  f.run.referenced_workflows[1].sha = "0".repeat(40);
  await assert.rejects(
    readPipelineStableProducts(f.plan, f.source, f.host, {
      execute: f.execute,
    }),
    /exact successful provider job/,
  );
});
