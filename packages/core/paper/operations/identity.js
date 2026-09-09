import { PAPER_PATHS } from "../paper-repository.js";
export const PAPER_SCAFFOLD_CONTRACT = "kungfu-buildchain-paper-scaffold";
export const PAPER_MIGRATION_CONTRACT = "kungfu-buildchain-paper-migration";
export const PAPER_PREFLIGHT_CONTRACT = "kungfu-buildchain-paper-preflight";
export const PAPER_STATUS_CONTRACT = "kungfu-buildchain-paper-status";
export const PAPER_NPM_BOOTSTRAP_CONTRACT =
  "kungfu-buildchain-paper-npm-bootstrap";
export const PAPER_PROVISIONING_CONTRACT =
  "kungfu-buildchain-paper-provisioning-authority";
export const PAPER_BUILD_PLAN_CONTRACT = "kungfu-buildchain-paper-build-plan";
export const PAPER_ALPHA_PLAN_CONTRACT = "kungfu-buildchain-paper-alpha-plan";
export const PAPER_RESUME_PLAN_CONTRACT = "kungfu-buildchain-paper-resume-plan";
export const PAPER_VISIBILITY_CONTRACT = "kungfu-buildchain-paper-visibility";
export const PAPER_STATE_ORDER = Object.freeze([
  "scaffolded",
  "governed",
  "admitted",
  "bootstrapped",
  "trust-bound",
  "content-ready",
  "artifact-sealed",
  "package-published",
  "alpha-complete",
  "staging-visible",
  "production-visible",
]);
export const PAPER_SCAFFOLD_PATHS = Object.freeze([
  PAPER_PATHS.config,
  PAPER_PATHS.agentEntry,
  PAPER_PATHS.agentInstructions,
  PAPER_PATHS.contractLock,
  PAPER_PATHS.versionPin,
  PAPER_PATHS.buildWorkflow,
  PAPER_PATHS.verifyWorkflow,
  PAPER_PATHS.releaseWorkflow,
  PAPER_PATHS.pnpmWorkspace,
  PAPER_PATHS.provisioningAuthority,
  "Makefile",
  "package.json",
  "README.md",
  "docs/MAP.md",
  "paper/main.tex",
  "paper/references.bib",
  "LICENSE",
  ".gitignore",
]);
export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";
export const DEFAULT_TOOLCHAIN_IMAGE =
  "ghcr.io/kungfu-systems/build-images/latex-pdf-builder";
export const DEFAULT_TOOLCHAIN_DIGEST =
  "sha256:c20f3809e96836c1c78e97c76939d12f1de3fed0ea9b7c40c43332ec2ea480f8";
export const DEFAULT_TOOLCHAIN_COMMAND =
  "latexmk -pdf -outdir=_build paper/main.tex";
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;
export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
export const BUILDCHAIN_PACKAGE_NAME = "@kungfu-tech/buildchain";
