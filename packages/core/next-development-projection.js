import {
  NEXT_DEVELOPMENT_ADR,
  NEXT_DEVELOPMENT_INVARIANT,
  NEXT_DEVELOPMENT_STATES,
  NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
  NEXT_DEVELOPMENT_VERSION_MODELS,
} from "./next-development-transition.js";

export const NEXT_DEVELOPMENT_AGENT_SECTION_START =
  "<!-- buildchain:next-development:v1:start -->";
export const NEXT_DEVELOPMENT_AGENT_SECTION_END =
  "<!-- buildchain:next-development:v1:end -->";
export const NEXT_DEVELOPMENT_LOCAL_COMMAND =
  "node scripts/next-development-transition.mjs materialize --cwd . --input <request.json>";

export function nextDevelopmentWorkflowHeader() {
  return `# Next-development contract: ${NEXT_DEVELOPMENT_TRANSITION_CONTRACT}
# ${NEXT_DEVELOPMENT_INVARIANT}
`;
}

export function nextDevelopmentToml() {
  return `[next_development]
contract = ${JSON.stringify(NEXT_DEVELOPMENT_TRANSITION_CONTRACT)}
adr = ${JSON.stringify(NEXT_DEVELOPMENT_ADR)}
invariant = ${JSON.stringify(NEXT_DEVELOPMENT_INVARIANT)}
states = ${JSON.stringify(NEXT_DEVELOPMENT_STATES)}
adapter = "scripts/next-development-transition.mjs"
adapter_environment = "BUILDCHAIN_VERSION"
source_paths = "version.files"
derived_paths = "version.derived_files"
read_only_paths = "version.manifest"
derivation_stage = "lifecycle.version-state"
verification_stage = "lifecycle.verify"
allowed_effects = ["declared-version-source-and-derived-files"]
public_side_effects = []
forbidden_ref_namespaces = ["refs/heads/alpha/", "refs/tags/"]
`;
}

export function appendNextDevelopmentToml(source) {
  const current = String(source || "").trimEnd();
  if (/^\[next_development\]$/mu.test(current)) {
    throw new Error(
      "buildchain config already contains a next_development table",
    );
  }
  return `${current}\n\n${nextDevelopmentToml()}`;
}

export function projectNextDevelopmentToml(source) {
  const current = String(source || "");
  const start = current.search(/^\[next_development\]\s*$/mu);
  if (start === -1) return appendNextDevelopmentToml(current);
  const remainder = current.slice(start);
  const firstNewline = remainder.indexOf("\n");
  const nextTable = remainder
    .slice(firstNewline + 1)
    .search(/^\[[^\n]+\]\s*$/mu);
  const end =
    nextTable === -1 ? current.length : start + firstNewline + 1 + nextTable;
  const prefix = current.slice(0, start).trimEnd();
  const suffix = current.slice(end).trimStart();
  return `${prefix}\n\n${nextDevelopmentToml()}${suffix ? `\n${suffix}` : ""}`;
}

export function assertNextDevelopmentConfig(config) {
  const section = config?.next_development;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error("next_development table is missing");
  }
  const expected = {
    contract: NEXT_DEVELOPMENT_TRANSITION_CONTRACT,
    adr: NEXT_DEVELOPMENT_ADR,
    invariant: NEXT_DEVELOPMENT_INVARIANT,
    states: [...NEXT_DEVELOPMENT_STATES],
    adapter: "scripts/next-development-transition.mjs",
    adapter_environment: "BUILDCHAIN_VERSION",
    source_paths: "version.files",
    derived_paths: "version.derived_files",
    read_only_paths: "version.manifest",
    derivation_stage: "lifecycle.version-state",
    verification_stage: "lifecycle.verify",
    allowed_effects: ["declared-version-source-and-derived-files"],
    public_side_effects: [],
    forbidden_ref_namespaces: ["refs/heads/alpha/", "refs/tags/"],
  };
  if (JSON.stringify(section) !== JSON.stringify(expected)) {
    throw new Error("next_development projection is stale or unsupported");
  }
  return structuredClone(section);
}

export function nextDevelopmentAgentInstructions() {
  return `${NEXT_DEVELOPMENT_AGENT_SECTION_START}
## Next-development transition (required after Alpha)

Follow \`${NEXT_DEVELOPMENT_ADR}\` and
\`${NEXT_DEVELOPMENT_TRANSITION_CONTRACT}\`. ${NEXT_DEVELOPMENT_INVARIANT}

Use only \`semver/auto\` or \`anchored/manual\`. Record \`planned\`,
\`waiting-anchor\`, \`materialized\`, \`pr-pending\`, \`merged\`, and \`verified\`
without changing the completed Alpha outcome. During preparation, never move
an Alpha branch or tag and never write outside declared source and derived
version paths. Treat the anchor manifest as read-only.

Plan locally before opting into declared-path writes:

\`\`\`sh
${NEXT_DEVELOPMENT_LOCAL_COMMAND}
\`\`\`

Add \`--write\` only after reviewing the rooted plan. Anchored/manual consumers
must materialize and root the declared anchor manifest first.
Repository transaction adapters pass the exact target as
\`BUILDCHAIN_VERSION\`, run \`lifecycle.version-state\` when derived files are
declared, then run \`lifecycle.verify\`. The reference writer fails closed for
derived-file consumers; it does not execute arbitrary consumer commands.
${NEXT_DEVELOPMENT_AGENT_SECTION_END}`;
}

export function mergeNextDevelopmentAgentInstructions(current = "") {
  const source = String(current || "");
  const section = nextDevelopmentAgentInstructions();
  const start = source.indexOf(NEXT_DEVELOPMENT_AGENT_SECTION_START);
  const end = source.indexOf(NEXT_DEVELOPMENT_AGENT_SECTION_END);
  if ((start === -1) !== (end === -1)) {
    throw new Error(
      "AGENTS.md has an incomplete Buildchain next-development section",
    );
  }
  if (start === -1) {
    return source.trim()
      ? `${source.trimEnd()}\n\n${section}\n`
      : `# AGENTS.md\n\n${section}\n`;
  }
  if (
    source.indexOf(NEXT_DEVELOPMENT_AGENT_SECTION_START, start + 1) !== -1 ||
    source.indexOf(NEXT_DEVELOPMENT_AGENT_SECTION_END, end + 1) !== -1 ||
    end < start
  ) {
    throw new Error(
      "AGENTS.md has ambiguous Buildchain next-development sections",
    );
  }
  return `${source.slice(0, start)}${section}${source.slice(
    end + NEXT_DEVELOPMENT_AGENT_SECTION_END.length,
  )}`;
}

export function nextDevelopmentManual() {
  const states = NEXT_DEVELOPMENT_STATES.map((state) => `\`${state}\``).join(
    ", ",
  );
  const models = NEXT_DEVELOPMENT_VERSION_MODELS.map(
    (model) => `\`${model.strategy}/${model.next}\``,
  ).join(" and ");
  return `---
status: preview
period: ongoing
theme: next-development-transition
doc_type: generated-contract-guidance
source_level: generated-from-node-contract
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-08-11
---

# Next-development Transition

This document is generated from
\`packages/core/next-development-transition.js\` and
\`packages/core/next-development-projection.js\`. Edit those sources and run
\`node scripts/generate-next-development-guidance.mjs\`; direct edits fail the
projection drift check.

## Contract

- Contract: \`${NEXT_DEVELOPMENT_TRANSITION_CONTRACT}\`
- ADR: [ADR 0002](../${NEXT_DEVELOPMENT_ADR})
- States: ${states}
- Legal version models: ${models}
- Invariant: ${NEXT_DEVELOPMENT_INVARIANT}

An Alpha publication is terminal success independently of this transition.
The idempotency key is a deterministic hash of the completed-Alpha root,
repository, legal model, and sorted declared paths. Incomplete Dev preparation
therefore cannot relabel Alpha N as failed, and replay cannot select a different
Alpha or path set.

## Version models

\`semver/auto\` increments the Alpha sequence on the same semantic patch. For
example, completed \`1.4.2-alpha.7\` plans \`1.4.2-alpha.8\`. It must not accept an anchor or an
operator-selected target.

\`anchored/manual\` enters \`waiting-anchor\` until the caller provides both a
semantic target and the exact digest of the configured anchor manifest. The
adapter verifies the manifest already present in the checkout; it never invents
or edits upstream anchor facts. \`semver/manual\` and \`anchored/auto\` are
invalid.

## Local adapter

From a normal Buildchain checkout:

\`\`\`sh
${NEXT_DEVELOPMENT_LOCAL_COMMAND}
\`\`\`

The command prints a rooted plan and performs no write by default. \`--write\`
may change only regular, non-symlink source files listed by \`version.files\`
in the loaded Buildchain config. The rooted adapter contract separately names
\`version.derived_files\` as allowed changes, \`version.manifest\` as read-only,
\`BUILDCHAIN_VERSION\` as the target input, \`lifecycle.version-state\` as the
derived-material stage, and \`lifecycle.verify\` as the truth gate. The
reference writer fails closed when derived files exist because transaction
execution is outside this contract slice. It performs no Git operation, ref
update, network request, provider call, lifecycle command, or anchor edit.

Preparing development state creates no tag, Release, public package, or
candidate. Those public effects remain outside the local adapter contract.

The request schema is
\`contracts/next-development-request-v1.schema.json\`; the durable record schema
is \`contracts/next-development-transition-v1.schema.json\`. Positive and
negative examples live under
\`contracts/fixtures/next-development-transition-v1/\`.
`;
}
