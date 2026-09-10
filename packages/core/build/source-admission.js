import { command, requireValue } from "../runtime/action-process.mjs";

export function admitSource(
  { outcome, directory = ".", expectedSha = "" },
  execute = command,
) {
  requireValue(
    outcome === "success",
    "Source checkout did not succeed; business execution is forbidden",
  );
  if (!expectedSha) return {};
  requireValue(
    /^[0-9a-f]{40}$/u.test(expectedSha),
    "Source admission requires an exact 40-hex commit",
  );
  const sha = execute(
    "git",
    ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"],
    { stdio: "pipe" },
  ).trim();
  requireValue(
    sha === expectedSha,
    "Source checkout does not match the admitted commit",
  );
  return { sha };
}

export function sourceAdmissionAction(core) {
  const result = admitSource({
    outcome: core.getInput("source-checkout-outcome", { required: true }),
    directory: core.getInput("directory") || ".",
    expectedSha: core.getInput("expected-sha"),
  });
  if (result.sha) core.setOutput("sha", result.sha);
}
