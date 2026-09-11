import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDevDeliveryCandidateIdentity } from "../packages/core/dev-delivery/dev-delivery-candidate-identity.js";
import { devDeliveryCliOptions } from "../packages/core/dev-delivery/commands/dev-delivery-warrant-options.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = `sha256:${"1".repeat(64)}`;
const sourceIdentityRoot = `sha256:${"2".repeat(64)}`;


function sourceFixture(directory) {
  const cwd = path.join(directory, "consumer");
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "consumer-fixture", version: "1.0.0" }));
  fs.writeFileSync(path.join(cwd, "source.js"), "export const value = 1;\n");
  git("add", "package.json", "source.js");
  git("commit", "--quiet", "-m", "fixture base");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "source.js"), "export const value = 2;\n");
  git("add", "source.js");
  git("commit", "--quiet", "-m", "fixture candidate");
  return { cwd, base, head: git("rev-parse", "HEAD") };
}

test("canonical Work sourceRoot replaces the retired producer root pair", () => {
  const input = { pullRequestNumber: 7, sourceRoot, sourceIdentityRoot, deliveryClass: "non-native-fast" };
  const expected = { repository: "kungfu-systems/buildchain", protectedBase: "dev/v4/v4.0" };
  const identity = createDevDeliveryCandidateIdentity(input, expected, (value) => value);
  assert.equal(identity.sourceRoot, sourceRoot);
  assert.equal(Object.hasOwn(identity, "assignmentRoot"), false);
  assert.throws(() => createDevDeliveryCandidateIdentity({ ...input, assignmentRoot: sourceRoot }, expected, (value) => value), /sourceRoot alone/u);
});

test("workflow event transports sourceRoot without exposing a retired CLI pair", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-source-root-"));
  const eventPath = path.join(directory, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({ inputs: { "native-roots-json": JSON.stringify({ sourceRoot }) } }));
  assert.equal(devDeliveryCliOptions(["submit"], { GITHUB_EVENT_PATH: eventPath }).sourceRoot, sourceRoot);
  fs.rmSync(directory, { recursive: true, force: true });
});

for (const [largeProof, mismatchedRuntime, crlfPaths] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) test(`dev delivery request ${mismatchedRuntime ? "accepts independent runtime" : "binds exact candidate source"}${largeProof ? " with a proof above command-line limits" : ""}${crlfPaths ? " with CRLF Git output" : ""}`, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-request-"));
  const gh = path.join(directory, "gh");
  const payloadPath = path.join(directory, "payload.json");
  const availableWorkflow = "self-ops-dev-delivery.yml";
  let affectedPaths;
  if (largeProof) {
    affectedPaths = Array.from({ length: 6000 }, (_, index) => `packages/relocated-implementation/responsibility-${index}.js`);
    const proof = Object.fromEntries(["sourceIdentityRoot", "sourcePatchRoot", "planRoot", "closureRoot", "dependencyRoot", "toolchainRoot"].map((key) => [key, sourceIdentityRoot]));
    proof.affectedPaths = affectedPaths;
    const proofPath = path.join(directory, "proof.json");
    fs.writeFileSync(proofPath, JSON.stringify(proof));
    const node = path.join(directory, "node");
    fs.writeFileSync(node, `#!/bin/bash\nif [[ "$1" == *dev-delivery-source-proof-reuse.mjs ]]; then cat "${proofPath}"; else exec "${process.execPath}" "$@"; fi\n`);
    fs.chmodSync(node, 0o755);
  }
  const { cwd, head, base } = sourceFixture(directory);
  if (crlfPaths) {
    const gitExecutable = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(directory, "git"), `#!/bin/bash\nset -o pipefail\nif [[ "$1 $2" == "diff --name-only" ]]; then\n  "${gitExecutable}" "$@" | sed 's/\\r$//;s/$/\\r/'\nelse\n  exec "${gitExecutable}" "$@"\nfi\n`, { mode: 0o755 });
  }
  fs.writeFileSync(gh, `#!/bin/bash\ncase "$1 $2" in\n  "repo view") echo 'kungfu-systems/buildchain' ;;\n  "pr view") echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefName":"feature/candidate","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;\n  "api repos/kungfu-systems/buildchain/actions/runs/123") echo '{"conclusion":"success","event":"pull_request","head_sha":"${head}","path":".github/workflows/self-build-verify.yml@refs/pull/7/merge","pull_requests":[{"number":7,"base":{"sha":"${base}"}}]}' ;;\n  "api repos/kungfu-systems/buildchain/contents/.github/workflows/${availableWorkflow}?ref=dev/v4/v4.0") echo '{}' ;;\n  *) exit 1 ;;\nesac\n`);
  fs.writeFileSync(gh, fs.readFileSync(gh, "utf8").replace("  *) exit 1 ;;", `  "api --method") cat > "${payloadPath}" ;;\n  *) exit 1 ;;`));
  fs.chmodSync(gh, 0o755);
  const result = spawnSync("bash", ["-x", path.join(repositoryRoot, "packages/core/dev-delivery/commands/dev-delivery-request.sh"), "7", "--execute", "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", PATH: `${directory}:${process.env.PATH}`, BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot, BUILDCHAIN_RUNTIME_REF: mismatchedRuntime ? "train/v4/v4.1/repair" : "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).workflowId, availableWorkflow);
  assert.equal(JSON.parse(result.stdout).sourceHead, head);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.equal(payload.ref, "feature/candidate");
  assert.equal(payload.inputs["target-branch"], "dev/v4/v4.0");
  assert.equal(payload.inputs["runtime-ref"], mismatchedRuntime ? "train/v4/v4.1/repair" : "");
  assert.equal(payload.inputs["buildchain-ref"], undefined);
  if (largeProof) {
    assert.deepEqual(JSON.parse(payload.inputs["affected-paths-json"]), []);
    assert.ok(JSON.stringify(payload.inputs).length < 65535);
    assert.equal(payload.inputs["source-identity-root"], sourceIdentityRoot);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("dev delivery request rejects a phase-less owner before dispatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-recovery-"));
  const gh = path.join(directory, "gh");
  const node = path.join(directory, "node");
  const payloadPath = path.join(directory, "payload.json");
  const { cwd, head, base } = sourceFixture(directory);
  fs.writeFileSync(node, `#!/bin/bash
if [[ "$1" == *dev-delivery-warrant.mjs ]]; then
  echo '{"observation":{"stateRoot":"sha256:${"3".repeat(64)}","activeWarrant":{"pullRequestNumber":7,"sourceHead":"${head}","fencingToken":"sha256:${"4".repeat(64)}","generation":9}}}'
  exit 0
fi
exec "${process.execPath}" "$@"
`);
  fs.writeFileSync(gh, `#!/bin/bash
case "$1 $2" in
  "repo view") echo 'kungfu-systems/buildchain' ;;
  "pr view") echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefName":"feature/candidate","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;
  "api repos/kungfu-systems/buildchain/actions/runs/123") echo '{"conclusion":"success","event":"pull_request","head_sha":"${head}","path":".github/workflows/self-build-verify.yml@refs/pull/7/merge","pull_requests":[{"number":7,"base":{"sha":"${base}"}}]}' ;;
  "api repos/kungfu-systems/buildchain/contents/.github/workflows/self-ops-dev-delivery.yml?ref=dev/v4/v4.0") echo '{}' ;;
  "api --method") cat > "${payloadPath}" ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(node, 0o755);
  fs.chmodSync(gh, 0o755);
  const result = spawnSync("bash", ["-x", path.join(repositoryRoot, "packages/core/dev-delivery/commands/dev-delivery-request.sh"), "7", "--execute", "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "test-token", PATH: `${directory}:${process.env.PATH}`, BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must declare its current phase/u);
  assert.equal(fs.existsSync(payloadPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("dev delivery request cannot retire a phase-less merged attempt as cancellation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-merged-recovery-"));
  const gh = path.join(directory, "gh");
  const node = path.join(directory, "node");
  const payloadPath = path.join(directory, "payload.json");
  const settleArgsPath = path.join(directory, "settle-args.txt");
  const settledPath = path.join(directory, "settled");
  const { cwd, head, base } = sourceFixture(directory);
  const staleHead = "a".repeat(40);
  fs.writeFileSync(node, `#!/bin/bash
if [[ "$1" == *dev-delivery-warrant.mjs ]]; then
  if [ "$2" = "settle" ]; then
    printf '%s\\n' "$@" > "${settleArgsPath}"
    touch "${settledPath}"
    exit 0
  fi
  if [ -f "${settledPath}" ]; then
    echo '{"observation":{"stateRoot":"sha256:${"5".repeat(64)}","activeWarrant":null}}'
  else
    echo '{"observation":{"stateRoot":"sha256:${"3".repeat(64)}","activeWarrant":{"pullRequestNumber":6,"sourceHead":"${staleHead}","fencingToken":"sha256:${"4".repeat(64)}","generation":9}}}'
  fi
  exit 0
fi
exec "${process.execPath}" "$@"
`);
  fs.writeFileSync(gh, `#!/bin/bash
case "$1 $2" in
  "repo view") echo 'kungfu-systems/buildchain' ;;
  "pr view")
    case "$3" in
      7) echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefName":"feature/candidate","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;
      6) echo '{"state":"MERGED","headRefOid":"${staleHead}"}' ;;
      *) exit 1 ;;
    esac ;;
  "api repos/kungfu-systems/buildchain/actions/runs/123") echo '{"conclusion":"success","event":"pull_request","head_sha":"${head}","path":".github/workflows/self-build-verify.yml@refs/pull/7/merge","pull_requests":[{"number":7,"base":{"sha":"${base}"}}]}' ;;
  "api repos/kungfu-systems/buildchain/contents/.github/workflows/self-ops-dev-delivery.yml?ref=dev/v4/v4.0") echo '{}' ;;
  "api --method") cat > "${payloadPath}" ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(node, 0o755);
  fs.chmodSync(gh, 0o755);
  const result = spawnSync("bash", ["-x", path.join(repositoryRoot, "packages/core/dev-delivery/commands/dev-delivery-request.sh"), "7", "--execute", "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "test-token", PATH: `${directory}:${process.env.PATH}`, BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must declare its current phase/u);
  assert.equal(fs.existsSync(settleArgsPath), false);
  assert.equal(fs.existsSync(payloadPath), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
