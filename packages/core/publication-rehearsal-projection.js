import {
  PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
  PUBLICATION_REHEARSAL_COMMAND,
  RELEASE_LOCAL_CONSTRUCTIBILITY_ADR,
  RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
} from "./publication-rehearsal-runtime.js";

export const PUBLICATION_REHEARSAL_AGENT_SECTION_START =
  "<!-- buildchain:publication-rehearsal:v4:start -->";
export const PUBLICATION_REHEARSAL_AGENT_SECTION_END =
  "<!-- buildchain:publication-rehearsal:v4:end -->";
export const PUBLICATION_REHEARSAL_WORKFLOW_PATH =
  ".github/workflows/publication-rehearsal.yml";

export function publicationRehearsalToml() {
  return `[publication_rehearsal]\ncontract = ${JSON.stringify(PUBLICATION_REHEARSAL_CAPSULE_CONTRACT)}\nadr = ${JSON.stringify(RELEASE_LOCAL_CONSTRUCTIBILITY_ADR)}\ninvariant = ${JSON.stringify(RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT)}\ncommand = ${JSON.stringify(PUBLICATION_REHEARSAL_COMMAND)}\ncapsule = ".buildchain/publication-rehearsal/capsule.json"\ncandidate_root = ".buildchain/publication-rehearsal/candidate"\nstate = ".buildchain/publication-rehearsal/state.json"\nevidence = ".buildchain/publication-rehearsal/evidence.json"\n`;
}

export function assertPublicationRehearsalConfig(config) {
  const section = config?.publication_rehearsal;
  if (!section || typeof section !== "object" || Array.isArray(section))
    throw new Error("publication_rehearsal table is missing");
  const expected = {
    contract: PUBLICATION_REHEARSAL_CAPSULE_CONTRACT,
    adr: RELEASE_LOCAL_CONSTRUCTIBILITY_ADR,
    invariant: RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT,
    command: PUBLICATION_REHEARSAL_COMMAND,
    capsule: ".buildchain/publication-rehearsal/capsule.json",
    candidate_root: ".buildchain/publication-rehearsal/candidate",
    state: ".buildchain/publication-rehearsal/state.json",
    evidence: ".buildchain/publication-rehearsal/evidence.json",
  };
  if (
    JSON.stringify(Object.keys(section).sort()) !==
    JSON.stringify(Object.keys(expected).sort())
  )
    throw new Error(
      `publication_rehearsal fields must be exactly: ${Object.keys(expected).sort().join(", ")}`,
    );
  for (const [key, value] of Object.entries(expected))
    if (section[key] !== value)
      throw new Error(`publication_rehearsal.${key} is stale or unsupported`);
  return structuredClone(section);
}

export function appendPublicationRehearsalToml(source) {
  const current = String(source || "").trimEnd();
  if (/^\[publication_rehearsal\]$/mu.test(current))
    throw new Error(
      "buildchain config already contains a publication_rehearsal table",
    );
  return `${current}\n\n${publicationRehearsalToml()}`;
}

export function projectPublicationRehearsalToml(source) {
  const current = String(source || "");
  const start = current.search(/^\[publication_rehearsal\]\s*$/mu);
  if (start === -1) return appendPublicationRehearsalToml(current);
  const remainder = current.slice(start);
  const newline = remainder.indexOf("\n");
  const nextTable = remainder.slice(newline + 1).search(/^\[[^\n]+\]\s*$/mu);
  const end =
    nextTable === -1 ? current.length : start + newline + 1 + nextTable;
  const prefix = current.slice(0, start).trimEnd();
  const suffix = current.slice(end).trimStart();
  return `${prefix}\n\n${publicationRehearsalToml()}${suffix ? `\n${suffix}` : ""}`;
}

export function publicationRehearsalAgentInstructions() {
  return `${PUBLICATION_REHEARSAL_AGENT_SECTION_START}\n## Publication rehearsal (required)\n\nBuildchain v4 rehearsal follows \`${RELEASE_LOCAL_CONSTRUCTIBILITY_ADR}\`.\n${RELEASE_LOCAL_CONSTRUCTIBILITY_INVARIANT}\n\nRun the source-bound capsule with:\n\n\`\`\`sh\n${PUBLICATION_REHEARSAL_COMMAND}\n\`\`\`\n\nSimulation and replay evidence never claim production publication authority.\n${PUBLICATION_REHEARSAL_AGENT_SECTION_END}`;
}

export function mergePublicationRehearsalAgentInstructions(current = "") {
  const source = String(current || "");
  const section = publicationRehearsalAgentInstructions();
  const start = source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_START);
  const end = source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_END);
  if ((start === -1) !== (end === -1) || end < start)
    throw new Error(
      "AGENTS.md has an incomplete Buildchain publication rehearsal section",
    );
  if (start === -1)
    return source.trim()
      ? `${source.trimEnd()}\n\n${section}\n`
      : `# AGENTS.md\n\n${section}\n`;
  if (
    source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_START, start + 1) !==
      -1 ||
    source.indexOf(PUBLICATION_REHEARSAL_AGENT_SECTION_END, end + 1) !== -1
  )
    throw new Error(
      "AGENTS.md has ambiguous Buildchain publication rehearsal sections",
    );
  return `${source.slice(0, start)}${section}${source.slice(
    end + PUBLICATION_REHEARSAL_AGENT_SECTION_END.length,
  )}`;
}

export function publicationRehearsalWorkflow(buildchainRef) {
  const ref = String(buildchainRef || "").trim();
  if (!ref)
    throw new Error("publication rehearsal workflow requires a Buildchain ref");
  return `name: Publication Rehearsal\n\non:\n  workflow_dispatch:\n    inputs:\n      capsule-path:\n        description: "Source-bound v4 publication rehearsal capsule"\n        required: true\n        default: ".buildchain/publication-rehearsal/capsule.json"\n      candidate-root:\n        description: "Repository-relative candidate root"\n        required: true\n        default: ".buildchain/publication-rehearsal/candidate"\n\npermissions:\n  contents: read\n\njobs:\n  rehearsal:\n    uses: kungfu-systems/buildchain/.github/workflows/release-tail.yml@${ref}\n    with:\n      buildchain-ref: ${ref}\n      rehearsal-capsule-path: \${{ inputs.capsule-path }}\n      candidate-root: \${{ inputs.candidate-root }}\n      rehearsal-mode: simulate\n      state-path: ".buildchain/publication-rehearsal/state.json"\n      rehearsal-evidence-path: ".buildchain/publication-rehearsal/evidence.json"\n`;
}
