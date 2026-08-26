import fs from "node:fs";
import path from "node:path";

import {
  createActivationReceiptProjectorAdapter,
  createSignedStaticChannelAdapter,
  createSiteReleaseActivationAdapter,
} from "../../packages/core/release-tail-provider-adapters.js";
import { releaseTailRoot } from "../../packages/core/release-tail-provider-plane.js";

function capability({
  id,
  adapter,
  executor = "provider-adapter",
  artifactRoles,
  destination,
  channel,
  tagPattern,
  authorityMove,
  activationPolicy,
  readback,
  effectKind,
  observationKind,
  receiptKind,
  transactionRoot,
  subjectRoot,
  targetRoot,
  retry,
  evidenceRequirements,
}) {
  return {
    id,
    executor,
    adapter,
    artifactRoles,
    destination,
    channelPolicy: { channel, tagPattern, authorityMove },
    activationPolicy,
    readbackPredicates: [readback],
    effect: {
      kind: effectKind,
      schema: "kungfu.buildchain.release-tail.effect/v1",
    },
    observation: {
      kind: observationKind,
      schema: "kungfu.buildchain.release-tail.observation/v1",
    },
    receipt: {
      kind: receiptKind,
      schema: "kungfu.buildchain.release-tail.receipt/v1",
    },
    operationIdentity: {
      transactionRoot,
      capabilityId: id,
      subjectRoot,
      targetRoot,
      attemptKey: `${id}/1`,
    },
    idempotency: {
      scope: "subject-target",
      duplicate: "readback-before-retry",
    },
    retry,
    evidenceRequirements,
  };
}

export function extendV4GitHubReleaseDeclaration({
  declaration,
  transactionRoot,
  targetRoot,
  qualificationRoot,
}) {
  if (!qualificationRoot) return { declaration, documents: null };
  const { repository, tag, channel } = declaration.subject;
  const tagPattern = declaration.capabilities[0].channelPolicy.tagPattern;
  const subjectRoot = releaseTailRoot(declaration.subject);
  const releaseAssetsRoot = targetRoot;
  const signedChannel = {
    schema: "kungfu.buildchain.signed-channel/v1",
    subject: declaration.subject,
    qualificationRoot,
    releaseAssetsRoot,
  };
  const signedChannelRoot = releaseTailRoot(signedChannel);
  const activation = {
    schema: "kungfu.buildchain.release-activation/v1",
    subject: declaration.subject,
    qualificationRoot,
    signedChannelRoot,
  };
  const activationRoot = releaseTailRoot(activation);
  const releasedEvidence = {
    schema: "kungfu.buildchain.released-evidence/v1",
    subject: declaration.subject,
    qualificationRoot,
    evidenceRoots: [releaseAssetsRoot, signedChannelRoot, activationRoot],
  };
  const releasedEvidenceRoot = releaseTailRoot(releasedEvidence);
  const shared = { channel, tagPattern, transactionRoot, subjectRoot };
  declaration.capabilities.push(
    capability({
      ...shared,
      id: "signed-channel.commit",
      adapter: "signed-static-channel",
      artifactRoles: [
        { role: "signed-channel-index", root: signedChannelRoot },
      ],
      destination: {
        kind: "well-known-signed-channel",
        locator: `github-document:${repository}@buildchain/signed-channel/${tag}:.buildchain/channels/${channel}.json`,
      },
      authorityMove: "signed-cas",
      activationPolicy: { mode: "none", environment: "none" },
      readback: {
        id: "signed-channel-root",
        kind: "provider-document",
        expected: "the signed channel document matches its sealed root",
      },
      effectKind: "signed-channel-commit",
      observationKind: "signed-channel-readback",
      receiptKind: "publication-commit",
      targetRoot: signedChannelRoot,
      retry: {
        class: "readback",
        localAttempts: 2,
        exhausted: "repair-required",
      },
      evidenceRequirements: ["kungfu-buildchain-publication-qualification/v1"],
    }),
    capability({
      ...shared,
      id: "release.activate",
      adapter: "site-release-activation",
      artifactRoles: [{ role: "activation-receipt-set", root: activationRoot }],
      destination: {
        kind: "production-site",
        locator: `github-document:${repository}@buildchain/release-activation/${tag}:.buildchain/activation/${channel}.json`,
      },
      authorityMove: "verified-ref",
      activationPolicy: { mode: "receipt-set", environment: "production" },
      readback: {
        id: "release-activation-root",
        kind: "provider-document",
        expected: "the activation document matches its sealed root",
      },
      effectKind: "release-activation",
      observationKind: "production-readback",
      receiptKind: "activation-receipt-set",
      targetRoot: activationRoot,
      retry: {
        class: "provider-transient",
        localAttempts: 2,
        exhausted: "blocked",
      },
      evidenceRequirements: [
        "kungfu-buildchain-publication-commit-evidence/v1",
      ],
    }),
    capability({
      ...shared,
      id: "released-evidence.synthesize",
      adapter: "activation-receipt-projector",
      executor: "buildchain-core",
      artifactRoles: [{ role: "activation-receipt-set", root: activationRoot }],
      destination: {
        kind: "release-passport-attachment",
        locator: ".buildchain/release-evidence/released-evidence.json",
      },
      authorityMove: "none",
      activationPolicy: { mode: "receipt-only", environment: "production" },
      readback: {
        id: "released-evidence-root",
        kind: "rooted-receipt-set",
        expected: "released evidence matches the sealed synthesis root",
      },
      effectKind: "released-evidence-projection",
      observationKind: "released-evidence-validation",
      receiptKind: "released-evidence",
      targetRoot: releasedEvidenceRoot,
      retry: {
        class: "never",
        localAttempts: 0,
        exhausted: "terminal-failure",
      },
      evidenceRequirements: [
        "kungfu-buildchain-release-activation-receipt-set/v1",
      ],
    }),
  );
  return {
    declaration,
    documents: { signedChannel, activation, releasedEvidence },
  };
}

function parseLocator(locator) {
  const match = String(locator || "").match(
    /^github-document:([^/\s]+)\/([^@\s]+)@([^:\s]+):(.+)$/u,
  );
  if (!match) throw new Error("invalid built-in GitHub document locator");
  return { owner: match[1], repo: match[2], ref: match[3], path: match[4] };
}

function githubDocumentProvider(octokit, document) {
  return {
    async readDocument(locator) {
      const coordinate = parseLocator(locator);
      try {
        const response = await octokit.rest.repos.getContent(coordinate);
        if (Array.isArray(response.data) || response.data.type !== "file")
          return null;
        return JSON.parse(
          Buffer.from(response.data.content, "base64").toString("utf8"),
        );
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },
    resolveDocument() {
      return document;
    },
    async commitDocument({ locator, document: value, operationId }) {
      const coordinate = parseLocator(locator);
      const repository = { owner: coordinate.owner, repo: coordinate.repo };
      let parent = "";
      let baseTree = "";
      try {
        parent = (
          await octokit.rest.git.getRef({
            ...repository,
            ref: `heads/${coordinate.ref}`,
          })
        ).data.object.sha;
        baseTree = (
          await octokit.rest.git.getCommit({
            ...repository,
            commit_sha: parent,
          })
        ).data.tree.sha;
      } catch (error) {
        if (Number(error?.status) !== 404) throw error;
      }
      const blob = await octokit.rest.git.createBlob({
        ...repository,
        content: `${JSON.stringify(value, null, 2)}\n`,
        encoding: "utf-8",
      });
      const tree = await octokit.rest.git.createTree({
        ...repository,
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: [
          {
            path: coordinate.path,
            mode: "100644",
            type: "blob",
            sha: blob.data.sha,
          },
        ],
      });
      const commit = await octokit.rest.git.createCommit({
        ...repository,
        message: `chore(release): commit provider document ${operationId}`,
        tree: tree.data.sha,
        parents: parent ? [parent] : [],
      });
      if (parent) {
        await octokit.rest.git.updateRef({
          ...repository,
          ref: `heads/${coordinate.ref}`,
          sha: commit.data.sha,
          force: false,
        });
      } else {
        await octokit.rest.git.createRef({
          ...repository,
          ref: `refs/heads/${coordinate.ref}`,
          sha: commit.data.sha,
        });
      }
    },
  };
}

function localEvidenceProvider(document) {
  return {
    readEvidence(locator) {
      const resolved = path.resolve(locator);
      return fs.existsSync(resolved)
        ? JSON.parse(fs.readFileSync(resolved, "utf8"))
        : null;
    },
    synthesizeEvidence() {
      return document;
    },
    writeEvidence({ locator, document: value }) {
      const resolved = path.resolve(locator);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

export function createV4GitHubProviderAdapters(octokit, documents) {
  if (!documents) return {};
  const signed = githubDocumentProvider(octokit, documents.signedChannel);
  const activation = githubDocumentProvider(octokit, documents.activation);
  return {
    "signed-static-channel": createSignedStaticChannelAdapter(signed),
    "site-release-activation": createSiteReleaseActivationAdapter({
      ...activation,
      activate: activation.commitDocument,
    }),
    "activation-receipt-projector": createActivationReceiptProjectorAdapter(
      localEvidenceProvider(documents.releasedEvidence),
    ),
  };
}
