import { wakePipelineCandidate } from "./wake.js";
import { pipelineCandidate } from "./reconcile.js";

export async function resumePipelineNotifications(session, host) {
  const observed = await session.journal.read();
  const current = { ...observed.history.at(-1), intent: session.intent };
  const terminal = Object.values(current.phases).filter((phase) =>
    ["success", "cancelled", "failure"].includes(phase.payload.state),
  );
  for (const phase of terminal) {
    for (const reference of phase.payload.materials.filter((material) =>
      /^(?:merge\/settlement-|cancellation\/receipt-|failure\/)/u.test(
        material.id,
      ),
    )) {
      const receipt = await host.materialStore(session).read(reference);
      const successor =
        receipt.receipt?.successorWake ||
        (Array.isArray(receipt.candidates)
          ? pipelineCandidate(receipt, current)?.terminal?.successorWake
          : null);
      if (successor)
        await wakePipelineCandidate(
          successor,
          {
            repository: host.repository,
            token: host.token,
            branch: session.intent.source.targetBranch,
          },
          host,
        );
    }
  }
}
