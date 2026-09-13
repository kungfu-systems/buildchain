import { recordDigest } from "../../release/discussion/envelope.js";
import { evaluateStableReleaseGate } from "../../release/stable-release-gate.js";
import { readPipelineStableSource } from "../../providers/github/pipeline-stable-source.js";
import { verifyPipelinePublicationPlan } from "./plan.js";
import { readPipelineStableProducts } from "./stable-products.js";

function stablePolicy(plan) {
  const value = plan.stablePolicy;
  const requiredCanaries = [
    {
      id: "product-build",
      source: "release-candidate",
      context: "",
      allowedAttestors: [],
    },
  ];
  if (value.require_published_entry)
    requiredCanaries.push({
      id: "published-entry",
      source: "public-build",
      context: "",
      allowedAttestors: ["github-actions[bot]"],
    });
  return {
    enabled: true,
    minimumStableIntervalSeconds: value.minimum_interval_seconds,
    minimumCanarySoakSeconds: value.minimum_soak_seconds,
    productPathPrefixes: value.product_paths,
    requiredCanaries,
  };
}

export async function assertPipelineStableQualification(
  plan,
  host,
  { now = new Date().toISOString() } = {},
) {
  verifyPipelinePublicationPlan(plan);
  if (plan.channel !== "stable" || !plan.stablePolicy) return null;
  const source = await readPipelineStableSource(plan, host);
  const products = await readPipelineStableProducts(plan, source, host);
  if (
    products.canary &&
    recordDigest(await readPipelineStableSource(plan, host)) !==
      recordDigest(source)
  )
    throw new Error("Stable source facts changed during product qualification");
  // Post-publication entry qualification still needs its independent collector.
  const report = evaluateStableReleaseGate({
    policy: stablePolicy(plan),
    channel: "release",
    now,
    candidate: source.candidate,
    previousStable: source.previousStable || undefined,
    impact: source.impact.value,
    changedPaths: source.changedPaths,
    canaries: products.canary ? [products.canary] : [],
  });
  report.previousStable ??= null;
  const body = {
    schema: "buildchain.pipeline-stable-eligibility/v1",
    planRoot: plan.root,
    source,
    products,
    evaluatedAt: now,
    report,
  };
  const eligibility = { ...body, root: recordDigest(body) };
  if (!report.ok)
    throw Object.assign(
      new Error(
        `Stable pipeline qualification blocked: ${report.summary.failedChecks.join(", ")}`,
      ),
      { eligibility },
    );
  return eligibility;
}
