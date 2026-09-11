import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { writeReleaseLineBootstrapVersionState } from "../release-line-bootstrap.js";
import { assertLineApply } from "./request.js";
export function applyLineSource(
  { plan, apply },
  {
    execute = command,
    writeVersion = writeReleaseLineBootstrapVersionState,
  } = {},
) {
  assertLineApply(apply);
  const run = (args, options = {}) =>
    execute("git", args, { cwd: plan.cwd, ...options });
  if (run(["rev-parse", "HEAD"], { stdio: "pipe" }).trim() !== plan.source.sha)
    throw new Error("Source changed after release line planning");
  if (
    run(["status", "--porcelain", "--untracked-files=all"], {
      stdio: "pipe",
    }).trim()
  )
    throw new Error("Source checkout changed after planning");
  const written = writeVersion({
    cwd: plan.cwd,
    major: plan.major,
    minor: plan.minor,
    sourceRef: plan.source.ref,
    initialVersion: plan.initialVersion,
  });
  if (
    written.source.sha !== plan.source.sha ||
    written.initialVersion !== plan.initialVersion ||
    !written.changedFiles.length
  )
    throw new Error("Version state does not match the release line plan");
  for (const file of written.changedFiles)
    if (path.isAbsolute(file) || file.split(/[\\/]/u).includes(".."))
      throw new Error("Version output escapes the release line checkout");
  run(["add", "--", ...written.changedFiles]);
  run([
    "-c",
    "user.name=Keren Dong",
    "-c",
    "user.email=keren.dong@kungfu.link",
    "commit",
    "-s",
    "-m",
    `chore(release): open ${plan.line}`,
  ]);
  const devSha = run(["rev-parse", "HEAD"], { stdio: "pipe" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(devSha))
    throw new Error("Release line version commit must be exact");
  const refs = [
    [devSha, plan.refs.bootstrap],
    [devSha, plan.refs.dev],
    [plan.source.sha, plan.refs.alpha],
    [plan.source.sha, plan.refs.release],
  ];
  for (const [sha, ref] of refs) {
    run(["push", "origin", `${sha}:refs/heads/${ref}`]);
    const readback = run(
      ["ls-remote", "--refs", "origin", `refs/heads/${ref}`],
      { stdio: "pipe" },
    )
      .trim()
      .split(/\s+/u);
    if (
      readback.length !== 2 ||
      readback[0] !== sha ||
      readback[1] !== `refs/heads/${ref}`
    )
      throw new Error(`Release line ref did not read back exactly: ${ref}`);
  }
  return {
    devSha,
    refs: refs.map(([sha, ref]) => ({ sha, ref })),
    changedFiles: written.changedFiles,
  };
}
