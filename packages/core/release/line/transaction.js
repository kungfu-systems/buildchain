import { planLine } from "./plan.js";
import { applyLineSource } from "./source.js";
import { configureLineGovernance } from "./governance.js";
export async function bootstrapReleaseLine(
  request,
  {
    plan = planLine,
    source = applyLineSource,
    governance = configureLineGovernance,
    providers,
  } = {},
) {
  const planned = await plan(request);
  if (request.apply !== true) return { plan: planned, applied: false };
  if (!providers || !/^[^/\s]+\/[^/\s]+$/u.test(request.repository || ""))
    throw new Error("Release line apply requires scoped repository providers");
  const written = await source({ plan: planned, apply: true });
  const governed = await governance(
    {
      plan: planned,
      repository: request.repository,
      apply: true,
      devSha: written.devSha,
    },
    providers,
  );
  return {
    plan: planned,
    applied: true,
    source: written,
    governance: governed,
  };
}
