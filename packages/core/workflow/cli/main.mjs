import { initializeCliRuntime } from "../../contracts/cli/context.mjs";
import { BUILDCHAIN_USAGE } from "../commands/buildchain-cli-help.mjs";
import { formatCliHelp } from "../../contracts/cli-reference.js";
import {
  TRUST_RELEASE_COMMANDS,
  dispatchTrustReleaseCommand,
} from "../../release/cli/trust-release.mjs";
import { dispatchRegisteredCommand } from "../../contracts/command-registry.mjs";
import { handleAdopterDeliveryCommand } from "../../adoption/cli/dispatch.mjs";
import { handleKfdCommand } from "../../adoption/cli/kfd.mjs";
import {
  handleInitCommand,
  handleValidateCommand,
} from "../../adoption/cli/project.mjs";
import { handlePortableCacheCommand } from "../../build/cli/cache.mjs";
import { handleFactsCommand } from "../../build/cli/facts.mjs";
import { handleHomebrewCommand } from "../../build/cli/homebrew.mjs";
import {
  handleBuildContractCommand,
  handleLifecycleCommand,
} from "../../build/cli/lifecycle.mjs";
import { handleInfraContractCommand } from "../../consumer/cli/infrastructure.mjs";
import {
  handleHelpCommand,
  handleLayoutCommand,
  handleVersionCommand,
} from "../../contracts/cli/introspection.mjs";
import { handleDevCommand } from "../../dev-delivery/cli/dispatch.mjs";
import {
  handleArchitectureCommand,
  handleGitHubGovernanceCommand,
  handleReleaseGovernanceCommand,
} from "../../governance/cli/dispatch.mjs";
import { handleDoctorCommand } from "../../governance/cli/doctor.mjs";
import { handleCandidateCommand } from "../../observability/cli/candidate.mjs";
import { handleDiagnosticsCommand } from "../../observability/cli/diagnostics.mjs";
import {
  handleLogCommand,
  handleMarkCommand,
  handleSpanCommand,
} from "../../observability/cli/events.mjs";
import { handleSampleCommand } from "../../observability/cli/process-sample.mjs";
import { handlePaperCommand } from "../../paper/cli/dispatch.mjs";
import {
  handleNpmCommand,
  handlePublicationArtifactCommand,
  handlePublishSourceCommand,
} from "../../publication/cli/dispatch.mjs";
import {
  handleNextDevelopmentCommand,
  handleReleasePropagationCommand,
  handleReleaseTailCommand,
  handleTailResealCommand,
  handleTrustReleaseCommand,
} from "../../release/cli/dispatch.mjs";
import { handleBadgesCommand } from "../../web/cli/badges.mjs";
import { handleWebSurfaceCommand } from "../../web/cli/surface.mjs";

export async function main(argv = process.argv.slice(2)) {
  const helpIndex = argv.findIndex(
    (entry) => entry === "--help" || entry === "-h",
  );
  if (helpIndex >= 0) {
    process.stdout.write(
      formatCliHelp({
        usageText: BUILDCHAIN_USAGE,
        pathParts: argv.slice(0, helpIndex),
      }),
    );
    return;
  }
  const [command = "help", ...args] = argv;
  return dispatchRegisteredCommand({
    command,
    args,
    handlers: BUILDCHAIN_COMMAND_HANDLERS,
  });
}

export const BUILDCHAIN_COMMAND_HANDLERS = Object.freeze({
  help: handleHelpCommand,
  version: handleVersionCommand,
  layout: handleLayoutCommand,
  "portable-cache": handlePortableCacheCommand,
  candidate: handleCandidateCommand,
  init: handleInitCommand,
  validate: handleValidateCommand,
  doctor: handleDoctorCommand,
  dev: handleDevCommand,
  log: handleLogCommand,
  diagnostics: handleDiagnosticsCommand,
  facts: handleFactsCommand,
  kfd: handleKfdCommand,
  sample: handleSampleCommand,
  mark: handleMarkCommand,
  span: handleSpanCommand,
  lifecycle: handleLifecycleCommand,
  npm: handleNpmCommand,
  ...Object.fromEntries(
    [...TRUST_RELEASE_COMMANDS].map((command) => [
      command,
      (args) => handleTrustReleaseCommand(args, { command }),
    ]),
  ),
  "web-surface": handleWebSurfaceCommand,
  "infra-contract": handleInfraContractCommand,
  "publication-artifact": handlePublicationArtifactCommand,
  paper: handlePaperCommand,
  "release-propagation": handleReleasePropagationCommand,
  "release-governance": handleReleaseGovernanceCommand,
  "release-tail": handleReleaseTailCommand,
  "tail-reseal": handleTailResealCommand,
  "next-development": handleNextDevelopmentCommand,
  "github-governance": handleGitHubGovernanceCommand,
  badges: handleBadgesCommand,
  homebrew: handleHomebrewCommand,
  "build-contract": handleBuildContractCommand,
  "publish-source": handlePublishSourceCommand,
  architecture: handleArchitectureCommand,
  "adopter-delivery": handleAdopterDeliveryCommand,
});

export async function runCli(entryUrl, argv = process.argv.slice(2)) {
  try {
    initializeCliRuntime(entryUrl);
    await main(argv);
  } catch (error) {
    console.error(`buildchain: ${error.message}`);
    process.exitCode = 1;
  }
}
