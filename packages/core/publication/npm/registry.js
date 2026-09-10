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

function parseNpmView(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) {
    return undefined;
  }
  const parsed = JSON.parse(raw);
  const dist = parsed?.dist || parsed;
  return {
    integrity: dist?.integrity || parsed?.["dist.integrity"] || "",
    shasum: dist?.shasum || parsed?.["dist.shasum"] || "",
  };
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
  if (!view) {
    return undefined;
  }
  return view.integrity || (view.shasum ? `sha1:${view.shasum}` : "");
}
