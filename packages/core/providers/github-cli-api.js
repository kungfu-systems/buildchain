import { execFileSync } from "node:child_process";

function apiFailure(cause) {
  let response;
  try {
    response = JSON.parse(String(cause.stdout || ""));
  } catch {
    // Process diagnostics are not a provider response and may contain secrets.
  }
  const messages = Array.isArray(response?.errors)
    ? response.errors
        .map((error) => error.message)
        .filter((message) => typeof message === "string")
    : [];
  const message =
    messages.join("; ") ||
    (typeof response?.message === "string" ? response.message : "") ||
    `GitHub API command failed with exit code ${cause.status ?? 1}`;
  const error = new Error(message);
  error.exitCode = cause.status ?? 1;
  const status = Number(response?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599)
    error.status = status;
  if (cause.code) error.code = cause.code;
  return error;
}

export function createGitHubCliApi(execute = execFileSync, env = process.env) {
  function invoke(method, endpoint, body, flags = []) {
    let output;
    try {
      output = execute(
        "gh",
        [
          "api",
          "--method",
          method,
          endpoint,
          "-H",
          "Accept: application/vnd.github+json",
          ...flags,
          ...(body === undefined ? [] : ["--input", "-"]),
        ],
        {
          env,
          encoding: "utf8",
          input: body === undefined ? undefined : JSON.stringify(body),
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (error) {
      throw apiFailure(error);
    }
    return output?.trim() ? JSON.parse(output) : {};
  }
  return {
    request: invoke,
    json: (endpoint) => invoke("GET", endpoint),
    pages: (endpoint, field) =>
      invoke("GET", endpoint, undefined, ["--paginate", "--slurp"]).flatMap(
        (page) => (field ? page[field] : page),
      ),
    post: (endpoint, body) => invoke("POST", endpoint, body),
  };
}
