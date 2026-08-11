import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { releaseTailRoot } from "./release-tail-provider-plane.js";

const ROOT = /^sha256:[0-9a-f]{64}$/u;

export class ReleaseTailProviderError extends Error {
  constructor(
    message,
    { code = "provider-error", classification = "transient" } = {},
  ) {
    super(message);
    this.name = "ReleaseTailProviderError";
    this.releaseTailCode = code;
    this.releaseTailClass = classification;
  }
}

function providerError(message, options) {
  throw new ReleaseTailProviderError(message, options);
}

function assertEffect(effect, adapter, destinationKinds) {
  if (!effect || effect.adapter !== adapter) {
    providerError(`adapter ${adapter} received an incompatible effect`, {
      code: "adapter-effect-mismatch",
      classification: "conflict",
    });
  }
  if (!destinationKinds.includes(effect.destination?.kind)) {
    providerError(`adapter ${adapter} does not support destination kind`, {
      code: "adapter-destination-mismatch",
      classification: "conflict",
    });
  }
}

function exactRoot(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!ROOT.test(normalized)) {
    providerError(`${label} must be a sha256 content root`, {
      code: "provider-root-invalid",
      classification: "conflict",
    });
  }
  return normalized;
}

function fileRoot(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function safeProviderCode(value, fallback) {
  const normalized = String(value || fallback);
  return /^[a-z0-9][a-z0-9._-]{0,159}$/u.test(normalized)
    ? normalized
    : fallback;
}

function classifyProviderError(error, fallbackCode) {
  if (error instanceof ReleaseTailProviderError) throw error;
  const status = Number(error?.status || error?.response?.status || 0);
  if (status === 409 || status === 412 || status === 422) {
    return new ReleaseTailProviderError(
      "provider rejected an immutable or conditional mutation",
      {
        code: "provider-policy-conflict",
        classification: "conflict",
      },
    );
  }
  return new ReleaseTailProviderError("provider operation failed transiently", {
    code: safeProviderCode(error?.releaseTailCode, fallbackCode),
    classification: "transient",
  });
}

function rootedDocument(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return {
      value,
      root: `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`,
    };
  }
  return { value, root: releaseTailRoot(value) };
}

function createRootedDocumentAdapter({
  id,
  destinationKinds,
  readDocument,
  resolveDocument,
  commitDocument,
}) {
  if (
    typeof readDocument !== "function" ||
    typeof resolveDocument !== "function" ||
    typeof commitDocument !== "function"
  ) {
    throw new Error(
      `${id} requires readDocument, resolveDocument, and commitDocument`,
    );
  }
  return Object.freeze({
    id,
    async readback(effect) {
      assertEffect(effect, id, destinationKinds);
      let observed;
      try {
        observed = await readDocument(
          effect.destination.locator,
          structuredClone(effect),
        );
      } catch (error) {
        throw classifyProviderError(error, "provider-readback-transient");
      }
      if (observed === undefined || observed === null) {
        return { outcome: "absent", providerCode: "provider-object-absent" };
      }
      const document = rootedDocument(observed);
      return {
        outcome: "observed",
        subjectRoot: effect.subjectRoot,
        targetRoot: document.root,
        evidenceRoots: [document.root],
        providerCode: "provider-object-observed",
      };
    },
    async apply(effect) {
      assertEffect(effect, id, destinationKinds);
      const resolved = rootedDocument(
        await resolveDocument(structuredClone(effect)),
      );
      if (resolved.root !== effect.targetRoot) {
        providerError(
          "resolved provider document does not match the sealed target root",
          {
            code: "sealed-target-root-mismatch",
            classification: "conflict",
          },
        );
      }
      try {
        await commitDocument({
          locator: effect.destination.locator,
          document: resolved.value,
          operationId: effect.operationId,
          subjectRoot: effect.subjectRoot,
          targetRoot: effect.targetRoot,
          authorityMove: effect.channelPolicy.authorityMove,
        });
      } catch (error) {
        throw classifyProviderError(error, "provider-mutation-transient");
      }
    },
  });
}

export function createSignedStaticChannelAdapter(options = {}) {
  return createRootedDocumentAdapter({
    id: "signed-static-channel",
    destinationKinds: ["well-known-signed-channel"],
    readDocument: options.readDocument,
    resolveDocument: options.resolveDocument,
    commitDocument: options.commitDocument,
  });
}

export function createSiteReleaseActivationAdapter(options = {}) {
  return createRootedDocumentAdapter({
    id: "site-release-activation",
    destinationKinds: ["production-site", "http-json"],
    readDocument: options.readDocument,
    resolveDocument: options.resolveDocument,
    commitDocument: options.activate,
  });
}

export function createActivationReceiptProjectorAdapter(options = {}) {
  return createRootedDocumentAdapter({
    id: "activation-receipt-projector",
    destinationKinds: ["release-passport-attachment"],
    readDocument: options.readEvidence,
    resolveDocument: options.synthesizeEvidence,
    commitDocument: options.writeEvidence,
  });
}

export function createHttpJsonReadback({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function")
    throw new Error("HTTP JSON readback requires fetch");
  return async function readHttpJson(locator) {
    let response;
    try {
      response = await fetchImpl(locator, {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw classifyProviderError(error, "http-network-transient");
    }
    if (response.status === 404) return null;
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status >= 500
    ) {
      throw new ReleaseTailProviderError(
        "HTTP JSON readback is temporarily unavailable",
        {
          code:
            response.status === 401 || response.status === 403
              ? "http-credential-transient"
              : "http-provider-transient",
          classification: "transient",
        },
      );
    }
    if (!response.ok) {
      throw new ReleaseTailProviderError(
        "HTTP JSON readback returned a terminal policy response",
        {
          code: "http-policy-conflict",
          classification: "conflict",
        },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ReleaseTailProviderError(
        "HTTP JSON readback was not valid JSON",
        {
          code: "http-json-invalid",
          classification: "conflict",
        },
      );
    }
  };
}

function parseGitHubReleaseLocator(locator) {
  const match = String(locator || "").match(
    /^github-release:([^/\s]+)\/([^@\s]+)@([^\s]+)$/u,
  );
  if (!match) {
    providerError(
      "GitHub Release locator must be github-release:owner/repo@tag",
      {
        code: "github-release-locator-invalid",
        classification: "conflict",
      },
    );
  }
  return { owner: match[1], repo: match[2], tag: match[3] };
}

function normalizedArtifactBindings(effect, resolveArtifact) {
  return effect.artifactRoles
    .map((artifact) => {
      const resolved = resolveArtifact(artifact.role, structuredClone(effect));
      if (!resolved || typeof resolved !== "object") {
        providerError(`artifact role ${artifact.role} did not resolve`, {
          code: "artifact-binding-missing",
          classification: "conflict",
        });
      }
      const filePath = path.resolve(String(resolved.path || ""));
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        providerError(`artifact role ${artifact.role} is not a file`, {
          code: "artifact-file-missing",
          classification: "conflict",
        });
      }
      const root = fileRoot(filePath);
      if (
        root !== artifact.root ||
        (resolved.root && exactRoot(resolved.root, "artifact root") !== root)
      ) {
        providerError(`artifact role ${artifact.role} changed after sealing`, {
          code: "artifact-root-mismatch",
          classification: "conflict",
        });
      }
      return {
        role: artifact.role,
        root,
        name: String(resolved.name || path.basename(filePath)),
        path: filePath,
      };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
}

export function githubReleaseAssetsTargetRoot({ destination, artifacts }) {
  return releaseTailRoot({
    destination,
    artifacts: artifacts
      .map(({ role, root, name }) => ({
        role,
        root: exactRoot(root, "artifact root"),
        name,
      }))
      .sort((left, right) => left.role.localeCompare(right.role)),
  });
}

export function createGitHubReleaseAssetsAdapter({
  octokit,
  resolveArtifact,
} = {}) {
  if (!octokit?.rest?.repos || typeof resolveArtifact !== "function") {
    throw new Error(
      "github-release-assets requires octokit and resolveArtifact",
    );
  }
  async function releaseAndAssets(effect) {
    const coordinate = parseGitHubReleaseLocator(effect.destination.locator);
    let release;
    try {
      release = (
        await octokit.rest.repos.getReleaseByTag({
          owner: coordinate.owner,
          repo: coordinate.repo,
          tag: coordinate.tag,
        })
      ).data;
    } catch (error) {
      if (Number(error?.status || error?.response?.status) === 404) {
        return { coordinate, release: null, assets: [] };
      }
      throw classifyProviderError(error, "github-release-readback-transient");
    }
    let assets;
    try {
      assets =
        (
          await octokit.rest.repos.listReleaseAssets({
            owner: coordinate.owner,
            repo: coordinate.repo,
            release_id: release.id,
            per_page: 100,
          })
        ).data || [];
    } catch (error) {
      throw classifyProviderError(error, "github-assets-readback-transient");
    }
    return { coordinate, release, assets };
  }
  return Object.freeze({
    id: "github-release-assets",
    async readback(effect) {
      assertEffect(effect, "github-release-assets", ["github-release"]);
      const expected = normalizedArtifactBindings(effect, resolveArtifact);
      const observed = await releaseAndAssets(effect);
      if (!observed.release) {
        return { outcome: "absent", providerCode: "github-release-absent" };
      }
      const byName = new Map(
        observed.assets.map((asset) => [asset.name, asset]),
      );
      if (expected.some((artifact) => !byName.has(artifact.name))) {
        return {
          outcome: "absent",
          providerCode: "github-release-assets-incomplete",
        };
      }
      const artifacts = expected.map((artifact) => {
        const asset = byName.get(artifact.name);
        return {
          role: artifact.role,
          name: artifact.name,
          root: String(asset.digest || "").toLowerCase(),
        };
      });
      if (artifacts.some((artifact) => !ROOT.test(artifact.root))) {
        return {
          outcome: "transient",
          providerCode: "github-asset-digest-unavailable",
        };
      }
      return {
        outcome: "observed",
        subjectRoot: effect.subjectRoot,
        targetRoot: githubReleaseAssetsTargetRoot({
          destination: effect.destination,
          artifacts,
        }),
        evidenceRoots: artifacts.map((artifact) => artifact.root),
        providerCode: "github-release-assets-observed",
      };
    },
    async apply(effect) {
      assertEffect(effect, "github-release-assets", ["github-release"]);
      const expected = normalizedArtifactBindings(effect, resolveArtifact);
      const expectedTarget = githubReleaseAssetsTargetRoot({
        destination: effect.destination,
        artifacts: expected,
      });
      if (expectedTarget !== effect.targetRoot) {
        providerError(
          "GitHub Release artifact bindings do not match the sealed target root",
          {
            code: "sealed-target-root-mismatch",
            classification: "conflict",
          },
        );
      }
      const observed = await releaseAndAssets(effect);
      let release = observed.release;
      if (!release) {
        try {
          release = (
            await octokit.rest.repos.createRelease({
              owner: observed.coordinate.owner,
              repo: observed.coordinate.repo,
              tag_name: observed.coordinate.tag,
              target_commitish: effect.subject.sourceSha,
              name: observed.coordinate.tag,
              draft: false,
              prerelease: effect.subject.channel === "alpha",
            })
          ).data;
        } catch (error) {
          throw classifyProviderError(error, "github-release-create-transient");
        }
      }
      const byName = new Map(
        observed.assets.map((asset) => [asset.name, asset]),
      );
      for (const artifact of expected) {
        const existing = byName.get(artifact.name);
        if (existing) {
          if (String(existing.digest || "").toLowerCase() !== artifact.root) {
            providerError(
              `immutable GitHub Release asset collision: ${artifact.name}`,
              {
                code: "github-asset-collision",
                classification: "conflict",
              },
            );
          }
          continue;
        }
        try {
          await octokit.rest.repos.uploadReleaseAsset({
            owner: observed.coordinate.owner,
            repo: observed.coordinate.repo,
            release_id: release.id,
            name: artifact.name,
            data: fs.readFileSync(artifact.path),
          });
        } catch (error) {
          throw classifyProviderError(error, "github-asset-upload-transient");
        }
      }
    },
  });
}
