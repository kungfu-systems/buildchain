import {
  V4ContractFault,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import {
  V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT,
  v4ProviderOperationJournalStateRoot,
  v4ProviderOperationEntryRoot,
  validateV4ProviderOperationEntry,
} from "./v4-provider-operation-journal.js";

export const V4_PROVIDER_READBACK_SAMPLE_CONTRACT =
  "buildchain-v4-provider-readback-sample/v1";
export const V4_PROVIDER_READBACK_FOLD_CONTRACT =
  "buildchain-v4-provider-readback-fold/v1";

const PROVIDERS = Object.freeze({
  github: {
    schema: "buildchain-v4-github-release-readback/v1",
    subject: "assetSubjectRoot",
    target: "assetTargetRoot",
    statuses: {
      200: "already-applied",
      202: "eventually-visible",
      404: "not-found",
    },
    conflict: 409,
  },
  npm: {
    schema: "buildchain-v4-npm-publication-readback/v1",
    subject: "packageSubjectRoot",
    target: "versionTargetRoot",
    statuses: {
      published: "already-applied",
      processing: "eventually-visible",
      "not-found": "not-found",
    },
    conflict: "conflict",
  },
  oci: {
    schema: "buildchain-v4-oci-manifest-readback/v1",
    subject: "repositorySubjectRoot",
    target: "manifestTargetRoot",
    statuses: {
      200: "already-applied",
      202: "eventually-visible",
      404: "not-found",
    },
    conflict: 409,
  },
});

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("malformed-provider-readback", path, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "malformed-provider-readback",
      path,
      `${path} keys are not canonical`,
    );
}

function validateContext(context) {
  exactKeys(
    context,
    ["operationRoot", "attemptRoot", "subjectRoot", "expectedTargetRoot"],
    "$/context",
  );
  for (const key of Object.keys(context))
    validateV4Root(context[key], `$/context/${key}`);
}

function sampleRoot(sample) {
  const { sampleRoot: _sampleRoot, ...payload } = sample;
  return v4ContentRoot("provider-readback-sample", payload);
}

function validateSample(sample, path = "$/samples") {
  exactKeys(
    sample,
    [
      "schema",
      "operationRoot",
      "attemptRoot",
      "state",
      "observedTargetRoot",
      "evidenceRoots",
      "sampleRoot",
    ],
    path,
  );
  if (sample.schema !== V4_PROVIDER_READBACK_SAMPLE_CONTRACT)
    fault(
      "unsupported-provider-readback-version",
      `${path}/schema`,
      "unsupported provider readback sample schema",
    );
  if (
    !["not-found", "eventually-visible", "already-applied"].includes(
      sample.state,
    )
  )
    fault(
      "malformed-provider-readback",
      `${path}/state`,
      "provider readback state is unsupported",
    );
  for (const key of ["operationRoot", "attemptRoot", "sampleRoot"])
    validateV4Root(sample[key], `${path}/${key}`);
  if (sample.observedTargetRoot !== null)
    validateV4Root(sample.observedTargetRoot, `${path}/observedTargetRoot`);
  if (
    !Array.isArray(sample.evidenceRoots) ||
    sample.evidenceRoots.length === 0 ||
    sample.evidenceRoots.some(
      (root, index) => (
        validateV4Root(root, `${path}/evidenceRoots/${index}`),
        false
      ),
    )
  )
    fault(
      "malformed-provider-readback",
      `${path}/evidenceRoots`,
      "evidenceRoots must not be empty",
    );
  const sortedEvidence = [...new Set(sample.evidenceRoots)].sort();
  if (JSON.stringify(sortedEvidence) !== JSON.stringify(sample.evidenceRoots))
    fault(
      "malformed-provider-readback",
      `${path}/evidenceRoots`,
      "evidenceRoots must be unique and byte-sorted",
    );
  if (
    (sample.state === "already-applied") !==
    (sample.observedTargetRoot !== null)
  )
    fault(
      "malformed-provider-readback",
      `${path}/observedTargetRoot`,
      "only already-applied readback may carry an observed target root",
    );
  if (sample.sampleRoot !== sampleRoot(sample))
    fault(
      "provider-readback-root-mismatch",
      `${path}/sampleRoot`,
      "sampleRoot does not bind the provider-neutral readback",
    );
  return sample;
}

function adaptProviderReadback(provider, response, context) {
  const descriptor = PROVIDERS[provider];
  if (!descriptor)
    fault(
      "unsupported-provider-readback-version",
      "$/provider",
      "provider readback adapter is unsupported",
    );
  validateContext(context);
  exactKeys(
    response,
    ["schema", "status", descriptor.subject, descriptor.target, "evidenceRoot"],
    "$/response",
  );
  if (response.schema !== descriptor.schema)
    fault(
      "unsupported-provider-readback-version",
      "$/response/schema",
      "provider response schema does not match its adapter",
    );
  validateV4Root(
    response[descriptor.subject],
    `$/response/${descriptor.subject}`,
  );
  validateV4Root(response.evidenceRoot, "$/response/evidenceRoot");
  if (response[descriptor.target] !== null)
    validateV4Root(
      response[descriptor.target],
      `$/response/${descriptor.target}`,
    );
  if (response[descriptor.subject] !== context.subjectRoot)
    fault(
      "provider-readback-root-mismatch",
      `$/response/${descriptor.subject}`,
      "provider response subject does not bind the operation subject",
    );
  if (response.status === descriptor.conflict)
    fault(
      "conflicting-provider-readback",
      "$/response/status",
      "provider reported a conflicting target",
    );
  const state = descriptor.statuses[response.status];
  if (!state)
    fault(
      "malformed-provider-readback",
      "$/response/status",
      "provider response status is unsupported",
    );
  const observedTargetRoot = response[descriptor.target];
  if (state === "already-applied") {
    if (observedTargetRoot !== context.expectedTargetRoot)
      fault(
        "provider-readback-root-mismatch",
        `$/response/${descriptor.target}`,
        "successful provider response does not bind the expected target",
      );
  } else if (observedTargetRoot !== null) {
    fault(
      "conflicting-provider-readback",
      `$/response/${descriptor.target}`,
      "non-success provider response carries an ambiguous target",
    );
  }
  const sample = {
    schema: V4_PROVIDER_READBACK_SAMPLE_CONTRACT,
    operationRoot: context.operationRoot,
    attemptRoot: context.attemptRoot,
    state,
    observedTargetRoot,
    evidenceRoots: [response.evidenceRoot],
    sampleRoot:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  sample.sampleRoot = sampleRoot(sample);
  return validateSample(sample);
}

export function adaptV4GitHubReleaseReadback(response, context) {
  return adaptProviderReadback("github", response, context);
}

export function adaptV4NpmPublicationReadback(response, context) {
  return adaptProviderReadback("npm", response, context);
}

export function adaptV4OciManifestReadback(response, context) {
  return adaptProviderReadback("oci", response, context);
}

export function foldV4ProviderReadbackSamples(samples, coordinates) {
  exactKeys(
    coordinates,
    [
      "sequence",
      "priorEntryRoot",
      "operationRoot",
      "attemptRoot",
      "observedAt",
    ],
    "$/coordinates",
  );
  if (!Number.isSafeInteger(coordinates.sequence) || coordinates.sequence < 0)
    fault(
      "malformed-provider-readback",
      "$/coordinates/sequence",
      "readback sequence must be a non-negative safe integer",
    );
  for (const key of ["priorEntryRoot", "operationRoot", "attemptRoot"])
    validateV4Root(coordinates[key], `$/coordinates/${key}`);
  validateV4Clock(coordinates.observedAt, "$/coordinates/observedAt");
  if (!Array.isArray(samples) || samples.length === 0)
    fault(
      "malformed-provider-readback",
      "$/samples",
      "at least one rooted provider readback sample is required",
    );
  const unique = new Map();
  for (const [index, sample] of samples.entries()) {
    validateSample(sample, `$/samples/${index}`);
    if (
      sample.operationRoot !== coordinates.operationRoot ||
      sample.attemptRoot !== coordinates.attemptRoot
    )
      fault(
        "provider-readback-coordinate-mismatch",
        `$/samples/${index}`,
        "provider readback sample does not bind the journal coordinates",
      );
    unique.set(sample.sampleRoot, sample);
  }
  const folded = [...unique.values()].sort((left, right) =>
    left.sampleRoot.localeCompare(right.sampleRoot),
  );
  const states = new Set(folded.map((sample) => sample.state));
  if (states.has("already-applied") && states.size !== 1)
    fault(
      "conflicting-provider-readback",
      "$/samples",
      "successful and unresolved readbacks cannot describe one attempt",
    );
  const targets = new Set(
    folded.map((sample) => sample.observedTargetRoot).filter(Boolean),
  );
  if (targets.size > 1)
    fault(
      "conflicting-provider-readback",
      "$/samples",
      "provider readbacks disagree about the observed target",
    );
  const classification = states.has("already-applied")
    ? "already-applied"
    : states.has("eventually-visible")
      ? "eventually-visible"
      : "not-found";
  const readbackRoots = folded.map((sample) => sample.sampleRoot);
  const observation = {
    kind: "observation",
    schema: V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT,
    sequence: coordinates.sequence,
    priorEntryRoot: coordinates.priorEntryRoot,
    operationRoot: coordinates.operationRoot,
    attemptRoot: coordinates.attemptRoot,
    observedAt: coordinates.observedAt,
    status: classification === "already-applied" ? "succeeded" : "unknown",
    evidenceRoots: readbackRoots,
    entryRoot:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  observation.entryRoot = v4ProviderOperationEntryRoot(observation);
  validateV4ProviderOperationEntry(observation);
  const projection = {
    schema: V4_PROVIDER_READBACK_FOLD_CONTRACT,
    classification,
    readbackRoots,
    observation,
    projectionRoot:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  };
  const { projectionRoot: _projectionRoot, ...payload } = projection;
  projection.projectionRoot = v4ContentRoot("provider-readback-fold", payload);
  return projection;
}

const ADAPTERS = Object.freeze({
  github: adaptV4GitHubReleaseReadback,
  npm: adaptV4NpmPublicationReadback,
  oci: adaptV4OciManifestReadback,
});

export function projectV4ProviderReadbackFixtures(fixtures) {
  const projectCase = (fixture) => {
    const samples = fixture.readbacks.map(({ provider, response }) =>
      ADAPTERS[provider](response, fixtures.context),
    );
    if (JSON.stringify(samples) !== JSON.stringify(fixture.neutralSamples))
      fault(
        "provider-readback-fixture-mismatch",
        "$/neutralSamples",
        "provider adapters did not produce the retained neutral samples",
      );
    const projection = foldV4ProviderReadbackSamples(
      samples,
      fixtures.coordinates,
    );
    return {
      id: fixture.id,
      ...projection,
      journalStateRoot: v4ProviderOperationJournalStateRoot([
        ...fixtures.journalPrefix,
        projection.observation,
      ]),
    };
  };
  const validCases = fixtures.validCases.map(projectCase);
  const invalidCases = fixtures.invalidCases.map((fixture) => {
    try {
      projectCase(fixture);
    } catch (error) {
      if (error instanceof V4ContractFault)
        return { id: fixture.id, fault: error.code };
      throw error;
    }
    fault(
      "malformed-provider-readback",
      "$/invalidCases",
      `fixture ${fixture.id} unexpectedly passed`,
    );
  });
  return { validCases, invalidCases };
}
