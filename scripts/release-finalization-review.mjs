import { execFileSync } from "node:child_process";
import { localVersionFiles } from "../actions/release-candidate-promote/product-provider-adapters.js";
import { prepareDevelopmentSource } from "../actions/release-candidate-promote/development-source.js";

export const FINALIZATION_BRANCH = /^chore\/v4-product-pr\/release-v(\d+)-v\1\.(\d+)\/([a-f0-9]{12})-([a-f0-9]{12})-([a-f0-9]{12})$/u;

export function regenerateReleaseFinalization({ baseSha, headSha, version, sourceTimestamp, git }) {
  const source = prepareDevelopmentSource({ cwd: process.cwd(), sourceSha: baseSha });
  try {
    const files = localVersionFiles(source.cwd, { channel: "stable", version, sourceSha: baseSha, sourceTimestamp });
    const allowed = new Map(files.map((file) => [file.path, file.content]));
    const changes = git("diff", "--raw", "--no-renames", baseSha, headSha).split("\n").filter(Boolean);
    if (!changes.length) throw new Error("no stable finalization delta");
    for (const change of changes) {
      const match = change.match(/^:100644 100644 [a-f0-9]+ [a-f0-9]+ M\t(.+)$/u);
      if (!match || !allowed.has(match[1])) throw new Error("undeclared stable finalization delta");
    }
    for (const [file, content] of allowed) {
      const actual = execFileSync("git", ["show", `${headSha}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
      if (!actual.equals(Buffer.from(content))) throw new Error(`stable finalization regeneration mismatch: ${file}`);
    }
    return { version, baseSha, headSha, changedPaths: changes.map((line) => line.split("\t")[1]) };
  } finally {
    source.dispose();
  }
}

export function verifyReleaseFinalization({ client, repository, run, pull, baseSha, git, regenerate = regenerateReleaseFinalization }) {
  const match = FINALIZATION_BRANCH.exec(run.head_branch);
  const parents = git("show", "-s", "--format=%P", run.head_sha).split(" ");
  if (!match || parents.length !== 2 || parents[0] !== baseSha ||
    parents[1].slice(0, 12) !== match[3] || baseSha.slice(0, 12) !== match[4] || run.head_sha.slice(0, 12) !== match[5])
    throw new Error("stable finalization parent or branch identity mismatch");
  const baseVersion = JSON.parse(git("show", `${baseSha}:package.json`)).version;
  const version = JSON.parse(git("show", `${run.head_sha}:package.json`)).version;
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(baseVersion) || version !== baseVersion.split("-alpha.")[0] ||
    !version.startsWith(`${match[1]}.${match[2]}.`)) throw new Error("stable finalization is not the exact alpha successor");
  const prefix = `repos/${repository}`;
  const state = client.json(`${prefix}/git/ref/heads/buildchain/v4-product-state/${baseSha}-${version.replaceAll(".", "-")}`);
  const tag = client.json(`${prefix}/git/ref/tags/v${version}`);
  if (state.object?.sha !== parents[1] || tag.object?.type !== "commit" || tag.object?.sha !== baseSha ||
    git("show", "-s", "--format=%P", parents[1]) !== baseSha ||
    git("rev-parse", `${parents[1]}^{tree}`) !== git("rev-parse", `${run.head_sha}^{tree}`))
    throw new Error("stable finalization state or exact publication tag mismatch");
  const source = client.json(`${prefix}/git/commits/${baseSha}`);
  const sourceTimestamp = new Date(source.committer?.date || source.author?.date).toISOString();
  const projection = regenerate({ baseSha, headSha: run.head_sha, version, sourceTimestamp, git });
  return {
    schema: "buildchain.next-development-review/v1", kind: "stable-finalization",
    repository, runId: run.id, number: pull.number, headSha: run.head_sha, baseSha,
    branch: run.head_branch, publicationSourceSha: baseSha, projection,
  };
}
