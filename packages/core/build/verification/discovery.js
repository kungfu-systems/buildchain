import { execFileSync } from "node:child_process";
import { workflow, hash } from "./identity.js";
import { planVerification } from "./proof.js";
// Only the one bounded proof file is read; archive paths are never extracted.
export function readProofArchive(archive, digest) {
  if (hash(archive) !== digest)
    throw new Error("artifact archive digest mismatch");
  const source = [
    "import io,json,sys,zipfile",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "entries=[e for e in z.infolist() if e.filename=='evidence.json']",
    "assert len(entries)==1 and entries[0].file_size <= 1048576, 'invalid proof archive'",
    "sys.stdout.buffer.write(z.read(entries[0]))",
  ].join("\n");
  return JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-c", source],
      {
        input: archive,
        maxBuffer: 1048576,
        encoding: "utf8",
      },
    ),
  );
}

export async function discoverVerification({
  expected,
  evaluatedAtMs,
  fetchJson,
  fetchArchive,
}) {
  const prefix = `repos/${expected.repository}/actions`;
  const response = await fetchJson(
    `${prefix}/workflows/self-build-verify.yml/runs?event=merge_group&status=success&head_sha=${expected.sourceSha}&per_page=10`,
  );
  const reasons = [];
  for (const listed of response.workflow_runs || []) {
    try {
      const run = await fetchJson(`${prefix}/runs/${listed.id}`);
      if (
        run.repository?.full_name !== expected.repository ||
        run.head_sha !== expected.sourceSha ||
        run.path !== workflow ||
        run.event !== "merge_group" ||
        run.conclusion !== "success" ||
        run.status !== "completed"
      )
        throw new Error("untrusted evidence run");
      const assets = await fetchJson(
        `${prefix}/runs/${run.id}/artifacts?per_page=100`,
      );
      const matches = (assets.artifacts || []).filter(
        (a) =>
          a.name === `source-verification-${run.head_sha}-${run.run_attempt}`,
      );
      if (
        matches.length !== 1 ||
        matches[0].expired ||
        matches[0].size_in_bytes > 1048576
      )
        throw new Error("missing or expired proof artifact");
      const asset = matches[0];
      const candidate = readProofArchive(
        await fetchArchive(`${prefix}/artifacts/${asset.id}/zip`),
        asset.digest,
      );
      const decision = planVerification({
        expected,
        evaluatedAtMs,
        candidate,
        provider: {
          repository: run.repository.full_name,
          runId: String(run.id),
          runAttempt: run.run_attempt,
          headSha: run.head_sha,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          workflowPath: run.path,
          artifactDigest: asset.digest,
        },
      });
      if (decision.decision === "reuse")
        return { ...decision, sourceSha: expected.sourceSha };
      reasons.push(decision.reason);
    } catch {
      // Provider/transport or evidence failures are cache misses, never a green check.
      reasons.push("unavailable-or-invalid-evidence");
    }
  }
  return {
    decision: "execute",
    reason: reasons.join(",") || "missing-evidence",
  };
}

export async function planVersionProjection({
  baseSha,
  headSha,
  discover,
  regenerate,
}) {
  const proof = await discover(baseSha);
  if (proof.decision !== "reuse")
    return { decision: "execute", reason: "base-full-proof-unavailable" };
  const projection = await regenerate(baseSha, headSha);
  return {
    ...proof,
    decision: "projection",
    reason: "verified-base-and-exact-regenerated-version-delta",
    projection,
  };
}
