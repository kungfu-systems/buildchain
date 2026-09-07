import assert from "node:assert/strict";
import test from "node:test";
import { inspectImplementationName } from "../scripts/check-implementation-naming.mjs";

test("implementation naming rejects generation paths and nested declarations", () => {
  for (const generation of [4, 5, 12]) {
    assert.ok(
      inspectImplementationName(`scripts/v${generation}-publish.mjs`, "")
        .length,
    );
    assert.ok(
      inspectImplementationName(
        `crates/buildchain-v${generation}-domain/src/lib.rs`,
        "",
      ).length,
    );
    const source = `function publish() { const V${generation}_PLAN = {}; function runV${generation}Publication() {} }`;
    assert.equal(
      inspectImplementationName("scripts/publish.mjs", source).length,
      2,
    );
    assert.ok(
      inspectImplementationName(
        "packages/core/publication.js",
        `class V${generation}PublicationFault {}`,
      ).length,
    );
  }
});

test("wire identities and explicit export aliases do not rename implementations", () => {
  assert.deepEqual(
    inspectImplementationName(
      "packages/core/publication.js",
      `
    const PUBLICATION_CONTRACT = "kungfu.buildchain.v4-publication/v1";
    function publish() {}
    export { publish as publishV4 };
  `,
    ),
    [],
  );
  assert.deepEqual(
    inspectImplementationName(
      "scripts/publish.mjs",
      "function publish(candidate) {}",
    ),
    [],
  );
});

test("runtime directories, Rust functions and destructured bindings cannot reintroduce generations", () => {
  assert.ok(
    inspectImplementationName(
      "scripts/publish.mjs",
      'const output = ".buildchain/' + 'v5-runtime";',
    ).length,
  );
  assert.ok(
    inspectImplementationName(
      "crates/domain/src/lib.rs",
      "fn buildchain_v5_publish() {}",
    ).length,
  );
  assert.ok(
    inspectImplementationName(
      "scripts/publish.mjs",
      "function publish({ v5Candidate }) {}",
    ).length,
  );
});
