import { consumerContractLock } from "../../consumer/contract/identity.js";
import { canonicalJson } from "../../release/discussion/envelope.js";

const exactSha = /^[a-f0-9]{40}$/iu;
const repository = "kungfu-systems/buildchain";
const trainRef =
  /^(?:refs\/(?:heads|tags)\/)?train\/v4\/v4\.\d+\/[a-zA-Z0-9._/-]+$/u;

function commit(value, label) {
  if (!exactSha.test(value || ""))
    throw new Error(`${label} must resolve to an exact commit`);
  return value.toLowerCase();
}

export function runtimeSelector({ runtimeRef = "", lock, workflowSha }) {
  if (runtimeRef) {
    if (
      runtimeRef
        .split("/")
        .some((part) => part === ".." || part === "." || part === "")
    )
      throw new Error("Runtime parameter contains an unsafe reference");
    if (
      !exactSha.test(runtimeRef) &&
      !trainRef.test(runtimeRef) &&
      !["v4", "v4-alpha"].includes(runtimeRef)
    )
      throw new Error(
        "Runtime parameter must name an exact commit, channel or train",
      );
    return { ref: runtimeRef, origin: "runtime-parameter" };
  }
  if (lock) {
    if (lock.schema === "buildchain.consumer-contract-lock/v2") {
      const validated = consumerContractLock(lock);
      if (canonicalJson(validated) !== canonicalJson(lock))
        throw new Error(
          "Minimal consumer contract lock contains unsupported fields",
        );
      return { ref: validated.runtime.sha, origin: "consumer-contract-lock" };
    }
    if (lock.contract !== "kungfu-buildchain-contract-lock")
      throw new Error("Unsupported Buildchain contract lock");
    const sha = commit(lock.buildchain?.resolvedSha, "Contract lock runtime");
    if (
      lock.schemaVersion !== 1 ||
      !["v4", "v4-alpha"].includes(lock.buildchain.ref) ||
      !/^sha256:[0-9a-f]{64}$/u.test(lock.buildchain.contractDigest || "")
    )
      throw new Error(
        "Contract lock must declare its channel and contract digest",
      );
    return {
      ref: sha,
      origin: "contract-lock",
    };
  }
  return {
    ref: commit(workflowSha, "Workflow default"),
    origin: "workflow-default",
  };
}

export function preparedRuntimeSelection(value) {
  if (
    value?.schema !== "buildchain.runtime-selection/v1" ||
    value.repository !== repository ||
    value.protocol !== 1
  )
    throw new Error("Unsupported runtime selection");
  return { ...value, sha: commit(value.sha, "Selected runtime") };
}

export async function selectExecutionRuntime(
  request,
  { resolveRef, authorize, readProtocol },
) {
  const selected = runtimeSelector(request);
  // Authorization belongs to entry selection, never to subsequent business nodes.
  await authorize({ ...selected, repository });
  const sha = exactSha.test(selected.ref)
    ? selected.ref.toLowerCase()
    : commit(
        await resolveRef({ repository, ref: selected.ref }),
        "Runtime reference",
      );
  const protocol = await readProtocol({ repository, sha });
  if (
    protocol?.schema !== "buildchain.runtime-entry/v1" ||
    protocol.protocol !== 1
  )
    throw new Error("Selected runtime does not implement the entry protocol");
  return {
    schema: "buildchain.runtime-selection/v1",
    protocol: 1,
    repository,
    sha,
    ref:
      selected.origin === "contract-lock"
        ? request.lock.buildchain.ref || selected.ref
        : selected.ref,
    origin: selected.origin,
    ...(selected.origin === "contract-lock"
      ? { contract: { digest: request.lock.buildchain.contractDigest } }
      : {}),
    ...(selected.origin === "consumer-contract-lock"
      ? { contract: { consumerConfigDigest: request.lock.configDigest } }
      : {}),
    class:
      selected.origin === "contract-lock" &&
      request.lock.buildchain.ref === "v4-alpha"
        ? "alpha"
        : selected.origin === "contract-lock" &&
            request.lock.buildchain.ref === "v4"
          ? "stable"
          : trainRef.test(selected.ref)
            ? "train"
            : selected.ref === "v4-alpha"
              ? "alpha"
              : selected.ref === "v4"
                ? "stable"
                : "exact-sha",
  };
}
