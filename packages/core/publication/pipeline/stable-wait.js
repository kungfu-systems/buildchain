import { recordDigest } from "../../release/discussion/envelope.js";
import { readBusinessAttempt } from "../../workflow/attempt/reader.js";
import { verifyRootedPublication } from "./documents.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import { assertPipelineStableQualification } from "./stable.js";

const TIMERS = new Set(["stable.minimum_interval", "stable.canary_soak"]);
const MAX_WAIT = 15 * 60 * 1000;

export function planPipelineStableWait(
  plan,
  eligibility,
  { attempt, generation, phase },
) {
  verifyPipelinePublicationPlan(plan);
  verifyRootedPublication(
    eligibility,
    "buildchain.pipeline-stable-eligibility/v1",
  );
  if (
    plan.channel !== "stable" ||
    !plan.stablePolicy ||
    eligibility.planRoot !== plan.root ||
    generation !== plan.generation ||
    !/^attempt-[0-9a-f]{64}$/u.test(attempt || "") ||
    !["publish", "distribution", "next-development"].includes(phase)
  )
    throw new Error("Stable wait changed its admitted publication coordinates");
  const failed = eligibility.report.checks.filter(
    (check) => check.status !== "pass",
  );
  if (
    eligibility.report.ok ||
    !failed.length ||
    failed.some((check) => !TIMERS.has(check.id))
  )
    return null;
  const times = failed.map((check) => {
    const interval = check.id === "stable.minimum_interval";
    const expected = interval
      ? plan.stablePolicy.minimum_interval_seconds
      : plan.stablePolicy.minimum_soak_seconds;
    const start = Date.parse(
      interval
        ? check.details.previousPublishedAt
        : check.details.soakStartedAt,
    );
    if (
      check.details.requiredSeconds !== expected ||
      !Number.isSafeInteger(expected) ||
      expected < 0
    )
      throw new Error("Stable wait timer differs from the source-bound policy");
    return start + expected * 1000;
  });
  const ready = Math.max(...times);
  const evaluatedAt = Date.parse(eligibility.evaluatedAt);
  if (
    !Number.isFinite(evaluatedAt) ||
    !Number.isFinite(ready) ||
    ready <= evaluatedAt ||
    ready > 8640000000000000
  )
    throw new Error("Stable wait has no bounded future recheck timestamp");
  const body = {
    schema: "buildchain.pipeline-stable-wait/v1",
    attempt,
    generation,
    phase,
    sourceRoot: recordDigest(plan.intentSource),
    planRoot: plan.root,
    eligibilityRoot: eligibility.root,
    notBefore: new Date(ready).toISOString(),
  };
  return { ...body, root: recordDigest(body) };
}

export async function preparePipelineStableQualification(
  plan,
  host,
  journal,
  coordinates,
) {
  try {
    const eligibility = await assertPipelineStableQualification(plan, host);
    if (eligibility) {
      await journal.fence();
      await journal.record("publication/stable-eligibility", eligibility, {
        phase: coordinates.phase,
      });
    }
    return null;
  } catch (error) {
    if (!error.eligibility) throw error;
    const wait = planPipelineStableWait(plan, error.eligibility, coordinates);
    if (!wait) throw error;
    await journal.fence();
    const options = { phase: coordinates.phase, state: "waiting" };
    await journal.record(
      "publication/stable-eligibility",
      error.eligibility,
      options,
    );
    await journal.record("publication/stable-wait", wait, options);
    return wait;
  }
}

export async function retainedPipelineStableWait(observed, host) {
  const current = observed.history.at(-1);
  if (observed.intent.repository !== host.repository)
    throw new Error("Stable wait crossed the native repository boundary");
  const phase = observed.missing[0];
  if (
    !["publish", "distribution", "next-development"].includes(phase) ||
    current.phases[phase]?.payload.state !== "waiting"
  )
    return null;
  const references = current.phases[phase].payload.materials.filter((item) =>
    item.id.startsWith("publication/stable-wait/"),
  );
  if (references.length !== 1) return null;
  const session = { intent: observed.intent, observed };
  const retained = await host.materialStore(session).read(references[0]);
  verifyRootedPublication(retained, "buildchain.pipeline-stable-wait/v1");
  if (
    observed.attempt !== retained.attempt ||
    observed.generation !== retained.generation ||
    recordDigest(current.generation.source) !== retained.sourceRoot ||
    phase !== retained.phase ||
    !Number.isFinite(Date.parse(retained.notBefore))
  )
    throw new Error(
      "Retained stable wait changed its native publication coordinates",
    );
  return retained;
}

async function activeWait(wait, host) {
  const loaded = await host.index.resolve(wait.attempt);
  const observed = readBusinessAttempt(loaded.snapshot);
  const retained = await retainedPipelineStableWait(observed, host);
  if (!retained) return false;
  return recordDigest(retained) === recordDigest(wait);
}

// This node runs outside the publication concurrency group. It only waits and
// wakes the normal entry; every subsequent publication re-collects qualification.
export async function wakePipelineStableWait(
  wait,
  host,
  {
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  verifyRootedPublication(wait, "buildchain.pipeline-stable-wait/v1");
  const target = Date.parse(wait.notBefore),
    started = now();
  if (!Number.isFinite(target) || !Number.isFinite(started))
    throw new Error("Stable wake requires a finite retained timer");
  const deadline = Math.min(target, started + MAX_WAIT);
  while (now() < deadline) {
    if (!(await activeWait(wait, host))) return { status: "obsolete" };
    await sleep(Math.min(30000, deadline - now()));
  }
  if (!(await activeWait(wait, host))) return { status: "obsolete" };
  await host.wake(wait.attempt);
  return { status: "woken", attempt: wait.attempt, notBefore: wait.notBefore };
}
