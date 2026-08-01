import fs from "node:fs";
import path from "node:path";

import {
  PAPER_PATHS,
  PAPER_WORK_BRANCH_PATTERN,
  gitResult,
  gitValue,
  paperDevelopmentRef,
  readJson,
  sha256Text,
  stableJson,
  workCheck,
} from "./paper-repository.js";

export const PAPER_AGENT_ENTRY_CONTRACT = "kungfu-buildchain-paper-agent-entry";
export const PAPER_AGENT_ENTRY_SCHEMA_VERSION = 1;
export const PAPER_AGENT_ENTRY_SECTION_START =
  "<!-- buildchain:paper-agent-entry:v1:start -->";
export const PAPER_AGENT_ENTRY_SECTION_END =
  "<!-- buildchain:paper-agent-entry:v1:end -->";

const EXACT_PAPER_SCRIPTS = Object.freeze({
  "paper:agent:verify": "buildchain paper agent verify --json",
  "paper:work:start": "buildchain paper work start",
  "paper:work:submit": "buildchain paper work submit",
});

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/i;

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function paperAgentEntryInstructions({ developmentRef }) {
  return `${PAPER_AGENT_ENTRY_SECTION_START}
## Paper work entry (required)

This repository uses the Buildchain-managed Paper path. Before changing any
tracked file, inspect the current branch and follow the matching rule:

- On \`main\`, \`${developmentRef}\`, or another protected channel, do not edit.
  Switch to the exact current \`${developmentRef}\`, install the pinned pnpm
  dependencies when needed, then run
  \`pnpm paper:work:start -- <topic> --execute --json\`.
- On an existing \`feature/*\`, \`fix/*\`, \`docs/*\`, \`chore/*\`, \`ci/*\`, or
  \`refactor/*\` branch, run \`pnpm paper:agent:verify\` before continuing.
- Before opening or updating a pull request, commit the intended bytes and run
  \`pnpm paper:work:submit -- --execute --json\`. The target must be
  \`${developmentRef}\`; direct protected-branch pushes and force pushes are
  forbidden.

The required remote check independently verifies this contract, the exact
Buildchain package and runtime authority, and feature-to-development lineage.
Passing local commands alone is not acceptance, and manually bypassing them
does not bypass remote policy.
${PAPER_AGENT_ENTRY_SECTION_END}`;
}

export function mergePaperAgentEntryInstructions(
  current = "",
  { developmentRef },
) {
  const source = String(current || "");
  const section = paperAgentEntryInstructions({ developmentRef });
  const start = source.indexOf(PAPER_AGENT_ENTRY_SECTION_START);
  const end = source.indexOf(PAPER_AGENT_ENTRY_SECTION_END);
  if ((start === -1) !== (end === -1)) {
    throw new Error(
      "AGENTS.md has an incomplete Buildchain Paper agent-entry managed section",
    );
  }
  if (start === -1) {
    return source.trim()
      ? `${source.trimEnd()}\n\n${section}\n`
      : `# AGENTS.md\n\n${section}\n`;
  }
  if (
    source.indexOf(PAPER_AGENT_ENTRY_SECTION_START, start + 1) !== -1 ||
    source.indexOf(PAPER_AGENT_ENTRY_SECTION_END, end + 1) !== -1 ||
    end < start
  ) {
    throw new Error(
      "AGENTS.md has ambiguous Buildchain Paper agent-entry managed sections",
    );
  }
  return `${source.slice(0, start)}${section}${source.slice(
    end + PAPER_AGENT_ENTRY_SECTION_END.length,
  )}`;
}

export function createPaperAgentEntry({
  buildchainVersion,
  buildchainSha,
  developmentRef,
}) {
  const version = String(buildchainVersion || "").trim();
  const sourceSha = String(buildchainSha || "").trim();
  if (!/^3\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      "paper agent entry requires an exact Buildchain v3 version",
    );
  }
  if (!GIT_SHA_PATTERN.test(sourceSha)) {
    throw new Error(
      "paper agent entry requires an exact Buildchain source SHA",
    );
  }
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(developmentRef)) {
    throw new Error("paper agent entry requires an exact development ref");
  }
  const payload = {
    schemaVersion: PAPER_AGENT_ENTRY_SCHEMA_VERSION,
    contract: PAPER_AGENT_ENTRY_CONTRACT,
    runtime: {
      package: "@kungfu-tech/buildchain",
      version,
      sourceSha,
    },
    repository: {
      developmentRef,
      pullRequestTarget: developmentRef,
    },
    commands: {
      verify: "pnpm paper:agent:verify",
      start: "pnpm paper:work:start -- <topic> --execute --json",
      submit: "pnpm paper:work:submit -- --execute --json",
    },
    policy: {
      localMutation: "dry-run-first",
      protectedBranchPatterns: [
        "main",
        "dev/**",
        "alpha/**",
        "release/**",
        "publish-gate/**",
      ],
      workBranchPattern: PAPER_WORK_BRANCH_PATTERN.source,
      forcePush: false,
      remoteAcceptance: "required-buildchain-check",
    },
  };
  return {
    ...payload,
    entryDigest: sha256Text(stableJson(payload)),
  };
}

export function paperAgentEntryFiles({
  cwd,
  buildchainVersion,
  buildchainSha,
  developmentRef = "",
}) {
  const resolvedDevelopmentRef = developmentRef || paperDevelopmentRef(cwd);
  const agentsPath = path.resolve(cwd, PAPER_PATHS.agentInstructions);
  const currentAgents = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : "";
  const entry = createPaperAgentEntry({
    buildchainVersion,
    buildchainSha,
    developmentRef: resolvedDevelopmentRef,
  });
  return new Map([
    [PAPER_PATHS.agentEntry, jsonText(entry)],
    [
      PAPER_PATHS.agentInstructions,
      mergePaperAgentEntryInstructions(currentAgents, {
        developmentRef: resolvedDevelopmentRef,
      }),
    ],
  ]);
}

export function resolvePaperBuildchainSha(buildchainRoot, buildchainSha = "") {
  if (buildchainSha) return buildchainSha;
  if (!fs.existsSync(path.resolve(buildchainRoot, ".git"))) return "";
  const observed = gitValue(buildchainRoot, ["rev-parse", "HEAD"]);
  return GIT_SHA_PATTERN.test(observed) ? observed : "";
}

function expectedCiBranches(ref) {
  return ["dev", "alpha", "release"].map((c) => ref.replace(/^dev/, c));
}

function ciContext({ env, developmentRef }) {
  const event = String(env.GITHUB_EVENT_NAME || "");
  const sourceBranch = String(
    env.GITHUB_HEAD_REF || env.BUILDCHAIN_PAPER_SOURCE_BRANCH || "",
  );
  const targetBranch = String(
    env.GITHUB_BASE_REF || env.BUILDCHAIN_PAPER_TARGET_BRANCH || "",
  );
  const refName = String(
    env.GITHUB_REF_NAME || env.BUILDCHAIN_PAPER_REF_NAME || "",
  );
  const pullRequest = ["pull_request", "pull_request_target"].includes(event);
  const channelBranches = expectedCiBranches(developmentRef);
  const channelIndex = channelBranches.indexOf(targetBranch);
  const branchOk = pullRequest
    ? (PAPER_WORK_BRANCH_PATTERN.test(sourceBranch) &&
        targetBranch === developmentRef) ||
      (channelIndex > 0 && sourceBranch === channelBranches[channelIndex - 1])
    : channelBranches.includes(refName);
  return {
    mode: "ci",
    event,
    sourceBranch,
    targetBranch,
    refName,
    pullRequest,
    ok: branchOk,
    message: pullRequest
      ? `Pull requests must target ${developmentRef} from an allowed work branch or promote adjacent protected channels.`
      : `Channel checks must run on ${channelBranches.join(", ")}.`,
  };
}

function localContext({ cwd, developmentRef }) {
  const branch = gitValue(cwd, ["branch", "--show-current"]);
  const developmentSha = gitValue(cwd, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${developmentRef}`,
  ]);
  const containsDevelopment =
    PAPER_WORK_BRANCH_PATTERN.test(branch) &&
    GIT_SHA_PATTERN.test(developmentSha) &&
    gitResult(cwd, ["merge-base", "--is-ancestor", developmentSha, "HEAD"]).ok;
  return {
    mode: "local",
    branch,
    developmentRef,
    developmentSha,
    ok: containsDevelopment,
    message: PAPER_WORK_BRANCH_PATTERN.test(branch)
      ? `The work branch must contain origin/${developmentRef}.`
      : `Run paper work start from the exact ${developmentRef} channel before editing.`,
  };
}

export function collectPaperAgentEntry({
  cwd = process.cwd(),
  buildchainSha = "",
  mode = "contract",
  env = process.env,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const developmentRef = paperDevelopmentRef(resolvedCwd);
  const source = readJson(path.resolve(resolvedCwd, PAPER_PATHS.agentEntry));
  const entry = source.value || {};
  const effectiveBuildchainSha =
    buildchainSha || String(entry.runtime?.sourceSha || "");
  const packageJson =
    readJson(path.resolve(resolvedCwd, "package.json")).value || {};
  const pinPath = path.resolve(resolvedCwd, PAPER_PATHS.versionPin);
  const versionPin = fs.existsSync(pinPath)
    ? fs.readFileSync(pinPath, "utf8").trim()
    : "";
  const agentsPath = path.resolve(resolvedCwd, PAPER_PATHS.agentInstructions);
  const agents = fs.existsSync(agentsPath)
    ? fs.readFileSync(agentsPath, "utf8")
    : "";
  const expectedInstructions = paperAgentEntryInstructions({ developmentRef });
  const { entryDigest: observedDigest, ...entryPayload } = entry;
  const checks = [
    workCheck(
      "agent-entry.contract",
      source.exists &&
        !source.error &&
        entry.contract === PAPER_AGENT_ENTRY_CONTRACT &&
        entry.schemaVersion === PAPER_AGENT_ENTRY_SCHEMA_VERSION,
      "The versioned Paper agent-entry contract exists and parses.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "agent-entry.digest",
      SHA256_PATTERN.test(String(observedDigest || "")) &&
        observedDigest === sha256Text(stableJson(entryPayload)),
      "The Paper agent-entry contract digest matches its exact payload.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "agent-entry.instructions",
      agents.includes(expectedInstructions) &&
        agents.split(PAPER_AGENT_ENTRY_SECTION_START).length === 2 &&
        agents.split(PAPER_AGENT_ENTRY_SECTION_END).length === 2,
      "AGENTS.md contains exactly one current Buildchain-managed Paper entry section.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "agent-entry.package-version",
      Boolean(versionPin) &&
        entry.runtime?.version === versionPin &&
        packageJson.devDependencies?.["@kungfu-tech/buildchain"] === versionPin,
      "The agent-entry contract, version pin, and exact Buildchain dependency agree.",
      "buildchain paper migrate --write --json && pnpm install --lockfile-only",
    ),
    workCheck(
      "agent-entry.runtime-source",
      GIT_SHA_PATTERN.test(effectiveBuildchainSha) &&
        entry.runtime?.sourceSha === effectiveBuildchainSha,
      "The agent-entry contract is bound to the exact executing Buildchain source SHA.",
      "buildchain paper migrate --write --json",
    ),
    workCheck(
      "agent-entry.development-ref",
      entry.repository?.developmentRef === developmentRef &&
        entry.repository?.pullRequestTarget === developmentRef,
      `The agent-entry contract targets ${developmentRef}.`,
      "buildchain paper migrate --write --json",
    ),
    ...Object.entries(EXACT_PAPER_SCRIPTS).map(([name, command]) =>
      workCheck(
        `agent-entry.script.${name}`,
        packageJson.scripts?.[name] === command,
        `package.json exposes the exact ${name} command.`,
        "buildchain paper migrate --write --json",
      ),
    ),
  ];
  const context =
    mode === "ci"
      ? ciContext({ env, developmentRef })
      : mode === "local"
        ? localContext({ cwd: resolvedCwd, developmentRef })
        : { mode: "contract", ok: true };
  if (mode !== "contract") {
    checks.push(
      workCheck(
        "agent-entry.work-context",
        context.ok,
        context.message,
        mode === "ci"
          ? "retarget the pull request to the configured development channel"
          : `pnpm paper:work:start -- <topic> --execute --json`,
      ),
    );
  }
  const ok = checks.every((entryCheck) => entryCheck.status === "pass");
  return {
    schemaVersion: 1,
    contract: PAPER_AGENT_ENTRY_CONTRACT,
    ok,
    cwd: resolvedCwd,
    mode,
    entry,
    context,
    checks,
    nextActions: checks
      .filter((entryCheck) => entryCheck.status === "fail")
      .map((entryCheck) => ({
        id: `repair-${entryCheck.id}`,
        command: entryCheck.correctiveCommand,
        description: entryCheck.message,
      })),
  };
}
