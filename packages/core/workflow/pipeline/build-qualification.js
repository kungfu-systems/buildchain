import {
  recordDigest,
  validateRuntime,
} from "../../release/discussion/envelope.js";
import { object } from "../../consumer/contract/shape.js";

export const PIPELINE_BUILD_QUALIFICATION =
  "buildchain.pipeline-build-qualification/v1";

export function buildReadbackPlatforms(readback) {
  const { root, ...body } = readback;
  if (
    body.schema !== "buildchain.pipeline-build-readback/v1" ||
    root !== recordDigest(body) ||
    !Array.isArray(body.jobs) ||
    !body.jobs.length
  )
    throw new Error(
      "Build qualification requires immutable provider job readback",
    );
  const platforms = body.jobs.map(
    (job) => job.name?.match(/Build product \(([^)]+)\)$/u)?.[1],
  );
  if (
    platforms.some((platform) => !platform) ||
    new Set(platforms).size !== platforms.length
  )
    throw new Error(
      "Provider build has ambiguous or unsupported platform jobs",
    );
  return platforms;
}

function validateBuildInventory(platforms, segments, runId, runAttempt) {
  if (
    !Array.isArray(platforms) ||
    !platforms.length ||
    platforms.length > 5 ||
    new Set(platforms).size !== platforms.length ||
    !Array.isArray(segments) ||
    !segments.length ||
    segments.length > 5 ||
    ![runId, runAttempt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error(
      "Build qualification requires bounded exact platform and execution coordinates",
    );
}

export function qualifyPipelineBuild({
  source,
  platforms,
  segments,
  runId,
  runAttempt,
}) {
  validateBuildInventory(platforms, segments, runId, runAttempt);
  const selected = [];
  let successful = true;
  for (const segment of segments) {
    object(segment, ["readback", "platforms", "runtime"]);
    validateRuntime(segment.runtime);
    if (
      segment.runtime.repository !== "kungfu-systems/buildchain" ||
      !Array.isArray(segment.platforms) ||
      !segment.platforms.length ||
      recordDigest(segment.readback.source) !== recordDigest(source)
    )
      throw new Error(
        "Build segment changed its exact source or runtime repository",
      );
    const available = buildReadbackPlatforms(segment.readback);
    for (const platform of segment.platforms) {
      const index = available.indexOf(platform),
        job = segment.readback.jobs[index];
      if (
        index < 0 ||
        !platforms.includes(platform) ||
        selected.includes(platform) ||
        job.status !== "completed" ||
        !job.conclusion ||
        job.run_id !== segment.readback.runId ||
        job.run_attempt !== segment.readback.runAttempt ||
        !Number.isSafeInteger(job.id) ||
        job.id < 1
      )
        throw new Error(
          "Build segments omitted, duplicated or changed a real platform execution",
        );
      selected.push(platform);
      successful &&= job.conclusion === "success";
    }
  }
  if (selected.length !== platforms.length)
    throw new Error("Build qualification is missing declared platforms");
  const body = {
    schema: PIPELINE_BUILD_QUALIFICATION,
    source,
    platforms: [...platforms].sort(),
    runId,
    runAttempt,
    segments: structuredClone(segments),
    outcome: successful ? "success" : "failure",
  };
  return { ...body, root: recordDigest(body) };
}

export async function verifyPipelineBuildQualification(
  value,
  source,
  platforms,
  runs,
) {
  object(value, [
    "schema",
    "source",
    "platforms",
    "runId",
    "runAttempt",
    "segments",
    "outcome",
    "root",
  ]);
  const expected = qualifyPipelineBuild({ ...value, source, platforms });
  if (recordDigest(value) !== recordDigest(expected))
    throw new Error(
      "Retained build qualification changed its source or exact platform inventory",
    );
  for (const segment of value.segments) {
    const old = segment.readback;
    const fresh = await runs.build(
      old.runId,
      old.runAttempt,
      source,
      buildReadbackPlatforms(old),
    );
    if (recordDigest(fresh) !== recordDigest(old))
      throw new Error(
        "A recovered platform result changed during provider requalification",
      );
  }
  return value;
}
