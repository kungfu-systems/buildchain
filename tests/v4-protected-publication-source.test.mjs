import assert from "node:assert/strict";
import test from "node:test";

import { bindV4ProtectedPublicationSource } from "../packages/core/v4-protected-publication-source.js";

const sha = (character) => character.repeat(40);

test("protected publication source accepts the exact qualified commit", () => {
  const result = bindV4ProtectedPublicationSource({
    repository: "kungfu-systems/buildchain",
    protectedCommit: { sha: sha("a"), tree: sha("b"), parents: [sha("c")] },
    candidateCommit: { sha: sha("a"), tree: sha("b"), parents: [sha("c")] },
  });
  assert.equal(result.mode, "exact-commit");
  assert.equal(result.protectedSource.sha, sha("a"));
  assert.match(result.bindingRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("protected publication source accepts the final PR merge over an equivalent qualification merge", () => {
  const parents = [sha("c"), sha("d")];
  const result = bindV4ProtectedPublicationSource({
    repository: "kungfu-systems/buildchain",
    protectedCommit: { sha: sha("a"), tree: sha("b"), parents },
    candidateCommit: { sha: sha("e"), tree: sha("b"), parents },
    pullRequest: {
      number: 3237,
      merged: true,
      headSha: sha("d"),
      mergeSha: sha("a"),
    },
  });
  assert.equal(result.mode, "merge-equivalent");
  assert.equal(result.pullRequestNumber, 3237);
});

test("protected publication source rejects tree, parent, or PR lineage drift", () => {
  const base = {
    repository: "kungfu-systems/buildchain",
    protectedCommit: {
      sha: sha("a"),
      tree: sha("b"),
      parents: [sha("c"), sha("d")],
    },
    candidateCommit: {
      sha: sha("e"),
      tree: sha("b"),
      parents: [sha("c"), sha("d")],
    },
    pullRequest: {
      number: 3237,
      merged: true,
      headSha: sha("d"),
      mergeSha: sha("a"),
    },
  };
  assert.throws(
    () =>
      bindV4ProtectedPublicationSource({
        ...base,
        candidateCommit: { ...base.candidateCommit, tree: sha("f") },
      }),
    /tree does not match/u,
  );
  assert.throws(
    () =>
      bindV4ProtectedPublicationSource({
        ...base,
        candidateCommit: {
          ...base.candidateCommit,
          parents: [sha("c"), sha("f")],
        },
      }),
    /not parent-equivalent/u,
  );
  assert.throws(
    () =>
      bindV4ProtectedPublicationSource({
        ...base,
        pullRequest: { ...base.pullRequest, mergeSha: sha("f") },
      }),
    /does not match the merged pull request/u,
  );
});
