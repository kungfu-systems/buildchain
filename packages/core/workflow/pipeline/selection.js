import { readBusinessAttempt } from "../attempt/reader.js";
import { openPipelineSession, resumePipelineSession } from "./session.js";
import { sourceGeneration } from "../attempt/identity.js";

async function successorSelection(
  session,
  admission,
  event,
  payload,
  inputs,
  host,
) {
  if (
    !["superseded", "cancelled"].includes(session.observed.status) ||
    event.terminalOnly ||
    admission.live.state !== "open" ||
    admission.live.targetBranch !== session.intent.source.targetBranch
  )
    return { session, admission };
  const next = await host.source.observe(
    session.intent.source.pullRequest,
    inputs,
  );
  if (!next.eligible) return { session, admission };
  const changed =
    sourceGeneration(session.intent, next.live.source, next.live.baseCommit)
      .id !== session.observed.generation;
  if (
    !changed &&
    !["reopened", "enqueued", "ready_for_review", "labeled"].includes(
      payload.action,
    )
  )
    return { session, admission };
  await host.notifyTerminal?.(session);
  return {
    session: await openPipelineSession(
      { admission: next, ...host, successor: true },
      host,
    ),
    admission: next,
  };
}

// Event branch names are lookup hints only. The immutable intent and live PR
// readback decide whether an old route still needs cleanup before a new route.
export async function selectPipelineSession(event, payload, inputs, host) {
  if (event.kind === "attempt") {
    const session = await resumePipelineSession(
      { ...host, attempt: event.attempt },
      host,
    );
    const admission = await host.source.observeIntent(
      session.intent,
      session.observed.history.at(-1).generation,
      inputs,
    );
    return successorSelection(session, admission, event, payload, inputs, host);
  }
  if (event.kind !== "pull-request")
    throw new Error("Not a PR pipeline selection");
  const pr = await host.request(
    `/repos/${host.repository}/pulls/${event.pullRequest}`,
  );
  const branches = [
    ...new Set(
      [payload.changes?.base?.ref?.from, pr.base?.ref].filter(Boolean),
    ),
  ];
  for (const branch of branches) {
    if (!/^(?:dev|alpha|release|publish-gate)\/[A-Za-z0-9/._-]+$/u.test(branch))
      continue;
    const retained = await host.provider.lookup(
      host.repository,
      event.pullRequest,
      branch,
    );
    if (!retained) continue;
    const observed = readBusinessAttempt(retained.snapshot);
    if (!observed.attempt) continue;
    if (
      branch !== pr.base.ref &&
      ["cancelled", "failure", "superseded", "complete"].includes(
        observed.status,
      )
    )
      continue;
    const session = await resumePipelineSession(
      { ...host, attempt: observed.attempt },
      host,
    );
    const admission = await host.source.observeIntent(
      session.intent,
      observed.history.at(-1).generation,
      inputs,
    );
    return successorSelection(session, admission, event, payload, inputs, host);
  }
  if (event.terminalOnly || pr.state !== "open") return null;
  const admission = await host.source.observe(event.pullRequest, inputs);
  if (!admission.eligible) return null;
  return {
    session: await openPipelineSession({ admission, ...host }, host),
    admission,
  };
}
