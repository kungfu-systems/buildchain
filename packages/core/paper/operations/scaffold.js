import {
  readJson,
  PAPER_PATHS,
  parsePaperVersion,
  paperConfig,
  resolvePaperRepository,
} from "../paper-repository.js";
import path from "node:path";
import { createBuildchainContractLock } from "../../contracts/buildchain-contract.js";
import { paperAgentEntryFiles } from "../paper-agent-entry.js";
import {
  scaffoldMakefile,
  scaffoldPackageJson,
  scaffoldReadme,
  scaffoldMap,
  scaffoldMainTex,
  managedPaperPackageJson,
  paperDependencyIgnore,
  createPaperScaffoldOperations,
} from "../paper-scaffold-content.js";
import {
  runtimeContractWorld,
  runtimeAcceptedAt,
  runtimeLicenseText,
  normalizePackageName,
  resolvePaperRuntimeGitSha,
  buildchainPackageIdentity,
} from "./runtime.js";
import { jsonText } from "./files.js";
import {
  scaffoldBuildWorkflow,
  scaffoldReleaseWorkflow,
  scaffoldVerifyWorkflow,
} from "./scaffold-workflows.js";
import { createPaperProvisioningAuthority } from "./provisioning.js";
import { scaffoldConfig } from "./scaffold-config.js";
import { paperPnpmWorkspace } from "./workspace.js";
import {
  DEFAULT_TOOLCHAIN_IMAGE,
  DEFAULT_TOOLCHAIN_DIGEST,
  DEFAULT_TOOLCHAIN_COMMAND,
  GIT_SHA_PATTERN,
  PAPER_MIGRATION_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
} from "./identity.js";
import { validateBuildchainConfig } from "../../consumer/buildchain-config.js";
import fs from "node:fs";
import { projectNextDevelopmentToml } from "../../release/next-development-projection.js";
import {
  paperChannels,
  bindPaperAuthority,
} from "../paper-runtime-channels.js";
export function scaffoldFiles({
  buildchainRoot,
  buildchainVersion,
  buildchainRef,
  buildchainSha,
  cwd,
  name,
  title,
  packageName,
  repository,
  version,
  siteBaseUrl,
}) {
  const contractWorld = runtimeContractWorld(buildchainRoot);
  const existingLock = readJson(
    path.resolve(cwd, PAPER_PATHS.contractLock),
  ).value;
  const acceptedAt =
    existingLock?.buildchain?.acceptedAt ||
    runtimeAcceptedAt(buildchainRoot, buildchainSha, buildchainVersion);
  const contractLock = createBuildchainContractLock({
    buildchainRef,
    resolvedSha: buildchainSha,
    contractWorld,
    acceptedAt,
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow("v4-alpha", {
    artifactName: name,
  });
  const releaseWorkflow = scaffoldReleaseWorkflow("v4-alpha", {
    artifactPaths: "_build/main.pdf",
    releasePassportProductName: title,
  });
  const verifyWorkflow = scaffoldVerifyWorkflow("v4-alpha");
  const agentEntry = paperAgentEntryFiles({
    cwd,
    buildchainVersion,
    buildchainSha,
    developmentRef: `dev/v${parsePaperVersion(version).major}/v${
      parsePaperVersion(version).major
    }.${parsePaperVersion(version).minor}`,
  });
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion,
    buildchainSha,
    contractLock: contractLockText,
    buildWorkflow,
    verifyWorkflow,
    releaseWorkflow,
    agentEntry: agentEntry.get(PAPER_PATHS.agentEntry),
    agentInstructions: agentEntry.get(PAPER_PATHS.agentInstructions),
  });
  const licenseText = runtimeLicenseText(buildchainRoot);
  const files = new Map([
    [
      PAPER_PATHS.config,
      scaffoldConfig({
        name,
        title,
        packageName,
        version,
        siteBaseUrl,
      }),
    ],
    [PAPER_PATHS.contractLock, contractLockText],
    [PAPER_PATHS.versionPin, `${buildchainVersion}\n`],
    [PAPER_PATHS.buildWorkflow, buildWorkflow],
    [PAPER_PATHS.verifyWorkflow, verifyWorkflow],
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.pnpmWorkspace, paperPnpmWorkspace("", buildchainVersion)],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
    ...agentEntry,
    [
      "Makefile",
      scaffoldMakefile({
        image: DEFAULT_TOOLCHAIN_IMAGE,
        digest: DEFAULT_TOOLCHAIN_DIGEST,
        command: DEFAULT_TOOLCHAIN_COMMAND,
      }),
    ],
    [
      "package.json",
      scaffoldPackageJson({
        name,
        packageName,
        repository,
        buildchainVersion,
      }),
    ],
    ["README.md", scaffoldReadme({ title, packageName })],
    ["docs/MAP.md", scaffoldMap()],
    ["paper/main.tex", scaffoldMainTex(title)],
    ["paper/references.bib", "% Add reviewed bibliography entries here.\n"],
    ["LICENSE", licenseText],
    [
      ".gitignore",
      "node_modules/\n_build/\n.buildchain/publication/\n.buildchain/release-state/\n.buildchain/release-evidence/\n.buildchain/paper/npm-bootstrap.json\n.buildchain/paper/npm-trust.json\n",
    ],
  ]);
  return finalizePaperEntryFiles({
    files,
    cwd,
    buildchainRoot,
    buildchainVersion,
    buildchainSha,
    contractLock,
    provisioningAuthority,
  });
}
export function migrationFiles({
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainSha,
  stableBuildchainRoot,
  alphaBuildchainRoot,
}) {
  const configResult = paperConfig(cwd);
  if (configResult.error) {
    throw new Error(
      `paper migration requires a valid publication config: ${configResult.error}`,
    );
  }
  validateBuildchainConfig(cwd, { requireLifecycleStages: ["verify"] });
  const config = configResult.loaded.config;
  const repository = resolvePaperRepository(cwd);
  if (!repository) {
    throw new Error(
      "paper migration requires an exact GitHub repository identity",
    );
  }
  const packageName = normalizePackageName(
    config.publish?.package || config.publish?.mainPackage || "",
    "paper publish package",
  );
  const runtimeSha =
    buildchainSha ||
    resolvePaperRuntimeGitSha(buildchainRoot, buildchainVersion);
  if (!GIT_SHA_PATTERN.test(runtimeSha)) {
    throw new Error("paper migration requires an exact Buildchain source SHA");
  }
  const runtimeIdentity = buildchainPackageIdentity(
    buildchainRoot,
    buildchainVersion,
  );
  if (!runtimeIdentity.version) {
    throw new Error(
      "paper migration requires an exact Buildchain package version",
    );
  }
  const existingLock = readJson(
    path.resolve(cwd, PAPER_PATHS.contractLock),
  ).value;
  const contractLock = migrationContractLock({
    buildchainRoot,
    existingLock,
    runtimeIdentity,
    runtimeSha,
  });
  const contractLockText = jsonText(contractLock);
  const buildWorkflow = scaffoldBuildWorkflow("v4-alpha", {
    artifactName: config.project.name,
  });
  const releaseWorkflow = scaffoldReleaseWorkflow("v4-alpha", {
    artifactPaths: config.publication.artifactPaths.join(","),
    releasePassportProductName: config.publication.title,
  });
  const verifyWorkflow = scaffoldVerifyWorkflow("v4-alpha");
  const agentEntry = paperAgentEntryFiles({
    cwd,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
  });
  const provisioningAuthority = createPaperProvisioningAuthority({
    repository,
    packageName,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
    contractLock: contractLockText,
    buildWorkflow,
    verifyWorkflow,
    releaseWorkflow,
    agentEntry: agentEntry.get(PAPER_PATHS.agentEntry),
    agentInstructions: agentEntry.get(PAPER_PATHS.agentInstructions),
  });
  const currentPackage = readJson(path.resolve(cwd, "package.json"));
  if (!currentPackage.exists || currentPackage.error || !currentPackage.value) {
    throw new Error("paper migration requires a valid package.json");
  }
  const packageJson = managedPaperPackageJson(
    currentPackage.value,
    runtimeIdentity.version,
  );
  const pnpmWorkspacePath = path.resolve(cwd, PAPER_PATHS.pnpmWorkspace);
  const pnpmWorkspace = paperPnpmWorkspace(
    fs.existsSync(pnpmWorkspacePath)
      ? fs.readFileSync(pnpmWorkspacePath, "utf8")
      : "",
    runtimeIdentity.version,
  );
  const files = new Map([
    [
      PAPER_PATHS.config,
      projectNextDevelopmentToml(
        fs.readFileSync(path.resolve(cwd, PAPER_PATHS.config), "utf8"),
      ),
    ],
    [PAPER_PATHS.contractLock, contractLockText],
    [PAPER_PATHS.versionPin, `${runtimeIdentity.version}\n`],
    [PAPER_PATHS.buildWorkflow, buildWorkflow],
    [PAPER_PATHS.verifyWorkflow, verifyWorkflow],
    [PAPER_PATHS.releaseWorkflow, releaseWorkflow],
    [PAPER_PATHS.pnpmWorkspace, pnpmWorkspace],
    [PAPER_PATHS.provisioningAuthority, jsonText(provisioningAuthority)],
    ...agentEntry,
    ["package.json", jsonText(packageJson)],
    [
      ".gitignore",
      paperDependencyIgnore(
        fs.existsSync(path.join(cwd, ".gitignore"))
          ? fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")
          : "",
      ),
    ],
  ]);
  return finalizePaperEntryFiles({
    files,
    cwd,
    buildchainRoot,
    buildchainVersion: runtimeIdentity.version,
    buildchainSha: runtimeSha,
    contractLock,
    provisioningAuthority,
    stableBuildchainRoot,
    alphaBuildchainRoot,
  });
}
export const {
  planPaperMigration,
  planPaperScaffold,
  writePaperMigration,
  writePaperScaffold,
} = createPaperScaffoldOperations({
  PAPER_MIGRATION_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
  GIT_SHA_PATTERN,
  buildchainPackageIdentity,
  migrationFiles,
  normalizePackageName,
  resolvePaperRuntimeGitSha,
  scaffoldFiles,
});

function migrationContractLock({
  buildchainRoot,
  existingLock,
  runtimeIdentity,
  runtimeSha,
}) {
  return createBuildchainContractLock({
    buildchainRef: "v4",
    resolvedSha: runtimeSha,
    contractWorld: runtimeContractWorld(buildchainRoot),
    acceptedAt:
      existingLock?.buildchain?.resolvedSha === runtimeSha
        ? existingLock.buildchain.acceptedAt
        : runtimeAcceptedAt(
            buildchainRoot,
            runtimeSha,
            runtimeIdentity.version,
          ),
  });
}

function finalizePaperEntryFiles({
  files,
  cwd,
  buildchainRoot,
  buildchainVersion,
  buildchainSha,
  contractLock,
  provisioningAuthority,
  stableBuildchainRoot,
  alphaBuildchainRoot,
}) {
  if (!buildchainVersion.startsWith("4."))
    throw new Error("Paper provisioning requires a Buildchain v4 runtime");
  const channelPlan = paperChannels({
    cwd,
    buildchainRoot,
    buildchainVersion: buildchainVersion,
    buildchainSha: buildchainSha,
    contractWorld: runtimeContractWorld(buildchainRoot),
    acceptedAt: contractLock.buildchain.acceptedAt,
    stableBuildchainRoot,
    alphaBuildchainRoot,
  });
  for (const channel of Object.values(channelPlan.channels))
    files.set(channel.lockPath, channel.content);
  for (const workflowPath of [
    PAPER_PATHS.buildWorkflow,
    PAPER_PATHS.verifyWorkflow,
  ]) {
    files.set(
      workflowPath,
      files
        .get(workflowPath)

        .replaceAll(
          ".buildchain/contract-lock.json",
          ".buildchain/alpha-contract-lock.json",
        ),
    );
  }
  const releaseWorkflow = files.get(PAPER_PATHS.releaseWorkflow);
  const releaseStart = releaseWorkflow.indexOf("  paper-release:\n");
  const releaseJob = releaseWorkflow.slice(releaseStart);
  const alphaJob = releaseJob
    .replace(
      "  paper-release:\n",
      "  paper-release-alpha:\n    if: ${{ startsWith(github.ref_name, 'alpha/') }}\n",
    )

    .replaceAll(
      ".buildchain/contract-lock.json",
      ".buildchain/alpha-contract-lock.json",
    );
  const stableJob = releaseJob
    .replace(
      "  paper-release:\n",
      "  paper-release:\n    if: ${{ startsWith(github.ref_name, 'release/') }}\n",
    )
    .replaceAll("@v4-alpha", "@v4");
  files.set(
    PAPER_PATHS.releaseWorkflow,
    `${releaseWorkflow.slice(0, releaseStart)}${alphaJob}\n${stableJob}`,
  );
  files.set(
    PAPER_PATHS.provisioningAuthority,
    jsonText(bindPaperAuthority(provisioningAuthority, channelPlan, files)),
  );
  return files;
}
