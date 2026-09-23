// Retain old selector names at the historical workflow boundary. The selected
// runtime still goes through the same lock validation and trusted recovery gate.
export function historicalEntrySelection(value, workflowRef) {
  if (!value) return {};
  const inputs = typeof value === "string" ? JSON.parse(value) : value;
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
    throw new Error("Historical entry inputs must be an object");
  const read = (name, fallback = "") => {
    const result = inputs[name] ?? fallback;
    if (typeof result !== "string")
      throw new Error(`Invalid historical selector: ${name}`);
    return result;
  };
  if (
    read("buildchain-repository", "kungfu-systems/buildchain") !==
    "kungfu-systems/buildchain"
  )
    throw new Error(
      "Historical entry requires the official Buildchain repository",
    );
  const calledChannel = /@(?:refs\/tags\/)?v4-alpha$/u.test(workflowRef)
    ? "alpha"
    : "stable";
  const requested = read("buildchain-channel", "auto");
  if (!["auto", "alpha", "stable"].includes(requested))
    throw new Error("Invalid historical Buildchain channel");
  const channel = requested === "auto" ? calledChannel : requested;
  const ref = read("buildchain-ref").replace(/^v[23](-alpha)?$/u, "v4$1");
  const stableLock = read(
    "buildchain-stable-contract-lock-path",
    ".buildchain/contract-lock.json",
  );
  const alphaLock = read(
    "buildchain-alpha-contract-lock-path",
    ".buildchain/alpha-contract-lock.json",
  );
  return {
    runtimeRef:
      ref && ref !== (calledChannel === "alpha" ? "v4-alpha" : "v4") ? ref : "",
    lockPath:
      read("buildchain-contract-lock-path") ||
      (channel === "alpha" ? alphaLock : stableLock),
    channel,
    stableLock,
    alphaLock,
  };
}
