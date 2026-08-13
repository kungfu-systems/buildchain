import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";

export const V4_STABLE_PUBLICATION_REQUEST_CONTRACT =
  "buildchain-v4-stable-publication-request/v1";
export const V4_STABLE_PUBLICATION_PLAN_CONTRACT =
  "buildchain-v4-stable-publication-plan/v1";
export const V4_STABLE_PUBLICATION_FENCE_CONTRACT =
  "buildchain-v4-stable-publication-fence/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TARGET_KINDS = new Set([
  "stable-ref",
  "npm-tag",
  "oci-tag",
  "github-release",
]);

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault(
      "invalid-stable-publication-shape",
      path,
      `${path} must be an object`,
    );
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  )
    fault(
      "invalid-stable-publication-shape",
      path,
      `${path} keys do not match the closed publication fence contract`,
    );
}

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateToken(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stable-publication-token",
      path,
      `${path} must be an ASCII token`,
    );
}

function validateGeneration(value, path) {
  if (!Number.isSafeInteger(value) || value < 1)
    fault(
      "invalid-stable-publication-generation",
      path,
      `${path} must be a positive safe integer`,
    );
}

function normalizeRoots(values, path) {
  if (!Array.isArray(values) || values.length === 0)
    fault(
      "stable-publication-provider-confirmation-mismatch",
      path,
      `${path} must contain rooted provider confirmations`,
    );
  for (const [index, value] of values.entries())
    validateV4Root(value, `${path}/${index}`);
  const sorted = [...values].sort(asciiCompare);
  if (new Set(sorted).size !== sorted.length)
    fault(
      "stable-publication-provider-confirmation-mismatch",
      path,
      `${path} must not contain duplicate roots`,
    );
  return sorted;
}

function validateCandidate(candidate) {
  exactKeys(
    candidate,
    [
      "generation",
      "commit",
      "sourceRoot",
      "metadataRoot",
      "journalRoot",
      "protectedAncestryRoot",
    ],
    "$/candidate",
  );
  validateGeneration(candidate.generation, "$/candidate/generation");
  if (typeof candidate.commit !== "string" || !COMMIT.test(candidate.commit))
    fault(
      "invalid-stable-publication-commit",
      "$/candidate/commit",
      "candidate commit must be a lowercase 40-byte Git object id",
    );
  for (const field of [
    "sourceRoot",
    "metadataRoot",
    "journalRoot",
    "protectedAncestryRoot",
  ])
    validateV4Root(candidate[field], `$/candidate/${field}`);
  return structuredClone(candidate);
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0)
    fault(
      "invalid-stable-publication-target",
      "$/targets",
      "at least one shadow publication target is required",
    );
  const normalized = targets.map((target, index) => {
    const path = `$/targets/${index}`;
    exactKeys(
      target,
      ["id", "kind", "desired", "providerConfirmationRoot"],
      path,
    );
    validateToken(target.id, `${path}/id`);
    if (!TARGET_KINDS.has(target.kind))
      fault(
        "invalid-stable-publication-target",
        `${path}/kind`,
        "publication target kind is unsupported",
      );
    if (
      typeof target.desired !== "string" ||
      target.desired.length === 0 ||
      target.desired.length > 200 ||
      [...target.desired].some((character) => {
        const code = character.codePointAt(0);
        return code < 0x21 || code > 0x7e;
      })
    )
      fault(
        "invalid-stable-publication-target",
        `${path}/desired`,
        "desired target must be non-empty printable ASCII without whitespace",
      );
    validateV4Root(
      target.providerConfirmationRoot,
      `${path}/providerConfirmationRoot`,
    );
    const payload = structuredClone(target);
    return {
      ...payload,
      targetRoot: v4ContentRoot("stable-publication-target", payload),
    };
  });
  normalized.sort((left, right) => asciiCompare(left.id, right.id));
  if (
    new Set(normalized.map(({ id }) => id)).size !== normalized.length ||
    new Set(normalized.map(({ kind }) => kind)).size !== normalized.length
  )
    fault(
      "conflicting-stable-publication-target",
      "$/targets",
      "publication target ids and kinds must be unique",
    );
  return normalized;
}

function validateQualification(request, candidate, candidateRoot, targets) {
  const qualification = request.qualification;
  exactKeys(
    qualification,
    [
      "mode",
      "authorityGeneration",
      "qualifiedCandidateRoot",
      "qualifierAuthorityRoot",
      "sealRoot",
      "sourceRoot",
      "metadataRoot",
      "journalRoot",
      "protectedAncestryRoot",
      "providerConfirmationRoots",
    ],
    "$/qualification",
  );
  if (!new Set(["n-minus-one", "independent-seal"]).has(qualification.mode))
    fault(
      "invalid-stable-publication-qualification",
      "$/qualification/mode",
      "qualification mode is unsupported",
    );
  validateGeneration(
    qualification.authorityGeneration,
    "$/qualification/authorityGeneration",
  );
  for (const field of [
    "qualifiedCandidateRoot",
    "qualifierAuthorityRoot",
    "sealRoot",
    "sourceRoot",
    "metadataRoot",
    "journalRoot",
    "protectedAncestryRoot",
  ])
    validateV4Root(qualification[field], `$/qualification/${field}`);
  if (qualification.qualifiedCandidateRoot !== candidateRoot)
    fault(
      "stable-publication-candidate-root-mismatch",
      "$/qualification/qualifiedCandidateRoot",
      "qualification must bind the exact candidate root",
    );
  if (
    qualification.mode === "n-minus-one" &&
    qualification.authorityGeneration + 1 !== candidate.generation
  )
    fault(
      "stable-publication-self-qualification",
      "$/qualification/authorityGeneration",
      "N-1 qualification must come from the immediately preceding generation",
    );
  if (
    qualification.mode === "independent-seal" &&
    qualification.authorityGeneration > candidate.generation
  )
    fault(
      "stable-publication-self-qualification",
      "$/qualification/authorityGeneration",
      "independent sealed authority cannot come from a future generation",
    );
  if (qualification.qualifierAuthorityRoot === request.publisherAuthorityRoot)
    fault(
      "stable-publication-authority-mismatch",
      "$/qualification/qualifierAuthorityRoot",
      "qualification and publication authorities must be independent",
    );
  const coordinateFaults = [
    ["sourceRoot", "stable-publication-source-mismatch"],
    ["metadataRoot", "stable-publication-metadata-mismatch"],
    ["journalRoot", "stable-publication-journal-mismatch"],
    ["protectedAncestryRoot", "stable-publication-ancestry-mismatch"],
  ];
  for (const [field, code] of coordinateFaults)
    if (qualification[field] !== candidate[field])
      fault(
        code,
        `$/qualification/${field}`,
        `qualification ${field} must match the exact candidate coordinate`,
      );
  const qualifiedConfirmations = normalizeRoots(
    qualification.providerConfirmationRoots,
    "$/qualification/providerConfirmationRoots",
  );
  const targetConfirmations = targets
    .map(({ providerConfirmationRoot }) => providerConfirmationRoot)
    .sort(asciiCompare);
  if (
    qualifiedConfirmations.length !== targetConfirmations.length ||
    qualifiedConfirmations.some(
      (root, index) => root !== targetConfirmations[index],
    )
  )
    fault(
      "stable-publication-provider-confirmation-mismatch",
      "$/qualification/providerConfirmationRoots",
      "qualification must bind every exact provider confirmation and no others",
    );
  const payload = {
    ...structuredClone(qualification),
    providerConfirmationRoots: qualifiedConfirmations,
  };
  return {
    ...payload,
    qualificationRoot: v4ContentRoot(
      "stable-publication-qualification",
      payload,
    ),
  };
}

export function planV4StablePublication(request) {
  exactKeys(
    request,
    [
      "schema",
      "declaredAt",
      "candidate",
      "qualification",
      "publisherAuthorityRoot",
      "targets",
    ],
    "$",
  );
  if (request.schema !== V4_STABLE_PUBLICATION_REQUEST_CONTRACT)
    fault(
      "unsupported-stable-publication-version",
      "$/schema",
      "stable publication request version is unsupported",
    );
  validateV4Clock(request.declaredAt, "$/declaredAt");
  validateV4Root(request.publisherAuthorityRoot, "$/publisherAuthorityRoot");
  const candidate = validateCandidate(request.candidate);
  const candidateRoot = v4ContentRoot(
    "stable-publication-candidate",
    candidate,
  );
  const targets = normalizeTargets(request.targets);
  const qualification = validateQualification(
    request,
    candidate,
    candidateRoot,
    targets,
  );
  const payload = {
    schema: V4_STABLE_PUBLICATION_PLAN_CONTRACT,
    mode: "production",
    productionAuthority: "v4",
    declaredAt: request.declaredAt,
    candidate,
    candidateRoot,
    qualification,
    publisherAuthorityRoot: request.publisherAuthorityRoot,
    targets,
  };
  return {
    ...payload,
    planRoot: v4ContentRoot("stable-publication-plan", payload),
  };
}

export function projectV4StablePublication(request) {
  const plan = planV4StablePublication(request);
  const payload = {
    schema: V4_STABLE_PUBLICATION_FENCE_CONTRACT,
    decision: "allow-publication",
    effectCount: plan.targets.length,
    candidateRoot: plan.candidateRoot,
    qualificationMode: plan.qualification.mode,
    qualificationRoot: plan.qualification.qualificationRoot,
    planRoot: plan.planRoot,
  };
  return {
    plan,
    fence: {
      ...payload,
      fenceRoot: v4ContentRoot("stable-publication-fence", payload),
    },
  };
}
