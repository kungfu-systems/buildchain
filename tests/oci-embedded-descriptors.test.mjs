import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  hash,
  provider,
  compoundFixture,
} from "./helpers/oci-publication-fixtures.mjs";

function embeddedComposeFixture(t, change = () => {}) {
  const f = compoundFixture(t),
    entry = f.images[1];
  const file = (digest) =>
    path.join(f.directory, entry.layout, "blobs/sha256", digest.slice(7));
  const document = JSON.parse(fs.readFileSync(file(entry.digest)));
  document.config.data = fs
    .readFileSync(file(document.config.digest))
    .toString("base64");
  change(document.config, file);
  const descriptor = f.blob(entry, document);
  entry.digest = descriptor.digest;
  fs.writeFileSync(
    path.join(f.directory, entry.layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }),
  );
  f.reseal();
  return f;
}

test("OCI embedded config and BuildKit attestation retain exact manifest bytes", async (t) => {
  for (const f of [embeddedComposeFixture(t), compoundFixture(t, true)]) {
    f.verify();
    const p = provider(f);
    await p.adapter.apply(p.effect);
    for (const entry of f.images) {
      const tag =
        entry.kind === "compose" ? `compose-v${f.version}` : `v${f.version}`;
      assert.equal(
        hash(p.tags.get(`${entry.repository.slice(8)}:${tag}`)),
        entry.digest,
      );
    }
  }
});

for (const [name, change, error] of [
  [
    "invalid base64",
    (d) => {
      d.data = "!!!!";
    },
    /embedded OCI content mismatch/u,
  ],
  [
    "noncanonical pad bits",
    (d) => {
      d.data = "e31=";
    },
    /embedded OCI content mismatch/u,
  ],
  [
    "different bytes",
    (d) => {
      d.data = "W10=";
    },
    /embedded OCI content mismatch/u,
  ],
  [
    "wrong size",
    (d) => {
      d.size++;
    },
    /blob size mismatch/u,
  ],
  [
    "non-string data",
    (d) => {
      d.data = {};
    },
    /embedded OCI content mismatch/u,
  ],
  [
    "oversized inline data",
    (d) => {
      d.data = "A".repeat(1398104);
    },
    /embedded OCI content mismatch/u,
  ],
  [
    "missing local content",
    (d, file) => {
      fs.unlinkSync(file(d.digest));
    },
    /ENOENT/u,
  ],
  [
    "corrupted local content",
    (d, file) => {
      fs.writeFileSync(file(d.digest), "[]");
    },
    /blob digest mismatch/u,
  ],
  [
    "external URL",
    (d) => {
      d.urls = ["https://example.invalid/blob"];
    },
    /invalid OCI descriptor/u,
  ],
]) {
  test(`OCI embedded descriptors reject ${name}`, (t) => {
    const f = embeddedComposeFixture(t, change);
    assert.throws(f.verify, error);
  });
}
