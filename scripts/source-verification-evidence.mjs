import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { invokeV4DomainWasm } from "../packages/core/v4-domain-wasm.js";

const workflow = ".github/workflows/self-build-verify.yml";
const proofPath = ".buildchain/source-verification/evidence.json";
const hash = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
const execute = (command, args, encoding) =>
  execFileSync(command, args, {
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
const run = (command, args) => execute(command, args, "utf8").trim();
const git = (...args) => run("git", args);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export function verificationIdentity({
  env = process.env,
  command = run,
  revision = "HEAD",
} = {}) {
  const sourceSha = command("git", ["rev-parse", revision]);
  const sourceTree = command("git", ["rev-parse", `${revision}^{tree}`]);
  const bytes = (file) => execute("git", ["show", `${sourceSha}:${file}`]);
  const named = (files) =>
    hash(JSON.stringify(files.map((file) => [file, hash(bytes(file))])));
  for (const key of ["GITHUB_REPOSITORY", "ImageOS", "ImageVersion"])
    if (!env[key]) throw new Error(`verification identity requires ${key}`);
  return {
    repository: env.GITHUB_REPOSITORY,
    sourceSha,
    sourceTree,
    workflowRoot: hash(bytes(workflow)),
    checkDefinitionRoot: named([
      "package.json",
      ".buildchain/buildchain.toml",
      "scripts/source-verification-evidence.mjs",
      "scripts/verify-version-state-delta.mjs",
    ]),
    runtimeRoot: named([
      "packages/core/buildchain-v4-domain.wasm",
      "packages/core/v4-domain-wasm-artifact.js",
    ]),
    dependencyRoot: named([
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "crates/buildchain-v4-contracts/Cargo.lock",
      "crates/buildchain-v4-bridge/Cargo.lock",
    ]),
    toolchainRoot: hash(
      JSON.stringify([
        process.version,
        command("corepack", ["pnpm", "--version"]),
        command("go", ["version"]),
        command("rustc", ["+1.96.0", "--version"]),
        command("cargo", ["+1.96.0", "--version"]),
        command("rustc", ["--version"]),
        command("cargo", ["--version"]),
      ]),
    ),
    environmentRoot: hash(
      JSON.stringify([
        env.ImageOS,
        env.ImageVersion,
        process.platform,
        process.arch,
        ...[
          "CI",
          "NODE_ENV",
          "TZ",
          "LANG",
          "LC_ALL",
          "SOURCE_DATE_EPOCH",
          "BUILDCHAIN_SITE_GENERATED_AT",
          "BUILDCHAIN_SITE_PUBLISHED_AT",
          "BUILDCHAIN_SITE_TIMESTAMP_POLICY",
          "BUILDCHAIN_SOURCE_SHA",
          "RUSTUP_TOOLCHAIN",
          "RUSTFLAGS",
          "CARGO_ENCODED_RUSTFLAGS",
          "NODE_OPTIONS",
          "GOFLAGS",
          "GOTOOLCHAIN",
        ].map((key) => env[key] || ""),
      ]),
    ),
    platform:
      { linux: "linux", darwin: "macos", win32: "windows" }[process.platform] +
      `-${process.arch}`,
  };
}

export function planVerification(input) {
  return invokeV4DomainWasm("source-verification-plan", input);
}

export function sealVerification(input) {
  return invokeV4DomainWasm("source-verification-seal", input);
}

const api = (endpoint, binary = false) =>
  execute("gh", ["api", endpoint], binary ? undefined : "utf8");

// Only the one bounded proof file is read; archive paths are never extracted.
export function readProofArchive(archive, digest) {
  if (hash(archive) !== digest)
    throw new Error("artifact archive digest mismatch");
  const source = [
    "import io,json,sys,zipfile",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "entries=[e for e in z.infolist() if e.filename=='evidence.json']",
    "assert len(entries)==1 and entries[0].file_size <= 1048576, 'invalid proof archive'",
    "sys.stdout.buffer.write(z.read(entries[0]))",
  ].join("\n");
  return JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c", source],
      {
        input: archive,
        maxBuffer: 1048576,
        encoding: "utf8",
      },
    ),
  );
}

export async function discoverVerification({
  expected,
  evaluatedAtMs,
  fetchJson,
  fetchArchive,
}) {
  const prefix = `repos/${expected.repository}/actions`;
  const response = await fetchJson(
    `${prefix}/workflows/self-build-verify.yml/runs?event=merge_group&status=success&head_sha=${expected.sourceSha}&per_page=10`,
  );
  const reasons = [];
  for (const listed of response.workflow_runs || []) {
    try {
      const run = await fetchJson(`${prefix}/runs/${listed.id}`);
      if (
        run.repository?.full_name !== expected.repository ||
        run.head_sha !== expected.sourceSha ||
        run.path !== workflow ||
        run.event !== "merge_group" ||
        run.conclusion !== "success" ||
        run.status !== "completed"
      )
        throw new Error("untrusted evidence run");
      const assets = await fetchJson(
        `${prefix}/runs/${run.id}/artifacts?per_page=100`,
      );
      const matches = (assets.artifacts || []).filter(
        (a) =>
          a.name === `source-verification-${run.head_sha}-${run.run_attempt}`,
      );
      if (
        matches.length !== 1 ||
        matches[0].expired ||
        matches[0].size_in_bytes > 1048576
      )
        throw new Error("missing or expired proof artifact");
      const asset = matches[0];
      const candidate = readProofArchive(
        await fetchArchive(`${prefix}/artifacts/${asset.id}/zip`),
        asset.digest,
      );
      const decision = planVerification({
        expected,
        evaluatedAtMs,
        candidate,
        provider: {
          repository: run.repository.full_name,
          runId: String(run.id),
          runAttempt: run.run_attempt,
          headSha: run.head_sha,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          workflowPath: run.path,
          artifactDigest: asset.digest,
        },
      });
      if (decision.decision === "reuse")
        return { ...decision, sourceSha: expected.sourceSha };
      reasons.push(decision.reason);
    } catch {
      // Provider/transport or evidence failures are cache misses, never a green check.
      reasons.push("unavailable-or-invalid-evidence");
    }
  }
  return {
    decision: "execute",
    reason: reasons.join(",") || "missing-evidence",
  };
}

function output(decision) {
  write(".buildchain/source-verification/decision.json", decision);
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `decision=${decision.decision}\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Source verification: **${decision.decision}** (${decision.reason}).${decision.runId ? ` Original full execution: run ${decision.runId}, attempt ${decision.runAttempt}, proof ${decision.evidenceRoot}.` : ""}\n`,
    );
  console.log(JSON.stringify(decision));
}

function providerDiscovery(expected) {
  return discoverVerification({
    expected,
    evaluatedAtMs: Date.now(),
    fetchJson: async (endpoint) => JSON.parse(api(endpoint)),
    fetchArchive: async (endpoint) => api(endpoint, true),
  });
}

export async function planVersionProjection({
  baseSha,
  headSha,
  discover,
  regenerate,
}) {
  const proof = await discover(baseSha);
  if (proof.decision !== "reuse")
    return { decision: "execute", reason: "base-full-proof-unavailable" };
  const projection = await regenerate(baseSha, headSha);
  return {
    ...proof,
    decision: "projection",
    reason: "verified-base-and-exact-regenerated-version-delta",
    projection,
  };
}

async function planCurrentVerification() {
  if (git("status", "--porcelain", "--untracked-files=no"))
    throw new Error("dirty source");
  const event = process.env.GITHUB_EVENT_NAME;
  const headSha = git("rev-parse", "HEAD");
  if (
    event === "push" &&
    process.env.GITHUB_REF?.startsWith("refs/heads/dev/")
  ) {
    const exact = await providerDiscovery(verificationIdentity());
    if (exact.decision === "reuse") return exact;
  }
  if (!["pull_request", "merge_group", "push"].includes(event))
    return { decision: "execute", reason: "full-execution-required-for-event" };
  const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH));
  const baseSha =
    event === "merge_group"
      ? payload.merge_group?.base_sha
      : event === "pull_request"
        ? payload.pull_request?.base.sha
        : process.env.GITHUB_REF?.startsWith("refs/heads/dev/")
          ? payload.before
          : null;
  if (!/^[a-f0-9]{40}$/u.test(baseSha || ""))
    throw new Error("no exact protected base");
  return planVersionProjection({
    baseSha,
    headSha,
    discover: (revision) =>
      providerDiscovery(verificationIdentity({ revision })),
    regenerate: async (baseSha, headSha) => {
      const { verifyVersionStateDelta } =
        await import("./verify-version-state-delta.mjs");
      return verifyVersionStateDelta({
        baseSha,
        headSha,
        nodeModules: path.resolve(".buildchain/runtime/node_modules"),
      });
    },
  });
}

export async function main(mode) {
  if (mode === "plan") {
    try {
      output(await planCurrentVerification());
    } catch {
      output({
        decision: "execute",
        reason: "identity-provider-or-version-delta-unavailable",
      });
    }
  } else if (mode === "start") {
    write(".buildchain/source-verification/start.json", {
      identity: verificationIdentity(),
      startedAtMs: Date.now(),
    });
  } else if (mode === "seal") {
    if (process.env.GITHUB_EVENT_NAME !== "merge_group")
      throw new Error(
        "only merge-group full executions produce reusable proof",
      );
    const started = JSON.parse(
      fs.readFileSync(".buildchain/source-verification/start.json"),
    );
    if (
      git("status", "--porcelain", "--untracked-files=no") ||
      JSON.stringify(started.identity) !==
        JSON.stringify(verificationIdentity())
    )
      throw new Error(
        "source or verification identity changed during execution",
      );
    const completedAtMs = Date.now();
    write(
      proofPath,
      sealVerification({
        schema: "buildchain-v4-source-verification-evidence/v1",
        ...started,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        event: process.env.GITHUB_EVENT_NAME,
        validationKind: "full-source",
        exitCode: 0,
        completedAtMs,
        expiresAtMs: completedAtMs + 6 * 60 * 60 * 1000,
      }),
    );
  } else throw new Error(`unknown verification evidence mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
