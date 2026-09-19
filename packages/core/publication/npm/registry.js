import { spawnSyncCommand } from "../../runtime/spawn-command.js";
export function runNpm({ cwd, args, env, allowFailure = false }) {
  const result = spawnSyncCommand("npm", args, {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    throw Object.assign(
      new Error(
        `npm ${args.join(" ")} failed\n${result.stdout || ""}${result.stderr || ""}`.trim(),
      ),
      { status: result.status ?? 1 },
    );
  }
  return result;
}

export function parseNpmView(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) throw new Error("npm view omitted its exact package response");
  const value = JSON.parse(raw);
  if (Array.isArray(value) && value.length !== 1)
    throw new Error("npm view must return exactly one package version");
  const parsed = Array.isArray(value) ? value[0] : value;
  if (typeof parsed === "string" && parsed)
    return { integrity: parsed, shasum: "" };
  const dist = parsed?.dist || parsed;
  const result = {
    integrity: dist?.integrity || parsed?.["dist.integrity"] || "",
    shasum: dist?.shasum || parsed?.["dist.shasum"] || "",
  };
  if (!result.integrity && !result.shasum)
    throw new Error("npm view omitted the exact package integrity");
  return result;
}

export function publishedDigest({ cwd, name, version, registry, env }) {
  const result = runNpm({
    cwd,
    env,
    args: [
      "view",
      `${name}@${version}`,
      "dist.integrity",
      "dist.shasum",
      "--json",
      `--registry=${registry}`,
    ],
    allowFailure: true,
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (/\bE404\b|404 Not Found|is not in this registry/i.test(output)) {
      return undefined;
    }
    throw new Error(`npm view ${name}@${version} failed\n${output}`.trim());
  }
  const view = parseNpmView(result.stdout);
  return view.integrity || (view.shasum ? `sha1:${view.shasum}` : "");
}
