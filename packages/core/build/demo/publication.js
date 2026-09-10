import path from "node:path";
import { command, requireValue } from "../../runtime/action-process.mjs";
import { exactRemoteBranch } from "../../providers/git-ref-readback.mjs";
import { materializeDemo } from "./materialization.js";
import { demoScenario } from "./collection-context.js";
export function demoBranchName(sha) {
  requireValue(
    /^[0-9a-f]{40}$/.test(sha || ""),
    "Demo source SHA must be exact",
  );
  return `automation/auditable-demo-${sha.slice(0, 12)}`;
}
export function establishDemoBranch(request, execute = command) {
  const cwd = path.join(request.workspace, "source"),
    branch = demoBranchName(request.sourceSha);
  const remote = exactRemoteBranch(branch, execute, cwd);
  if (remote) {
    execute(
      "git",
      ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd },
    );
    execute("git", ["switch", "-c", branch, "--track", `origin/${branch}`], {
      cwd,
    });
    execute("git", ["merge-base", "--is-ancestor", request.sourceSha, "HEAD"], {
      cwd,
    });
  } else execute("git", ["switch", "-c", branch], { cwd });
}
export function materializeDemoCollection(
  request,
  materialize = materializeDemo,
) {
  const { repository, scenarioPath, scenario } = demoScenario(request);
  for (const demo of scenario.demos)
    materialize({
      repositoryRoot: repository,
      scenarioPath,
      demoId: demo.id,
      captureRoot: path.join(
        request.workspace,
        `.demo-input/captures/${demo.id}/capture`,
      ),
      gateBundle: path.join(
        request.workspace,
        `.demo-input/qualified/${demo.id}/gate`,
      ),
      mediaBundle: path.join(
        request.workspace,
        `.demo-input/qualified/${demo.id}/media`,
      ),
      buildchainSha: request.runtimeSha,
      rendererImage: request.rendererImage,
    });
}
export async function publishDemoPullRequest(
  request,
  { execute = command, provider },
) {
  const { repository, scenario } = demoScenario(request);
  const branch = demoBranchName(request.sourceSha);
  const git = (args, pipe = false) =>
    execute("git", args, { cwd: repository, stdio: pipe ? "pipe" : "inherit" });
  requireValue(
    git(["branch", "--show-current"], true).trim() === branch,
    "Current branch differs from exact demo update branch",
  );
  const rows = await provider.listOpen({ head: branch, base: request.baseRef });
  requireValue(
    rows.length <= 1,
    "Demo materialization has multiple matching pull requests",
  );
  const files = [
    scenario.publication.readmePath,
    scenario.publication.evidencePath,
  ];
  if (scenario.presentation)
    files.push(scenario.presentation.materialization.technicalSpecPath);
  git(["add", "--", ...files]);
  const changed = Boolean(git(["diff", "--cached", "--name-only", "-z"], true));
  if (changed) {
    git([
      "-c",
      "user.name=github-actions[bot]",
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "-s",
      "-m",
      "docs: refresh auditable demo media",
    ]);
    git(["push", "origin", `HEAD:refs/heads/${branch}`]);
    const source = git(["rev-parse", "HEAD"], true).trim();
    requireValue(
      exactRemoteBranch(branch, execute, repository) === source,
      "Demo branch readback differs from the pushed commit",
    );
  }
  let url = rows[0]?.html_url || "";
  if (!url && changed)
    url = (
      await provider.create({
        base: request.baseRef,
        head: branch,
        title: "docs: refresh auditable demo media",
        body: "Refreshes content-addressed auditable demo media from the exact declared standalone binary, qualified Gate, immutable renderer, and Release Passport. Identity and Product System metadata grant no authority.",
      })
    ).html_url;
  return url;
}
export async function publishDemoCollection(request, ports = {}) {
  if (!request.baseRef)
    throw new Error("materialize-base-ref is required for publication");
  establishDemoBranch(request, ports.execute);
  materializeDemoCollection(request, ports.materialize);
  return publishDemoPullRequest(request, ports);
}
