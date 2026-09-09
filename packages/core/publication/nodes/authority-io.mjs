import fs from "node:fs";
import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";

const authorityRoot = ".buildchain/authority-runtime";
const outputRoot = ".buildchain/publication-authority";
export function filesNamed(root, name) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}
export function oneEvidenceFile(root, name) {
  const files = filesNamed(root, name);
  requireValue(
    files.length === 1,
    `Expected exactly one ${name} under ${root}, found ${files.length}`,
  );
  return files[0];
}
export function authorityOutputs(values, env = process.env) {
  requireValue(
    Object.values(values).every((value) => !/[\r\n]/.test(String(value))),
    "Authority scalar outputs must not contain line breaks",
  );
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}
export function resolveControllerEvidence(env) {
  const file = oneEvidenceFile(
    ".buildchain/publication-evidence/passport",
    "release-candidate-passport.json",
  );
  const passport = JSON.parse(fs.readFileSync(file, "utf8"));
  requireValue(
    Array.isArray(passport.controllerReceipts) &&
      passport.controllerReceipts.length === 1,
    "Publication evidence requires exactly one qualifying controller receipt reference",
  );
  const artifact = passport.controllerReceipts[0].artifact;
  requireValue(
    typeof artifact === "string" && Boolean(artifact.trim()),
    "Release-candidate passport controller receipt artifact is missing",
  );
  authorityOutputs({ "controller-artifact": artifact }, env);
}
export function auditGovernance(env, execute = command) {
  const repository = env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_REPOSITORY;
  const targetRef = env.BUILDCHAIN_GITHUB_GOVERNANCE_EXPECTED_TARGET_REF;
  requireValue(
    Boolean(repository) && Boolean(targetRef),
    "Live GitHub governance verification requires an exact repository and target ref",
  );
  fs.mkdirSync(outputRoot, { recursive: true });
  execute(process.execPath, [
    `${authorityRoot}/packages/core/governance/commands/audit-github-governance.mjs`,
    "--organization",
    repository.split("/")[0],
    "--repository",
    repository,
    "--target-ref",
    targetRef,
    "--source-revision",
    env.BUILDCHAIN_AUTHORITY_REF,
    "--ttl-minutes",
    "15",
    "--output",
    `${outputRoot}/github-governance-audit.json`,
    "--require-qualifying",
  ]);
}
export function controlPlaneArguments(input, kind) {
  requireValue(
    ["candidate", "artifact", "binary"].includes(kind),
    "Unknown publication control-plane audit kind",
  );
  const defaults = {
    candidate: ".github/workflows/public-release-promote.yml",
    artifact: ".github/workflows/public-release-paper.yml",
    binary: ".github/workflows/.release-binary-assets.yml",
  };
  const args = [
    `${authorityRoot}/packages/core/governance/commands/audit-publication-control-plane.mjs`,
  ];
  const mapping = {
    repository: "evidence-repository",
    "workflow-repository": "buildchain-repository",
    branch: "target-ref",
    "source-sha": "source-sha",
    "workflow-ref": "buildchain-ref",
    "publisher-workflow": "publisher-workflow-path",
    "required-status-check": "required-status-check",
  };
  for (const [key, field] of Object.entries(mapping))
    args.push(`--${key}`, input[field] || "");
  args.push(
    "--workflow",
    input["authority-workflow-path"] || defaults[kind],
    "--job",
    kind === "candidate" ? "apply" : "publish",
    "--environment",
    kind === "binary" ? "buildchain-release-assets" : "none",
  );
  if (kind === "binary")
    args.push(
      "--publication-version",
      input["publication-version"],
      "--allow-release-reconciliation",
      "--environment-ref",
      `v${input["publication-version"]}`,
      "--environment-ref-type",
      "tag",
      "--publisher-mode",
      "github-token",
    );
  else {
    args.push("--package", input["package-name"] || "");
    if (kind === "candidate")
      args.push(
        "--publisher-mode",
        input["publication-target"].startsWith("github-release:")
          ? "github-token"
          : "npm-trusted-publisher",
      );
  }
  return [...args, "--output", `${outputRoot}/auto/control-plane.json`];
}
export function auditControlPlane(env, kind, execute = command) {
  const args = controlPlaneArguments(
    JSON.parse(env.BUILDCHAIN_AUTHORITY_REQUEST_JSON),
    kind,
  );
  fs.mkdirSync(`${outputRoot}/auto`, { recursive: true });
  execute(process.execPath, args);
}
export function recordAuthorityDryRun() {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(
    `${outputRoot}/capability.json`,
    JSON.stringify({
      schemaVersion: 1,
      contract: "kungfu-buildchain-publication-capability-dry-run",
      decision: "dry-run",
    }) + "\n",
  );
}
export function exportAuthorityResult(env) {
  const value = JSON.parse(
    fs.readFileSync(`${outputRoot}/capability.json`, "utf8"),
  );
  const gatePath = `${outputRoot}/gate-aggregate.json`;
  const gate = fs.existsSync(gatePath)
    ? JSON.parse(fs.readFileSync(gatePath, "utf8"))
    : null;
  authorityOutputs(
    {
      "capability-json": JSON.stringify(value),
      "capability-digest": value.capabilityDigest || "",
      "gate-aggregate-json": gate ? JSON.stringify(gate) : "",
      "gate-aggregate-digest": gate?.digest || "",
    },
    env,
  );
}
