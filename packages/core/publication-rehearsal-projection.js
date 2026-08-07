import {
  PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  PUBLICATION_REHEARSAL_COMMAND,
  RELEASE_LOCAL_CONSTRUCTIBILITY_ADR,
  RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
} from "./publication-rehearsal-runtime.js";

export const PUBLICATION_REHEARSAL_AGENT_SECTION_START =
  "<!-- buildchain:publication-rehearsal:v1:start -->";
export const PUBLICATION_REHEARSAL_AGENT_SECTION_END =
  "<!-- buildchain:publication-rehearsal:v1:end -->";
export const PUBLICATION_REHEARSAL_WORKFLOW_PATH =
  ".github/workflows/publication-rehearsal.yml";

function tomlString(value) {
  return JSON.stringify(value);
}

export function publicationRehearsalToml() {
  return `[publication_rehearsal]
contract = ${tomlString(PUBLICATION_REHEARSAL_CAPSULE_CONTRACT)}
adr = ${tomlString(RELEASE_LOCAL_CONSTRUCTIBILITY_ADR)}
invariant = ${tomlString(RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT)}
command = ${tomlString(PUBLICATION_REHEARSAL_COMMAND)}
capsule = ".buildchain/publication/rehearsal-capsule.json"
capsule_root = ".buildchain/publication/candidate"
state = ".buildchain/publication/rehearsal-state.json"
evidence = ".buildchain/publication/rehearsal-evidence.json"
`;
}

export function assertPublicationRehearsalConfig(config) {
  const section = config?.publication_rehearsal;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("publication_rehearsal table is missing");
  }
  const expected = {
    contract: PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    adr: RELEASE_LOCAL_CONSTRUCTIBILITY_ADR,
    invariant: RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
    command: PUBLICATION_REHEARSAL_COMMAND,
    capsule: ".buildchain/publication/rehearsal-capsule.json",
    capsule_root: ".buildchain/publication/candidate",
    state: ".buildchain/publication/rehearsal-state.json",
    evidence: ".buildchain/publication/rehearsal-evidence.json",
  };
  const actualKeys = Object.keys(section).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.join("\n") !== expectedKeys.join("\n")) {
    throw new Error(
      `publication_rehearsal fields must be exactly: ${expectedKeys.join(", ")}`,
    );
  }
  for (const [key, value] of Object.entries(expected)) {
    if (section[key] !== value) {
      throw new Error(`publication_rehearsal.${key} is stale or unsupported`);
    }
  }
  return structuredClone(section);
}

export function appendPublicationRehearsalToml(source) {
  const current = String(source || "").trimEnd();
  if (/^\[publication_rehearsal\]$/mu.test(current)) {
    throw new Error(
      "buildchain config already contains a publication_rehearsal table",
    );
  }
  return `${current}\n\n${publicationRehearsalToml()}`;
}

export function projectPublicationRehearsalToml(source) {
  const current = String(source || "");
  const start = current.search(/^\[publication_rehearsal\]\s*$/mu);
  if (start === -1) return appendPublicationRehearsalToml(current);
  const remainder = current.slice(start);
  const nextTable = remainder
    .slice(remainder.indexOf("\n") + 1)
    .search(/^\[[^\n]+\]\s*$/mu);
  const end =
    nextTable === -1
      ? current.length
      : start + remainder.indexOf("\n") + 1 + nextTable;
  const prefix = current.slice(0, start).trimEnd();
  const suffix = current.slice(end).trimStart();
  return `${prefix}\n\n${publicationRehearsalToml()}${suffix ? `\n${suffix}` : ""}`;
}

export function publicationRehearsalAgentInstructions() {
  return `${PUBLICATION_REHEARSAL_AGENT_SECTION_START}
## Publication rehearsal (required)

Buildchain release behavior follows
\`${RELEASE_LOCAL_CONSTRUCTIBILITY_ADR}\`. ${RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT}

Before hosted publication, restore the explicit
\`${PUBLICATION_REHEARSAL_CAPSULE_CONTRACT}\` capsule and run exactly:

\`\`\`sh
${PUBLICATION_REHEARSAL_COMMAND}
\`\`\`

Simulation and replay evidence never claim external publication truth. GitHub
Actions may add only declared credentials, transport, and unavoidable provider
effects; it may not add semantic inputs from runner environment or workspace.
${PUBLICATION_REHEARSAL_AGENT_SECTION_END}`;
}

export function mergePublicationRehearsalAgentInstructions(current = "") {
  const source = String(current || "");
  const section = publicationRehearsalAgentInstructions();
  const start = source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_START);
  const end = source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_END);
  if ((start === -1) !== (end === -1)) {
    throw new Error(
      "AGENTS.md has an incomplete Buildchain publication rehearsal section",
    );
  }
  if (start === -1) {
    return source.trim()
      ? `${source.trimEnd()}\n\n${section}\n`
      : `# AGENTS.md\n\n${section}\n`;
  }
  if (
    source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_START, start + 1) !==
      -1 ||
    source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_END, end + 1) !== -1 ||
    end < start
  ) {
    throw new Error(
      "AGENTS.md has ambiguous Buildchain publication rehearsal sections",
    );
  }
  return `${source.slice(0, start)}${section}${source.slice(
    end + PUBLICATION_REHEARSAL_AGENT_SECTION_END.length,
  )}`;
}

export function publicationRehearsalWorkflow(buildchainRef) {
  const ref = String(buildchainRef || "").trim();
  if (!ref)
    throw new Error("publication rehearsal workflow requires a Buildchain ref");
  return `name: Publication Rehearsal

on:
  workflow_dispatch:
    inputs:
      capsule-path:
        description: "Content-addressed publication rehearsal capsule"
        required: true
        default: ".buildchain/publication/rehearsal-capsule.json"
      capsule-root:
        description: "Repository-relative capsule file root"
        required: true
        default: ".buildchain/publication/candidate"

permissions:
  contents: write

jobs:
  rehearsal:
    uses: kungfu-systems/buildchain/.github/workflows/release-tail.yml@${ref}
    with:
      buildchain-ref: ${ref}
      capsule-contract: ${JSON.stringify(PUBLICATION_REHEARSAL_CAPSULE_CONTRACT)}
      capsule-path: \${{ inputs.capsule-path }}
      capsule-root: \${{ inputs.capsule-root }}
      state-path: ".buildchain/publication/rehearsal-state.json"
      evidence-path: ".buildchain/publication/rehearsal-evidence.json"
    secrets:
      http-token: \${{ secrets.BUILDCHAIN_PUBLICATION_HTTP_TOKEN }}
`;
}
