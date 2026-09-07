import assert from "node:assert/strict";
import test from "node:test";

import { bindProtectedPublicationSource } from "../packages/core/protected-publication-source.js";

const sha = (character) => character.repeat(40);

const squashCandidate = () => ({
  repository: "kungfu-systems/taolu",
  protectedCommit: { sha: sha("a"), tree: sha("b"), parents: [sha("c")] },
  candidateCommit: {
    sha: sha("e"),
    tree: sha("b"),
    parents: [sha("c"), sha("d")],
  },
  pullRequest: {
    number: 32,
    merged: true,
    headSha: sha("d"),
    mergeSha: sha("a"),
  },
});

test("protected publication source accepts the exact qualified squash lineage", () => {
  const result = bindProtectedPublicationSource(squashCandidate());
  assert.equal(result.mode, "squash-equivalent");
  assert.equal(result.pullRequestNumber, 32);
  assert.equal(result.protectedSource.sha, sha("a"));
  assert.equal(result.candidateSource.sha, sha("e"));
  assert.match(result.bindingRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("protected publication source binds the public Taolu PR 32 squash candidate", () => {
  // Public commit metadata from https://github.com/kungfu-systems/taolu/pull/32.
  const result = bindProtectedPublicationSource({
    repository: "kungfu-systems/taolu",
    protectedCommit: {
      sha: "fd8c496720d054953f8c336608e36bc85fac342b",
      tree: "af34e04a383e06c8699e8446b01239742037b622",
      parents: ["40de6f36c2f8b374033d99f76d692d4c31ae76d3"],
    },
    candidateCommit: {
      sha: "da9bf2a348983203812818c5097112255eb03f15",
      tree: "af34e04a383e06c8699e8446b01239742037b622",
      parents: [
        "40de6f36c2f8b374033d99f76d692d4c31ae76d3",
        "3ce40d3b30a7202e0b928bbb43ec9fb64d7595bd",
      ],
    },
    pullRequest: {
      number: 32,
      merged: true,
      headSha: "3ce40d3b30a7202e0b928bbb43ec9fb64d7595bd",
      mergeSha: "fd8c496720d054953f8c336608e36bc85fac342b",
    },
  });
  assert.equal(result.mode, "squash-equivalent");
  assert.equal(result.pullRequestNumber, 32);
});

for (const [name, mutate, error] of [
  [
    "tree drift",
    (x) => {
      x.protectedCommit.tree = sha("f");
    },
    /tree does not match/u,
  ],
  [
    "base drift",
    (x) => {
      x.protectedCommit.parents = [sha("f")];
    },
    /not parent-equivalent/u,
  ],
  [
    "head drift",
    (x) => {
      x.pullRequest.headSha = sha("f");
    },
    /does not match the merged pull request/u,
  ],
  [
    "unmerged PR",
    (x) => {
      x.pullRequest.merged = false;
    },
    /does not match the merged pull request/u,
  ],
  [
    "wrong merge",
    (x) => {
      x.pullRequest.mergeSha = sha("f");
    },
    /does not match the merged pull request/u,
  ],
  [
    "reversed candidate parents",
    (x) => {
      x.candidateCommit.parents.reverse();
    },
    /not parent-equivalent/u,
  ],
  [
    "octopus candidate",
    (x) => {
      x.candidateCommit.parents.push(sha("f"));
    },
    /not parent-equivalent/u,
  ],
  [
    "base presented as PR head",
    (x) => {
      x.pullRequest.headSha = sha("c");
    },
    /does not match the merged pull request/u,
  ],
  [
    "missing PR",
    (x) => {
      delete x.pullRequest;
    },
    /publication pull request head SHA must be an exact Git SHA/u,
  ],
  [
    "invalid PR number",
    (x) => {
      x.pullRequest.number = 0;
    },
    /does not match the merged pull request/u,
  ],
  [
    "candidate without base",
    (x) => {
      x.candidateCommit.parents.shift();
    },
    /not parent-equivalent/u,
  ],
  [
    "protected commit without parent",
    (x) => {
      x.protectedCommit.parents = [];
    },
    /not parent-equivalent/u,
  ],
]) {
  test(`protected squash publication rejects ${name}`, () => {
    const input = squashCandidate();
    mutate(input);
    assert.throws(() => bindProtectedPublicationSource(input), error);
  });
}

test("protected publication source accepts the exact qualified commit", () => {
  const result = bindProtectedPublicationSource({
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
  const result = bindProtectedPublicationSource({
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
      bindProtectedPublicationSource({
        ...base,
        candidateCommit: { ...base.candidateCommit, tree: sha("f") },
      }),
    /tree does not match/u,
  );
  assert.throws(
    () =>
      bindProtectedPublicationSource({
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
      bindProtectedPublicationSource({
        ...base,
        pullRequest: { ...base.pullRequest, mergeSha: sha("f") },
      }),
    /does not match the merged pull request/u,
  );
});
