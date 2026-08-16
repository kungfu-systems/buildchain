import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  V4_PUBLICATION_REHEARSAL_CORE_VERSION,
  createV4PublicationRehearsalAuthority,
  createV4PublicationRehearsalCapsule,
  executeV4PublicationRehearsal,
  resolveV4PublicationRehearsalProviderBindings,
  validateV4PublicationRehearsalCapsule,
  verifyV4PublicationRehearsalCapsule,
} from "../packages/core/v4-publication-rehearsal.js";
import {
  compileReleaseTailDeclaration,
  releaseTailRoot,
} from "../packages/core/release-tail-provider-plane.js";
import { normalizeBuildchainConfig } from "../packages/core/buildchain-config.js";
import {
  parseWorkflowDocument,
  parseYamlUses,
} from "../packages/core/workflow-yaml-contract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function fixture(name = "fixture") {
  const candidateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `buildchain-v4-publication-rehearsal-${name}-`),
  );
  const declaration = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/fixtures/release-tail-capabilities-v1/kungfu-alpha.json",
      ),
      "utf8",
    ),
  );
  const contents = {
    "artifacts/product.bin": Buffer.from("portable-product\n"),
    "config/buildchain.toml": Buffer.from(
      'schema = 1\n[publication_rehearsal]\neffect_default = "disabled"\n',
    ),
    "manifests/candidate.json": Buffer.from(
      `${JSON.stringify({ schema: "fixture.candidate/v1", sourceSha: "b".repeat(40) })}\n`,
    ),
    "documents/release-activation.json": Buffer.from(
      '{"schema":"fixture.release-activation/v1"}\n',
    ),
    "documents/signed-channel.json": Buffer.from(
      '{"schema":"fixture.signed-channel/v1"}\n',
    ),
    "evidence/qualification.json": Buffer.from(
      '{"schema":"fixture.qualification/v1"}\n',
    ),
    "manifests/release-passport.json": Buffer.from(
      '{"schema":"fixture.release-passport/v1"}\n',
    ),
  };
  const roles = {
    "artifacts/product.bin": "installable-product",
    "config/buildchain.toml": "buildchain-config",
    "documents/release-activation.json": "release-activation-document",
    "documents/signed-channel.json": "signed-channel-document",
    "evidence/qualification.json": "qualification-evidence",
    "manifests/candidate.json": "candidate-manifest",
    "manifests/release-passport.json": "release-passport",
  };
  const files = Object.entries(contents)
    .map(([relative, bytes]) => {
      const destination = path.join(candidateRoot, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      return {
        role: roles[relative],
        path: relative,
        size: bytes.length,
        root: digest(bytes),
      };
    })
    .sort((left, right) =>
      Buffer.from(left.path).compare(Buffer.from(right.path)),
    );
  const binding = (relative) => ({
    path: relative,
    root: files.find((entry) => entry.path === relative).root,
  });
  const providerBindings = {
    schema: "kungfu.buildchain.release-tail.provider-bindings/v1",
    artifacts: {
      "installable-product": {
        path: "artifacts/product.bin",
        name: "product.bin",
      },
      "release-passport": {
        path: "manifests/release-passport.json",
        name: "release-passport.json",
      },
    },
    documents: {
      "release.activate": {
        path: "documents/release-activation.json",
        method: "PUT",
      },
      "signed-channel.commit": {
        path: "documents/signed-channel.json",
        method: "PUT",
      },
    },
    evidence: {
      inputs: ["evidence/qualification.json"],
      output: "generated/released-evidence.json",
    },
  };
  const capsule = createV4PublicationRehearsalCapsule({
    source: {
      repository: "kungfu-systems/buildchain",
      revision: "bc12cd0ff18a7e1d918777ea093c169349952d34",
    },
    declaration,
    manifest: binding("manifests/candidate.json"),
    config: binding("config/buildchain.toml"),
    providerBindings,
    files,
  });
  return { candidateRoot, declaration, files, providerBindings, capsule };
}

function expectedObservations(capsule) {
  return capsule.transaction.operations.map((operation) => ({
    operationId: operation.operationId,
    readbacks: [
      {
        outcome: "absent",
        subjectRoot: "",
        targetRoot: "",
        evidenceRoots: [],
        providerCode: "fixture-absent",
      },
      {
        outcome: "observed",
        subjectRoot: operation.effect.subjectRoot,
        targetRoot: operation.effect.targetRoot,
        evidenceRoots: [operation.effect.targetRoot],
        providerCode: "fixture-observed",
      },
    ],
    apply: {
      outcome: "applied",
      code: "fixture-applied",
      classification: "none",
    },
  }));
}

function withObservations(input) {
  return createV4PublicationRehearsalCapsule({
    source: input.capsule.source,
    declaration: input.declaration,
    transaction: input.capsule.transaction,
    manifest: input.capsule.manifest,
    config: input.capsule.config,
    providerBindings: input.capsule.providerBindings,
    files: input.files,
    providerPolicy: input.capsule.providerPolicy,
    expectedObservations: expectedObservations(input.capsule),
  });
}

test("rooted parity matrix binds the exact v3 and v4 heads and separates Stage Capsules", () => {
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "architecture/v4-publication-rehearsal-parity.json",
      ),
      "utf8",
    ),
  );
  const matrixRoot = matrix.matrixRoot;
  delete matrix.matrixRoot;
  assert.equal(releaseTailRoot(matrix), matrixRoot);
  assert.equal(
    matrix.source.commit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(
    matrix.target.commit,
    "bc12cd0ff18a7e1d918777ea093c169349952d34",
  );
  assert.equal(
    matrix.sharedProductionCore.version,
    V4_PUBLICATION_REHEARSAL_CORE_VERSION,
  );
  assert.equal(matrix.stageCapsuleBoundary.publicationAuthority, false);
  assert.equal(matrix.matrix.length, 9);
});

test("capsule schema and runtime bind every publication rehearsal identity", () => {
  const input = fixture("schema");
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/v4-publication-rehearsal-capsule-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const releaseTailSchema = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        "contracts/release-tail-capabilities-v1.schema.json",
      ),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(releaseTailSchema);
  const validate = ajv.compile(schema);
  assert.equal(validate(input.capsule), true, JSON.stringify(validate.errors));
  assert.equal(input.capsule.schema, V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT);
  assert.equal(
    input.capsule.transaction.planRoot,
    compileReleaseTailDeclaration(input.declaration).planRoot,
  );
  assert.equal(input.capsule.providerPolicy.effectDefault, "disabled");
  assert.equal(
    input.capsule.providerBindingsRoot,
    releaseTailRoot(input.capsule.providerBindings),
  );
  assert.equal(
    verifyV4PublicationRehearsalCapsule({
      capsule: input.capsule,
      candidateRoot: input.candidateRoot,
    }).capsuleRoot,
    input.capsule.capsuleRoot,
  );
});

test("simulation and replay use the same production release-tail planner and core", async () => {
  const input = fixture("shared-core");
  const simulated = await executeV4PublicationRehearsal({
    capsule: input.capsule,
    candidateRoot: input.candidateRoot,
    mode: "simulate",
  });
  assert.equal(simulated.transaction.state, "complete");
  assert.equal(simulated.evidence.productionAuthority, false);
  assert.equal(simulated.evidence.releasePassport, null);
  assert.equal(simulated.evidence.coreVersion, "buildchain.release-tail/v1");

  const replayCapsule = withObservations(input);
  const replayed = await executeV4PublicationRehearsal({
    capsule: replayCapsule,
    candidateRoot: input.candidateRoot,
    mode: "replay",
  });
  assert.equal(replayed.transaction.state, "complete");
  assert.equal(replayed.evidence.truth, "recorded-replay");
  assert.equal(replayed.evidence.productionAuthority, false);
  assert.equal(replayed.evidence.releasePassport, null);
});

test("provider rehearsal requires exact capsule-bound authority and records request/readback", async () => {
  const input = fixture("provider");
  const capsule = withObservations(input);
  const expected = new Map(
    capsule.expectedObservations.entries.map((entry) => [
      entry.operationId,
      { entry, index: 0 },
    ]),
  );
  const state = new Set();
  const adapters = Object.fromEntries(
    capsule.declaration.capabilities.map((capability) => [
      capability.adapter,
      {
        async readback(effect) {
          const record = expected.get(effect.operationId);
          const response = structuredClone(
            record.entry.readbacks[record.index],
          );
          record.index += 1;
          return response;
        },
        async apply(effect) {
          state.add(effect.operationId);
        },
      },
    ]),
  );
  await assert.rejects(
    () =>
      executeV4PublicationRehearsal({
        capsule,
        candidateRoot: input.candidateRoot,
        mode: "provider",
        adapters,
      }),
    (error) => error.code === "invalid-publication-rehearsal-shape",
  );
  const authority = createV4PublicationRehearsalAuthority(capsule, {
    authorizationRoot: digest("explicit-live-provider-rehearsal-authority"),
  });
  const result = await executeV4PublicationRehearsal({
    capsule,
    candidateRoot: input.candidateRoot,
    mode: "provider",
    adapters,
    authority,
  });
  assert.equal(state.size, capsule.transaction.operationOrder.length);
  assert.equal(result.evidence.authorityRoot, authority.authorityRoot);
  assert.equal(authority.providerBindingsRoot, capsule.providerBindingsRoot);
  assert.equal(
    result.evidence.providerBindingsRoot,
    capsule.providerBindingsRoot,
  );
  assert.equal(result.evidence.productionAuthority, false);
  assert.equal(result.evidence.releasePassport, null);
  assert.deepEqual(
    new Set(result.evidence.transcript.map(({ method }) => method)),
    new Set(["readback", "apply"]),
  );
  assert.ok(
    result.evidence.transcript.every(({ requestRoot }) =>
      /^sha256:[0-9a-f]{64}$/u.test(requestRoot),
    ),
  );
});

test("capsule, source, candidate, manifest, config, policy, observations and core drift fail closed", () => {
  const input = fixture("tamper");
  const cases = [
    [
      "capsule",
      (value) => (value.capsuleRoot = `sha256:${"0".repeat(64)}`),
      "capsule-root-mismatch",
    ],
    [
      "source",
      (value) => (value.source.revision = "0".repeat(40)),
      "source-root-mismatch",
    ],
    [
      "candidate",
      (value) => (value.candidate.root = `sha256:${"0".repeat(64)}`),
      "candidate-root-mismatch",
    ],
    [
      "manifest",
      (value) => (value.manifest.root = `sha256:${"0".repeat(64)}`),
      "manifest-root-mismatch",
    ],
    [
      "config",
      (value) => (value.config.root = `sha256:${"0".repeat(64)}`),
      "config-root-mismatch",
    ],
    [
      "provider bindings payload",
      (value) =>
        (value.providerBindings.artifacts["installable-product"].name =
          "different.bin"),
      "provider-bindings-root-mismatch",
    ],
    [
      "provider bindings root",
      (value) => (value.providerBindingsRoot = `sha256:${"0".repeat(64)}`),
      "provider-bindings-root-mismatch",
    ],
    [
      "provider policy",
      (value) => (value.providerPolicy.root = `sha256:${"0".repeat(64)}`),
      "provider-policy-root-mismatch",
    ],
    [
      "expected observations",
      (value) => (value.expectedObservations.root = `sha256:${"0".repeat(64)}`),
      "expected-observation-root-mismatch",
    ],
    [
      "core version",
      (value) => (value.coreVersion = "buildchain.release-tail/v2"),
      "core-version",
    ],
  ];
  for (const [label, mutate, code] of cases) {
    const tampered = structuredClone(input.capsule);
    mutate(tampered);
    assert.throws(
      () => validateV4PublicationRehearsalCapsule(tampered),
      (error) => error.code.includes(code),
      label,
    );
  }
  fs.appendFileSync(
    path.join(input.candidateRoot, input.capsule.config.path),
    "tamper\n",
  );
  assert.throws(
    () =>
      verifyV4PublicationRehearsalCapsule({
        capsule: input.capsule,
        candidateRoot: input.candidateRoot,
      }),
    (error) => error.code === "publication-rehearsal-file-tampered",
  );
});

test("provider bindings reject unbound and escaping paths before adapter effects", async () => {
  const input = fixture("provider-binding-negative");
  const createWithBindings = (providerBindings) =>
    createV4PublicationRehearsalCapsule({
      source: input.capsule.source,
      declaration: input.declaration,
      transaction: input.capsule.transaction,
      manifest: input.capsule.manifest,
      config: input.capsule.config,
      providerBindings,
      files: input.files,
      providerPolicy: input.capsule.providerPolicy,
    });
  const invalid = [
    (value) =>
      (value.artifacts["installable-product"].path = "artifacts/missing.bin"),
    (value) =>
      (value.documents["release.activate"].path = "documents/missing.json"),
    (value) => (value.evidence.inputs = ["evidence/missing.json"]),
  ];
  for (const mutate of invalid) {
    const bindings = structuredClone(input.providerBindings);
    mutate(bindings);
    assert.throws(
      () => createWithBindings(bindings),
      (error) =>
        error.code === "publication-rehearsal-provider-binding-file-missing",
    );
  }
  const unordered = structuredClone(input.providerBindings);
  unordered.artifacts = Object.fromEntries(
    Object.entries(unordered.artifacts).reverse(),
  );
  assert.throws(
    () => createWithBindings(unordered),
    (error) => error.code === "unordered-publication-rehearsal-values",
  );
  for (const escaped of ["/tmp/request.json", "../request.json"]) {
    const bindings = structuredClone(input.providerBindings);
    bindings.documents["release.activate"].path = escaped;
    assert.throws(
      () => createWithBindings(bindings),
      (error) => error.code === "invalid-publication-rehearsal-path",
    );
  }
  for (const escaped of ["/tmp/evidence.json", "../evidence.json"]) {
    const bindings = structuredClone(input.providerBindings);
    bindings.evidence.output = escaped;
    assert.throws(
      () => createWithBindings(bindings),
      (error) => error.code === "invalid-publication-rehearsal-path",
    );
  }

  const capsule = withObservations(input);
  const authority = createV4PublicationRehearsalAuthority(capsule, {
    authorizationRoot: digest("provider-binding-negative-authority"),
  });
  let adapterEffects = 0;
  const adapters = Object.fromEntries(
    capsule.declaration.capabilities.map(({ adapter }) => [
      adapter,
      {
        async readback() {
          adapterEffects += 1;
          throw new Error("adapter must not be reached");
        },
        async apply() {
          adapterEffects += 1;
        },
      },
    ]),
  );
  const external = structuredClone(capsule.providerBindings);
  external.documents["release.activate"].path = "documents/signed-channel.json";
  assert.throws(
    () =>
      resolveV4PublicationRehearsalProviderBindings({
        capsule,
        candidateRoot: input.candidateRoot,
        providerBindings: external,
      }),
    (error) =>
      error.code === "publication-rehearsal-provider-bindings-root-mismatch",
  );
  assert.equal(adapterEffects, 0);

  fs.writeFileSync(
    path.join(input.candidateRoot, "documents/release-activation.json"),
    '{"schema":"replacement-request/v1"}\n',
  );
  await assert.rejects(
    () =>
      executeV4PublicationRehearsal({
        capsule,
        candidateRoot: input.candidateRoot,
        mode: "provider",
        authority,
        adapters,
      }),
    (error) => error.code === "publication-rehearsal-file-tampered",
  );
  assert.equal(adapterEffects, 0);
});

test("provider binding symlink input and output escapes fail before adapters", async () => {
  const input = fixture("provider-binding-symlink");
  const capsule = withObservations(input);
  const authority = createV4PublicationRehearsalAuthority(capsule, {
    authorizationRoot: digest("provider-binding-symlink-authority"),
  });
  let adapterEffects = 0;
  const adapters = Object.fromEntries(
    capsule.declaration.capabilities.map(({ adapter }) => [
      adapter,
      {
        async readback() {
          adapterEffects += 1;
        },
        async apply() {
          adapterEffects += 1;
        },
      },
    ]),
  );
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-provider-outside-"),
  );
  const outsideRequest = path.join(outside, "request.json");
  fs.writeFileSync(outsideRequest, '{"schema":"outside-request/v1"}\n');
  const requestPath = path.join(
    input.candidateRoot,
    "documents/release-activation.json",
  );
  fs.unlinkSync(requestPath);
  fs.symlinkSync(outsideRequest, requestPath);
  await assert.rejects(
    () =>
      executeV4PublicationRehearsal({
        capsule,
        candidateRoot: input.candidateRoot,
        mode: "provider",
        authority,
        adapters,
      }),
    (error) => error.code === "publication-rehearsal-file-missing",
  );
  assert.equal(adapterEffects, 0);

  const outputInput = fixture("provider-binding-output-symlink");
  const outputParent = path.join(outputInput.candidateRoot, "generated");
  fs.symlinkSync(outside, outputParent, "dir");
  assert.throws(
    () =>
      resolveV4PublicationRehearsalProviderBindings({
        capsule: outputInput.capsule,
        candidateRoot: outputInput.candidateRoot,
      }),
    (error) => error.code === "publication-rehearsal-path-escape",
  );
  assert.equal(adapterEffects, 0);
});

test("offline vector is byte-identical on linux, macos and windows projections", async () => {
  const input = fixture("portable");
  const roots = [];
  for (const platform of ["linux", "macos", "windows"]) {
    const result = await executeV4PublicationRehearsal({
      capsule: input.capsule,
      candidateRoot: input.candidateRoot,
      mode: "simulate",
    });
    roots.push({
      platform,
      capsuleRoot: result.evidence.capsuleRoot,
      transactionRoot: result.evidence.transactionRoot,
      stateRoot: result.evidence.stateRoot,
      evidenceRoot: result.evidence.evidenceRoot,
    });
  }
  assert.equal(new Set(roots.map(({ capsuleRoot }) => capsuleRoot)).size, 1);
  assert.equal(
    new Set(roots.map(({ transactionRoot }) => transactionRoot)).size,
    1,
  );
  assert.equal(new Set(roots.map(({ stateRoot }) => stateRoot)).size, 1);
  assert.equal(new Set(roots.map(({ evidenceRoot }) => evidenceRoot)).size, 1);
});

test("CLI and config expose the same effect-disabled rehearsal projection", () => {
  const config = normalizeBuildchainConfig({
    schema: 1,
    publication_rehearsal: {
      contract: V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
      capsule_path: "capsule.json",
      candidate_root: "candidate",
      state_path: ".buildchain/publication-rehearsal/state.json",
      evidence_path: ".buildchain/publication-rehearsal/evidence.json",
      effect_default: "disabled",
    },
  }).publication_rehearsal;
  assert.equal(config.effectDefault, "disabled");
  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        publication_rehearsal: {
          contract: V4_PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
          capsule_path: "capsule.json",
          candidate_root: "candidate",
          state_path: "state.json",
          evidence_path: "evidence.json",
          effect_default: "enabled",
        },
      }),
    /effect_default = disabled/u,
  );

  const cli = fs.readFileSync(
    path.join(repositoryRoot, "scripts/release-tail.mjs"),
    "utf8",
  );
  assert.match(cli, /executeV4PublicationRehearsal/u);
  assert.match(cli, /simulate or replay/u);
});

test("repo-local prepublication dogfood resolves the current reusable and exact runtime", () => {
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, ".github/workflows/release-tail.yml"),
    "utf8",
  );
  const dogfood = fs.readFileSync(
    path.join(
      repositoryRoot,
      ".github/workflows/v4-publication-rehearsal-dogfood.yml",
    ),
    "utf8",
  );
  const caller = parseWorkflowDocument(dogfood);
  const callee = parseWorkflowDocument(workflow);
  assert.deepEqual(caller.triggers, ["pull_request", "workflow_dispatch"]);
  assert.equal(caller.callJobs.length, 1);
  const [call] = caller.callJobs;
  assert.equal(call.uses, "./.github/workflows/release-tail.yml");
  assert.deepEqual(call.with["buildchain-ref"], {
    kind: "expression",
    value: "${{ github.event.pull_request.head.sha || github.sha }}",
  });
  assert.equal(call.with["rehearsal-mode"].value, "simulate");

  const declared = new Map(
    callee.interface.inputs.map((entry) => [entry.name, entry]),
  );
  assert.equal(callee.interface.reusable, true);
  for (const [name, supplied] of Object.entries(call.with)) {
    const input = declared.get(name);
    assert.ok(input, `caller input ${name} is declared by the local reusable`);
    assert.ok(
      supplied.kind === "expression" || supplied.kind === input.type,
      `caller input ${name} matches reusable type ${input.type}`,
    );
  }
  for (const input of callee.interface.inputs.filter((entry) => entry.required))
    assert.ok(
      input.name in call.with,
      `required input ${input.name} is supplied`,
    );

  const workflowUses = parseYamlUses(workflow).map((entry) => entry.value);
  assert.ok(
    workflowUses.includes(
      "./.buildchain/release-tail-runtime/actions/release-tail",
    ),
  );
  const durableExternalCaller = fs.readFileSync(
    path.join(
      repositoryRoot,
      ".github/workflows/v4-public-consumer-dogfood.yml",
    ),
    "utf8",
  );
  assert.ok(
    parseYamlUses(durableExternalCaller).some((entry) =>
      entry.value.endsWith(
        "/.github/workflows/v4-stage-capsule-canary.yml@v4-alpha",
      ),
    ),
    "external public consumers retain the floating v4-alpha selector",
  );
});

test("checked-in release-tail Action executes the dogfood capsule without authority", () => {
  const outputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-v4-publication-action-"),
  );
  const outputPath = path.join(outputRoot, "github-output.txt");
  fs.writeFileSync(outputPath, "");
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "actions/release-tail/dist/index.js")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        "INPUT_REHEARSAL-CAPSULE":
          "contracts/fixtures/v4-publication-rehearsal-v1/capsule.json",
        "INPUT_CANDIDATE-ROOT": path.join(
          repositoryRoot,
          "contracts/fixtures/v4-publication-rehearsal-v1/candidate",
        ),
        "INPUT_REHEARSAL-MODE": "simulate",
        "INPUT_STATE-PATH": path.join(outputRoot, "state.json"),
        "INPUT_REHEARSAL-EVIDENCE-PATH": path.join(outputRoot, "evidence.json"),
        GITHUB_OUTPUT: outputPath,
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(
    fs.readFileSync(path.join(outputRoot, "evidence.json"), "utf8"),
  );
  assert.equal(evidence.truth, "simulation-only");
  assert.equal(evidence.productionAuthority, false);
  assert.equal(evidence.releasePassport, null);
  assert.match(
    fs.readFileSync(outputPath, "utf8"),
    /rehearsal-evidence-root<<ghadelimiter_/u,
  );
});
