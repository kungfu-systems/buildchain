import fs from "node:fs";
import path from "node:path";
import {
  createBuildchainContractLock,
  createBuildchainContractWorld,
  finalizeBuildchainContractWorld,
  readBuildchainContractWorld,
  sha256Json,
} from "./buildchain-contract.js";
import {
  gitValue,
  readJson,
  sha256Text,
  stableJson,
} from "./paper-repository.js";

export const PAPER_ALPHA_LOCK = ".buildchain/alpha-contract-lock.json";

function fileDigestMatches(cwd, relative, digest) {
  if (!relative || !/^sha256:[0-9a-f]{64}$/.test(digest || "")) return false;
  const absolute = path.resolve(cwd, relative);
  return (
    fs.existsSync(absolute) &&
    sha256Text(fs.readFileSync(absolute, "utf8")) === digest
  );
}

function workflowErrors(cwd, authority, workflow) {
  if (!workflow?.path || !workflow?.sourceDigest)
    return ["paper workflow authority is incomplete"];
  if (!fileDigestMatches(cwd, workflow.path, workflow.sourceDigest))
    return [`paper workflow source digest mismatch: ${workflow.path}`];
  const floating = /^v4(?:-alpha)?$/.test(authority.runtime?.ref || "");
  const refs = floating
    ? workflow.reusablePath === ".github/workflows/paper-release-sealed.yml"
      ? ["v4-alpha", "v4"]
      : ["v4-alpha"]
    : [authority.runtime.resolvedSha];
  const text = fs.readFileSync(path.resolve(cwd, workflow.path), "utf8");
  const errors = [];
  if (
    refs.some(
      (ref) =>
        !text.includes(
          `uses: ${authority.runtime.repository}/${workflow.reusablePath}@${ref}\n`,
        ),
    )
  )
    errors.push(
      `paper workflow reusable source is not exact: ${workflow.path}`,
    );
  if (
    (floating || workflow.reusablePath !== ".github/workflows/check.yml") &&
    refs.some((ref) => !text.includes(`buildchain-ref: ${ref}\n`))
  )
    errors.push(`paper workflow runtime input is not exact: ${workflow.path}`);
  if (
    floating &&
    [
      ...text.matchAll(/uses:\s*kungfu-systems\/buildchain\/[^\s@]+@([^\s]+)/g),
    ].some((match) => !refs.includes(match[1]))
  )
    errors.push(
      `paper workflow contains an unaccepted Buildchain selector: ${workflow.path}`,
    );
  return errors;
}

function channelLockMatches(cwd, authority, ref, expectedPath) {
  const channel = authority.admission?.channels?.[ref];
  const lock = readJson(path.resolve(cwd, expectedPath)).value;
  const entry = readJson(
    path.resolve(cwd, ".buildchain/paper/agent-entry.json"),
  ).value;
  return (
    channel?.ref === ref &&
    channel?.lockPath === expectedPath &&
    fileDigestMatches(cwd, expectedPath, channel?.lockDigest) &&
    lock?.buildchain?.ref === ref &&
    lock?.buildchain?.resolvedSha === channel?.resolvedSha &&
    lock?.buildchain?.majorLine === "v4" &&
    entry?.runtime?.channels?.[ref] === channel?.resolvedSha
  );
}

export function paperProvisioningWorkflowErrors(cwd, authority) {
  const errors = [
    authority.workflows?.build,
    authority.workflows?.verify,
    authority.workflows?.release,
  ].flatMap((workflow) => workflowErrors(cwd, authority, workflow));
  if (
    !fileDigestMatches(
      cwd,
      authority.admission?.contractLockPath || ".buildchain/contract-lock.json",
      authority.admission?.contractLockDigest,
    )
  )
    errors.push("paper contract lock bytes differ from provisioning authority");
  if (/^v4(?:-alpha)?$/.test(authority.runtime?.ref || "")) {
    for (const [ref, lockPath] of [
      ["v4", ".buildchain/contract-lock.json"],
      ["v4-alpha", PAPER_ALPHA_LOCK],
    ]) {
      if (!channelLockMatches(cwd, authority, ref, lockPath))
        errors.push(
          `paper ${ref} contract lock is not bound to provisioning authority`,
        );
    }
  }
  return errors;
}

export function paperRuntimeSourceMatches(runtime, sha, mode, admission) {
  return (
    runtime?.sourceSha === sha ||
    (mode === "ci" &&
      /^4\./.test(runtime?.version || "") &&
      ([runtime?.channels?.v4, runtime?.channels?.["v4-alpha"]].includes(sha) ||
        (admission?.compatible === true &&
          admission.sha === sha &&
          /^v4(?:-alpha)?$/.test(admission.ref))))
  );
}

export function selectPaperRuntime(runtime, authority) {
  const channel = Object.values(authority?.admission?.channels || {}).find(
    (entry) => entry.resolvedSha === runtime.resolvedSha,
  );
  const ref =
    channel?.ref || (runtime.version.includes("-") ? "v4-alpha" : "v4");
  return authority?.admission?.channels?.[ref] ? { ...runtime, ref } : runtime;
}

export function paperRuntimeLockPath(cwd, runtime, authority) {
  return path.resolve(
    cwd,
    authority?.admission?.channels?.[runtime.ref]?.lockPath ||
      ".buildchain/contract-lock.json",
  );
}

function channelWorld(root, ref, current) {
  if (current) return current;
  const sha = gitValue(root, [
    "rev-parse",
    "--verify",
    `refs/tags/${ref}^{commit}`,
  ]);
  const text =
    sha &&
    gitValue(root, ["show", `${sha}:dist/site/buildchain-contract.json`]);
  if (!/^[0-9a-f]{40}$/.test(sha) || !text) {
    throw new Error(
      `Paper migration needs the fetched ${ref} tag or an explicit ${ref === "v4" ? "stable" : "alpha"} Buildchain root`,
    );
  }
  const published = JSON.parse(text);
  const world = Array.isArray(published.compatibilityFacts)
    ? finalizeBuildchainContractWorld(published)
    : {
        ...published,
        contractDigest: `sha256:${sha256Json({ ...published, contractDigest: undefined, compatibilityDigest: undefined })}`,
        compatibilityDigest: `sha256:${sha256Json({ schemaVersion: published.schemaVersion, contract: published.contract, majorLine: published.majorLine, surfaces: published.surfaces.map(({ id, kind, breakingDigest }) => ({ id, kind, breakingDigest })) })}`,
      };
  if (
    published.contractDigest !== world.contractDigest ||
    published.compatibilityDigest !== world.compatibilityDigest
  ) {
    throw new Error(`Paper ${ref} contract digest mismatch`);
  }
  return {
    sha,
    world,
    acceptedAt: gitValue(root, ["show", "-s", "--format=%cI", sha]),
  };
}

function explicitWorld(root, ref) {
  const sha = gitValue(root, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("Paper channel root must have exact Git provenance");
  if (gitValue(root, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("Paper channel root must have committed runtime bytes");
  const pkg = readJson(path.join(root, "package.json")).value;
  if (
    pkg?.name !== "@kungfu-tech/buildchain" ||
    !/^4\./.test(pkg?.version || "") ||
    pkg.version.includes("-") !== (ref === "v4-alpha")
  )
    throw new Error(`Paper channel root does not belong to ${ref}`);
  const contractPath = path.join(root, "dist/site/buildchain-contract.json");
  return {
    sha,
    world: fs.existsSync(contractPath)
      ? readBuildchainContractWorld(contractPath)
      : createBuildchainContractWorld({ root }),
    acceptedAt: gitValue(root, ["show", "-s", "--format=%cI", sha]),
  };
}

export function paperV4Channels({
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainSha,
  contractWorld,
  acceptedAt,
  stableBuildchainRoot = "",
  alphaBuildchainRoot = "",
}) {
  const selectedRef = buildchainVersion.includes("-") ? "v4-alpha" : "v4";
  const current = {
    sha: buildchainSha,
    world: contractWorld,
    acceptedAt,
  };
  const channels = {};
  for (const [ref, lockPath, explicitRoot] of [
    ["v4", ".buildchain/contract-lock.json", stableBuildchainRoot],
    ["v4-alpha", PAPER_ALPHA_LOCK, alphaBuildchainRoot],
  ]) {
    const resolved = explicitRoot
      ? explicitWorld(explicitRoot, ref)
      : channelWorld(buildchainRoot, ref, ref === selectedRef ? current : null);
    if (resolved.world.majorLine !== "v4")
      throw new Error(`Paper ${ref} contract must belong to v4`);
    const existing = readJson(path.join(cwd, lockPath)).value;
    const lock = createBuildchainContractLock({
      buildchainRef: ref,
      resolvedSha: resolved.sha,
      contractWorld: resolved.world,
      acceptedAt:
        existing?.buildchain?.resolvedSha === resolved.sha
          ? existing.buildchain.acceptedAt
          : new Date(resolved.acceptedAt).toISOString(),
    });
    const content = `${JSON.stringify(lock, null, 2)}\n`;
    channels[ref] = {
      ref,
      resolvedSha: resolved.sha,
      lockPath,
      lockDigest: sha256Text(content),
      content,
    };
  }
  return { selectedRef, channels };
}

export function bindPaperV4Authority(authority, channelPlan, files) {
  const { selectedRef, channels } = channelPlan;
  const entryPath = authority.agentEntry.policyPath;
  const entry = JSON.parse(files.get(entryPath));
  entry.runtime.channels = Object.fromEntries(
    Object.entries(channels).map(([ref, channel]) => [
      ref,
      channel.resolvedSha,
    ]),
  );
  const { entryDigest: _entryDigest, ...entryPayload } = entry;
  entry.entryDigest = sha256Text(stableJson(entryPayload));
  files.set(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
  authority.agentEntry.policyDigest = sha256Text(files.get(entryPath));
  authority.runtime.ref = selectedRef;
  authority.admission.acceptedRef = selectedRef;
  authority.admission.contractLockPath = channels[selectedRef].lockPath;
  authority.admission.contractLockDigest = channels[selectedRef].lockDigest;
  authority.admission.channels = Object.fromEntries(
    Object.entries(channels).map(([ref, { content: _content, ...channel }]) => [
      ref,
      channel,
    ]),
  );
  for (const [role, workflow] of Object.entries(authority.workflows)) {
    workflow.reusableRef = role === "release" ? "v4" : "v4-alpha";
    workflow.reusableRefs =
      role === "release" ? ["v4", "v4-alpha"] : ["v4-alpha"];
    workflow.sourceDigest = sha256Text(files.get(workflow.path));
  }
  const { authorityDigest: _authorityDigest, ...payload } = authority;
  authority.authorityDigest = sha256Text(stableJson(payload));
  return authority;
}
