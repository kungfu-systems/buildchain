import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDevDeliveryCandidateIdentity } from "../packages/core/dev-delivery-candidate-identity.js";
import { devDeliveryCliOptions } from "../scripts/dev-delivery-warrant-options.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = `sha256:${"1".repeat(64)}`;
const sourceIdentityRoot = `sha256:${"2".repeat(64)}`;

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

test("dev delivery request plans from only a PR number and machine source binding", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-request-"));
  const gh = path.join(directory, "gh");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  const base = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(gh, `#!/bin/bash\ncase "$1 $2" in\n  "repo view") echo 'kungfu-systems/buildchain' ;;\n  "pr view") echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;\n  "api repos/kungfu-systems/buildchain/actions/runs/123") echo '{"conclusion":"success","event":"pull_request","head_sha":"${head}","path":".github/workflows/self-build-verify.yml@refs/pull/7/merge","pull_requests":[{"number":7,"base":{"sha":"${base}"}}]}' ;;\n  "api repos/kungfu-systems/buildchain/contents/.github/workflows/self-ops-dev-delivery.yml?ref=dev/v4/v4.0") echo '{}' ;;\n  *) exit 1 ;;\nesac\n`);
  fs.chmodSync(gh, 0o755);
  const result = spawnSync("bash", [path.join(repositoryRoot, "scripts/dev-delivery-request.sh"), "7"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Buildchain dev delivery: plan PR #7");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("dev delivery request hides phase-less owner recovery inside Buildchain", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-recovery-"));
  const gh = path.join(directory, "gh");
  const node = path.join(directory, "node");
  const payloadPath = path.join(directory, "payload.json");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  const base = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
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
  "pr view") echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;
  "api repos/kungfu-systems/buildchain/actions/runs/123") echo '{"conclusion":"success","event":"pull_request","head_sha":"${head}","path":".github/workflows/self-build-verify.yml@refs/pull/7/merge","pull_requests":[{"number":7,"base":{"sha":"${base}"}}]}' ;;
  "api repos/kungfu-systems/buildchain/contents/.github/workflows/self-ops-dev-delivery.yml?ref=dev/v4/v4.0") echo '{}' ;;
  "api --method") cat > "${payloadPath}" ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(node, 0o755);
  fs.chmodSync(gh, 0o755);
  const result = spawnSync("bash", [path.join(repositoryRoot, "scripts/dev-delivery-request.sh"), "7", "--execute", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_TOKEN: "test-token", BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.deepEqual(JSON.parse(payload.inputs["legacy-active-owner-binding-json"]), {
    schema: "kungfu.buildchain.legacy-active-owner-binding/v1",
    stateRoot: `sha256:${"3".repeat(64)}`,
    fencingToken: `sha256:${"4".repeat(64)}`,
    generation: 9,
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("dev delivery request retires a phase-less attempt selected after its PR merged", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-merged-recovery-"));
  const gh = path.join(directory, "gh");
  const node = path.join(directory, "node");
  const payloadPath = path.join(directory, "payload.json");
  const settleArgsPath = path.join(directory, "settle-args.txt");
  const settledPath = path.join(directory, "settled");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
  const base = spawnSync("git", ["rev-parse", "HEAD^"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
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
      7) echo '{"number":7,"state":"OPEN","isDraft":false,"baseRefName":"dev/v4/v4.0","headRefOid":"${head}","headRepository":{"nameWithOwner":"kungfu-systems/buildchain"},"statusCheckRollup":[{"workflowName":"Verify","conclusion":"SUCCESS","detailsUrl":"https://github.com/kungfu-systems/buildchain/actions/runs/123/job/1","name":"check"}]}' ;;
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
  const result = spawnSync("bash", [path.join(repositoryRoot, "scripts/dev-delivery-request.sh"), "7", "--execute", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_TOKEN: "test-token", BUILDCHAIN_WORK_SOURCE_ROOT: sourceRoot },
  });
  assert.equal(result.status, 0, result.stderr);
  const settleArgs = fs.readFileSync(settleArgsPath, "utf8").split("\n");
  assert.ok(settleArgs.includes("cancelled"));
  assert.ok(settleArgs.includes("6"));
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  assert.equal(payload.inputs["legacy-active-owner-binding-json"], "");
  fs.rmSync(directory, { recursive: true, force: true });
});
