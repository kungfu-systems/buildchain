import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelineNpmChannel } from "../npm/pipeline-channel.js";
import { applyPipelineEffects } from "./effects.js";
import { compareDevelopmentVersions } from "../publication-development.js";

export async function distributePipelineProducts(
  context,
  host,
  journal,
  retained,
  environment,
  directory,
) {
  const { plan, materialization } = context;
  const channel = `v${plan.version.split(".")[0]}${plan.channel === "alpha" ? "-alpha" : ""}`;
  const refPath = `/repos/${host.repository}/git/ref/tags/${channel}`;
  const npmTag = plan.channel === "alpha" ? "alpha" : "latest";
  const npm = pipelineNpmChannel({ environment });
  async function observe(effect) {
    if (effect.kind === "git-channel") {
      const value = await host.request(refPath, { allow404: true });
      if (value && value.object?.type !== "commit")
        throw new Error("Floating channel requires a lightweight commit ref");
      return value
        ? { state: "present", commit: value.object.sha }
        : { state: "absent", commit: null };
    }
    return npm.observe(effect);
  }
  const plans = await journal.materials("publication/distribution-plan/");
  if (plans.length > 1)
    throw new Error("Distribution has conflicting retained plans");
  let effects = plans[0]?.effects;
  if (!effects) {
    const raw = [
      {
        id: "git-channel",
        kind: "git-channel",
        channel,
        commit: materialization.source.commit,
      },
    ];
    for (const artifact of retained.qualified.artifacts.filter((entry) =>
      entry.targets.some(({ provider }) => provider === "npm"),
    ))
      raw.push({
        id: `npm-channel:${artifact.id}`,
        kind: "npm-channel",
        name: artifact.package.name,
        access: artifact.targets.find(({ provider }) => provider === "npm")
          .access,
        tag: npmTag,
        version: plan.version,
      });
    effects = [];
    for (const effect of raw) {
      const before = await observe(effect);
      const body = { ...effect, expected: before };
      effects.push({ ...body, root: recordDigest(body) });
    }
    await journal.record(
      "publication/distribution-plan",
      { planRoot: plan.root, effects },
      { phase: "distribution" },
    );
  }
  const matches = (effect, value) =>
    value.state === "present" &&
    (effect.kind === "git-channel"
      ? value.commit === effect.commit
      : value.version === effect.version);
  const provider = {
    observe,
    matches,
    canApply: (effect, value) =>
      recordDigest(value) === recordDigest(effect.expected),
    async apply(effect) {
      const current = await observe(effect);
      if (matches(effect, current)) return;
      if (recordDigest(current) !== recordDigest(effect.expected))
        throw new Error(
          "Floating channel changed since retained distribution admission",
        );
      if (
        effect.kind === "npm-channel" &&
        current.version &&
        compareDevelopmentVersions(current.version, effect.version) > 0
      )
        throw new Error("npm channel cannot regress a newer published version");
      await journal.fence();
      if (effect.kind === "git-channel") {
        if (current.state === "absent")
          return host.request(`/repos/${host.repository}/git/refs`, {
            method: "POST",
            body: { ref: `refs/tags/${channel}`, sha: effect.commit },
          });
        // Provider-enforced fast-forward preserves published history. A
        // divergent channel requires a separately proved source reconciliation.
        return host.request(
          `/repos/${host.repository}/git/refs/tags/${channel}`,
          { method: "PATCH", body: { sha: effect.commit, force: false } },
        );
      }
      await npm.apply(effect);
    },
  };
  const receipts = await applyPipelineEffects({
    effects,
    transactionRoot: retained.documents.transaction.transactionRoot,
    receipts: await journal.materials("publication/distribution-effect/"),
    provider,
    fence: journal.fence,
    retain: (receipt) =>
      journal.record("publication/distribution-effect", receipt, {
        phase: "distribution",
      }),
  });
  return {
    schema: "buildchain.pipeline-distribution-complete/v1",
    planRoot: plan.root,
    effects,
    receipts,
  };
}
