import { command } from "../runtime/action-process.mjs";

export function createGitHubCliApi(execute = command, env = process.env) {
  function invoke(method, endpoint, body, flags = []) {
    const output = execute(
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
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
