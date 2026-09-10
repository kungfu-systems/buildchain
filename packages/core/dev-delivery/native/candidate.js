import { execFileSync } from "node:child_process";
import { exactSha as exactLocalSha } from "../warrant/values.js";
export class LocalTwoPhaseClient {
  constructor({ candidateDirectory } = {}) {
    this.candidateDirectory = candidateDirectory;
  }

  git(args, options = {}) {
    return execFileSync("git", ["-C", this.candidateDirectory, ...args], {
      encoding: "utf8",
      ...options,
    }).trim();
  }

  async baseSha(branch) {
    return exactLocalSha(
      this.git(["rev-parse", `refs/remotes/origin/${branch}`]),
      "protected base SHA",
    );
  }

  async exactPullRequestHead(_pullRequestNumber, expectedHead) {
    const observed = exactLocalSha(this.git(["rev-parse", "HEAD"]), "PR head");
    if (observed !== expectedHead)
      throw new Error(
        `semantic source head changed: ${observed} != ${expectedHead}`,
      );
    return observed;
  }

  async baseDelta(previousBase, currentBase) {
    if (previousBase === currentBase)
      return {
        graphKnown: true,
        attributionComplete: true,
        changedPaths: [],
        renames: [],
      };
    try {
      this.git(["merge-base", "--is-ancestor", previousBase, currentBase]);
    } catch {
      return {
        graphKnown: false,
        attributionComplete: false,
        changedPaths: [],
        renames: [],
      };
    }
    const entries = this.git([
      "diff",
      "--name-status",
      "-M",
      previousBase,
      currentBase,
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const renames = entries
      .filter(([status]) => status.startsWith("R"))
      .map(([, from, to]) => ({ from, to }));
    return {
      graphKnown: true,
      attributionComplete: renames.every(({ from, to }) => from && to),
      changedPaths: [
        ...new Set(entries.flatMap(([, ...paths]) => paths).filter(Boolean)),
      ].sort(),
      renames,
    };
  }
}

export function composeCandidate(candidateDirectory, expectedHead, baseSha) {
  try {
    execFileSync("git", ["-C", candidateDirectory, "merge", "--abort"], {
      stdio: "ignore",
    });
  } catch {
    // No merge was active.
  }
  execFileSync(
    "git",
    ["-C", candidateDirectory, "reset", "--hard", expectedHead],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "git",
    ["-C", candidateDirectory, "merge", "--no-commit", "--no-ff", baseSha],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: "Buildchain Delivery Warrant",
        GIT_COMMITTER_EMAIL:
          "buildchain-delivery-warrant@users.noreply.github.com",
      },
    },
  );
}
