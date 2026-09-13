import { readBusinessAttempt } from "../attempt/reader.js";

export async function notifyPipelineParent(session, host) {
  const pr = await host.request(
    `/repos/${host.repository}/pulls/${session.intent.source.pullRequest}`,
  );
  if (!/^feature\/buildchain-next\/[0-9a-f]{64}$/u.test(pr.head?.ref || ""))
    return;
  const matches = [
    ...String(pr.body || "").matchAll(
      /^Buildchain-Parent-Attempt: (attempt-[0-9a-f]{64})$/gmu,
    ),
  ];
  if (matches.length !== 1) return;
  const attempt = matches[0][1];
  const parent = await host.index.resolve(attempt);
  const state = readBusinessAttempt(parent.snapshot);
  if (
    state.attempt !== attempt ||
    state.status === "complete" ||
    !state.intent.expectedNodes.includes("next-development")
  )
    return;
  // The body is only a bounded wake selector. Current journal source and exact
  // generated PR readback are re-admitted before any parent mutation.
  await host.wake(attempt);
}
