import path from "node:path";
import { compareSemver } from "../../publication/candidate/registry-hydration.js";
import { githubJson } from "./../candidate/transport.js";
import { runtimeResumeDocumentRoot } from "./lineage.js";
export function validateRuntimeResumePublicReadback({
  targetRef,
  targetSha,
  targetVersion,
  floatingSha,
  exactTagSha,
  tagLineage,
  floatingTargetLineage,
  version,
  transaction,
  main,
  npm,
}) {
  const distTag = version.includes("-") ? "alpha" : "latest";
  const channelVersion = npm["dist-tags"]?.[distTag];
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
    !["ahead", "identical"].includes(floatingTargetLineage?.status) ||
    !floatingSha ||
    !targetSha ||
    channelVersion !== targetVersion ||
    !channelDidNotRegress ||
    !npm.versions?.[channelVersion]?.dist?.integrity ||
    npm.versions?.[version]?.dist?.integrity !== main.digest
  ) {
    throw new Error(
      "cross-runtime final public readback does not match durable publication bytes",
    );
  }
}

export async function readPublicResumeState({
  repoInfo,
  targetRef,
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
  const floatingRef = `v${version.split(".")[0]}${version.includes("-") ? "-alpha" : ""}`;
  const distTag = version.includes("-") ? "alpha" : "latest";
  const [targetSha, floatingSha, exactTagSha, npmResponse] = await Promise.all([
    readRef(`heads/${targetRef}`),
    readRef(`tags/${floatingRef}`),
    readRef(`tags/${exactTag}`),
    fetchImpl(packageUrl),
  ]);
  if (!npmResponse.ok) {
    throw new Error(
      `npm public readback failed with HTTP ${npmResponse.status}`,
    );
  }
  const npm = await npmResponse.json();
  const [tagLineage, floatingTargetLineage, targetPackageFile] =
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
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/compare/${floatingSha}...${targetSha}`,
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
    floatingSha,
    exactTagSha,
    tagLineage,
      floatingTargetLineage,
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
      floating: { ref: floatingRef, sha: floatingSha },
      exactTag: { ref: exactTag, sha: exactTagSha },
    },
    npm: {
      package: main.name,
      version,
      distTag,
      integrity: npm.versions[version].dist.integrity,
      targetVersion,
      distTagVersion: npm["dist-tags"][distTag],
      distTagIntegrity: npm.versions[npm["dist-tags"][distTag]].dist.integrity,
    },
  };
  return { ...body, root: runtimeResumeDocumentRoot(body) };
}
