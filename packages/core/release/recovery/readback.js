import path from "node:path";
import { compareSemver } from "../../publication/candidate/registry-hydration.js";
import { githubJson } from "./../candidate/transport.js";
import { runtimeResumeDocumentRoot } from "../../consumer/runtime-ref-resume-authority.js";
export function validateRuntimeResumePublicReadback({
  targetRef,
  targetSha,
  targetVersion,
  alphaSha,
  exactTagSha,
  tagLineage,
  runtimeLineage,
  floatingTargetLineage,
  runtimeSha,
  version,
  transaction,
  main,
  npm,
}) {
  const channelVersion = npm["dist-tags"]?.alpha;
  let channelDidNotRegress = false;
  try {
    channelDidNotRegress = compareSemver(channelVersion, version) >= 0;
  } catch {
    channelDidNotRegress = false;
  }
  if (
    transaction?.target_ref !== targetRef ||
    transaction?.version !== version ||
    exactTagSha !== transaction?.source_sha ||
    !["ahead", "identical"].includes(tagLineage?.status) ||
    !["ahead", "identical"].includes(runtimeLineage?.status) ||
    !["ahead", "identical"].includes(floatingTargetLineage?.status) ||
    !alphaSha ||
    !targetSha ||
    !runtimeSha ||
    channelVersion !== targetVersion ||
    !channelDidNotRegress ||
    !npm.versions?.[channelVersion]?.dist?.integrity ||
    npm.versions?.[version]?.dist?.integrity !== main.digest
  ) {
    throw new Error(
      "cross-runtime final public readback does not match durable publication bytes and runtime",
    );
  }
}

export async function readPublicResumeState({
  repoInfo,
  targetRef,
  runtimeSha,
  version,
  transaction,
  token,
  apiUrl,
  fetchImpl,
}) {
  const readRef = async (ref) =>
    (
      await githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/git/ref/${ref}`,
      })
    ).object?.sha || "";
  const main = transaction?.artifacts?.find(
    (entry) => entry.kind === "npm" && entry.required !== false,
  );
  if (!main || main.ref !== version || !main.digest)
    throw new Error(
      "cross-runtime recovery requires exact durable npm publication evidence",
    );
  const packageUrl = `https://registry.npmjs.org/${encodeURIComponent(main.name)}`;
  const exactTag = transaction.exact_tag || `v${version}`;
  const [targetSha, alphaSha, exactTagSha, npmResponse] = await Promise.all([
    readRef(`heads/${targetRef}`),
    readRef("tags/v4-alpha"),
    readRef(`tags/${exactTag}`),
    fetchImpl(packageUrl),
  ]);
  if (!npmResponse.ok) {
    throw new Error(
      `npm public readback failed with HTTP ${npmResponse.status}`,
    );
  }
  const npm = await npmResponse.json();
  const [tagLineage, runtimeLineage, floatingTargetLineage, targetPackageFile] =
    await Promise.all([
      githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${exactTagSha}...${targetSha}`,
      }),
      githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${runtimeSha}...${alphaSha}`,
      }),
      githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${alphaSha}...${targetSha}`,
      }),
      githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/contents/package.json?ref=${encodeURIComponent(targetSha)}`,
      }),
    ]);
  if (
    targetPackageFile?.type !== "file" ||
    targetPackageFile.encoding !== "base64" ||
    !targetPackageFile.content
  )
    throw new Error(
      "cross-runtime recovery requires protected target version state",
    );
  const targetVersion = JSON.parse(
    Buffer.from(
      String(targetPackageFile.content).replace(/\s/g, ""),
      "base64",
    ).toString("utf8"),
  ).version;
  validateRuntimeResumePublicReadback({
    targetRef,
    targetSha,
    targetVersion,
    alphaSha,
    exactTagSha,
    tagLineage,
    runtimeLineage,
    floatingTargetLineage,
    runtimeSha,
    version,
    transaction,
    main,
    npm,
  });
  const body = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-runtime-resume-public-readback/v1",
    observedAt: new Date().toISOString(),
    repository: repoInfo.fullName,
    version,
    refs: {
      target: { ref: targetRef, sha: targetSha },
      floating: { ref: "v4-alpha", sha: alphaSha },
      exactTag: { ref: exactTag, sha: exactTagSha },
    },
    npm: {
      package: main.name,
      version,
      distTag: "alpha",
      integrity: npm.versions[version].dist.integrity,
      targetVersion,
      distTagVersion: npm["dist-tags"].alpha,
      distTagIntegrity: npm.versions[npm["dist-tags"].alpha].dist.integrity,
    },
  };
  return { ...body, root: runtimeResumeDocumentRoot(body) };
}

export const resolveRuntimeResumePublicRuntimeSha = (material) =>
  material?.buildAttempt?.runtimeSha || "";
