export function lifecycleErrorAttributes(error, extra = {}) {
  const attributes = {
    ...extra,
    errorName: error.name,
    status: error.status ?? "",
    signal: error.signal || "",
  };
  if (error.stdoutTail) {
    attributes.stdoutTail = error.stdoutTail;
  }
  if (error.stderrTail) {
    attributes.stderrTail = error.stderrTail;
  }
  if (error.wrappedCommand) {
    attributes.wrappedCommand = error.wrappedCommand;
    attributes.wrappedCommandExitCode = error.wrappedCommand.exitCode ?? "";
    attributes.wrappedCommandSignal = error.wrappedCommand.signal || "";
    attributes.wrappedCommandError = error.wrappedCommand.error || "";
  }
  if (error.samplerUnavailable !== undefined) {
    attributes.samplerUnavailable = error.samplerUnavailable;
  }
  return attributes;
}

export function describeLifecycleTimeout(
  error,
  { timeoutMinutes, stageName, platformId, platformName },
) {
  if (
    !timeoutMinutes ||
    (error?.code !== "ETIMEDOUT" && error?.signal !== "SIGTERM")
  ) {
    return error;
  }
  const timeoutError = new Error(
    `lifecycle ${stageName || "command"} timed out after ${timeoutMinutes} minute(s) on ${platformName} (${platformId})`,
    { cause: error },
  );
  timeoutError.name = "LifecycleTimeoutError";
  timeoutError.code = "ETIMEDOUT";
  timeoutError.signal = error?.signal || "";
  return timeoutError;
}
