import { PAPER_PATHS } from "../paper-repository.js";
import {
  consumerAgentInstructions,
  consumerConfiguration,
} from "../../adoption/consumer-init.js";
import { consumerWorkflows } from "../../consumer/contract/entries.js";
import {
  scaffoldMakefile,
  scaffoldPackageJson,
  scaffoldReadme,
  scaffoldMap,
  scaffoldMainTex,
  createPaperScaffoldOperations,
} from "../paper-scaffold-content.js";
import {
  runtimeLicenseText,
  normalizePackageName,
  buildchainPackageIdentity,
} from "./runtime.js";
import {
  DEFAULT_TOOLCHAIN_IMAGE,
  DEFAULT_TOOLCHAIN_DIGEST,
  DEFAULT_TOOLCHAIN_COMMAND,
  GIT_SHA_PATTERN,
  PAPER_MIGRATION_CONTRACT,
  PAPER_SCAFFOLD_CONTRACT,
} from "./identity.js";
import { migrationFiles } from "./migration.js";

export function scaffoldFiles({
  buildchainRoot,
  buildchainVersion,
  cwd,
  name,
  title,
  packageName,
  repository,
  version,
  siteBaseUrl,
}) {
  const licenseText = runtimeLicenseText(buildchainRoot);
  return new Map([
    [PAPER_PATHS.config, consumerConfiguration({ type: "paper", version })],
    ...Object.entries(consumerWorkflows()),
    [PAPER_PATHS.agentInstructions, consumerAgentInstructions()],
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
        title,
        packageName,
        repository,
        version,
        siteBaseUrl,
        buildchainVersion,
      }),
    ],
    ["README.md", scaffoldReadme({ title, packageName })],
    ["docs/MAP.md", scaffoldMap()],
    ["paper/main.tex", scaffoldMainTex(title)],
    ["paper/references.bib", "% Add reviewed bibliography entries here.\n"],
    ["LICENSE", licenseText],
    [".gitignore", "node_modules/\n_build/\n"],
  ]);
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
  scaffoldFiles,
});
