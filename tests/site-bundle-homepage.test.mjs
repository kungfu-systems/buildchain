import assert from "node:assert/strict";
import test from "node:test";

import { projectHomepageIntro } from "../scripts/site-bundle-homepage.mjs";

test("homepage projection keeps the complete managed badge block in lead", () => {
  const intro = [
    "<!-- buildchain:badges:start -->",
    "[![KFD-1](https://example.test/kfd-1.svg)](https://example.test/kfd-1)",
    "[![KFD-2](https://example.test/kfd-2.svg)](https://example.test/kfd-2)",
    "<!-- buildchain:badges:end -->",
    "",
    "Buildchain is the release and build control plane.",
    "",
    "It keeps release evidence deterministic.",
  ].join("\n");

  assert.deepEqual(projectHomepageIntro(intro), {
    lead: [
      "<!-- buildchain:badges:start -->",
      "[![KFD-1](https://example.test/kfd-1.svg)](https://example.test/kfd-1)",
      "[![KFD-2](https://example.test/kfd-2.svg)](https://example.test/kfd-2)",
      "<!-- buildchain:badges:end -->",
    ].join("\n"),
    mechanismSummary: [
      "Buildchain is the release and build control plane.",
      "It keeps release evidence deterministic.",
    ],
  });
});

test("homepage projection preserves the legacy first-paragraph fallback without badges", () => {
  assert.deepEqual(projectHomepageIntro("Lead paragraph.\n\nMechanism paragraph."), {
    lead: "Lead paragraph.",
    mechanismSummary: ["Mechanism paragraph."],
  });
});

test("homepage projection rejects a partial managed badge block", () => {
  assert.throws(
    () => projectHomepageIntro("<!-- buildchain:badges:start -->\nBadge"),
    /managed badge block is incomplete/,
  );
});
