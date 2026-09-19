import { recordDigest } from "../../release/discussion/envelope.js";
import { retainedRecoveryEvidence } from "./recovery-session.js";
import { buildReadbackPlatforms } from "./build-qualification.js";

// Cancellation can prevent the recorder from running after product jobs finish.
// Recover those exact provider jobs, plus previously admitted segments, without
// claiming that an unstarted or failed platform succeeded.
export async function unrecordedRecoveryBuild(
  session,
  source,
  platforms,
  host,
) {
  const current = session.observed.history.at(-1);
  const phase = current.phases.build;
  if (!phase) return [];
  const segments = [];
  if (current.identity.requestKey.startsWith("recover:")) {
    const { evidence } = await retainedRecoveryEvidence(session, host);
    for (const segment of evidence.build.segments) {
      const old = segment.readback;
      const fresh = await host.runs.build(
        old.runId,
        old.runAttempt,
        source,
        buildReadbackPlatforms(old),
      );
      if (
        recordDigest(old.source) !== recordDigest(source) ||
        recordDigest(old) !== recordDigest(fresh)
      )
        throw new Error(
          "Interrupted recovery lost its previously qualified build segment",
        );
      segments.push(segment);
    }
  }
  const writer = phase.payload.writer;
  const { run, jobs } = await host.runs.read(
    Number(writer.runId),
    Number(writer.runAttempt),
  );
  if (
    run.status !== "completed" ||
    run.repository?.full_name !== host.repository ||
    run.head_repository?.full_name !== host.repository
  )
    throw new Error(
      "Unrecorded build requires terminal same-repository provider execution",
    );
  const completed = platforms.filter((platform) => {
    const name = `Build product (${platform})`;
    const matches = jobs.filter(
      (job) => job.name === name || job.name.endsWith(` / ${name}`),
    );
    if (matches.length > 1)
      throw new Error("Interrupted build platform identity is ambiguous");
    return (
      matches[0]?.status === "completed" && matches[0].conclusion === "success"
    );
  });
  if (completed.length)
    segments.push({
      readback: await host.runs.build(
        Number(writer.runId),
        Number(writer.runAttempt),
        source,
        completed,
      ),
      platforms: completed,
      runtime: phase.runtime,
    });
  return segments;
}
