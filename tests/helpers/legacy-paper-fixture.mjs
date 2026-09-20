import fs from "node:fs";
import path from "node:path";
import {
  sha256Text,
  stableJson,
} from "../../packages/core/paper/paper-repository.js";

// Frozen, synthetic schema-1 bytes exercise historical readers. This is not a
// consumer initializer and must never be imported by production code.
const snapshot = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/paper/legacy-consumer.json", import.meta.url),
    "utf8",
  ),
);
export const legacyPaperVersion = snapshot.files[".buildchain-version"].trim();
export function writeLegacyPaperFixture({
  cwd,
  name = "paper-contract-test",
  packageName = "@example/paper-contract-test",
  repository = "example/paper-contract-test",
}) {
  const files = Object.fromEntries(
    Object.entries(snapshot.files).map(([file, text]) => [
      file,
      text
        .replaceAll("@example/paper-contract-test", packageName)
        .replaceAll("example/paper-contract-test", repository)
        .replaceAll("paper-contract-test", name),
    ]),
  );
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, { flag: "wx" });
  }
  refreshLegacyPaperFixture(cwd);
}
export function refreshLegacyPaperFixture(cwd) {
  const relative = ".buildchain/paper/provisioning-authority.json";
  const authority = JSON.parse(
    fs.readFileSync(path.join(cwd, relative), "utf8"),
  );
  for (const [key, fileKey] of [
    ["policyDigest", "policyPath"],
    ["instructionsDigest", "instructionsPath"],
  ])
    authority.agentEntry[key] = sha256Text(
      fs.readFileSync(path.join(cwd, authority.agentEntry[fileKey]), "utf8"),
    );
  for (const workflow of Object.values(authority.workflows))
    workflow.sourceDigest = sha256Text(
      fs.readFileSync(path.join(cwd, workflow.path), "utf8"),
    );
  const { authorityDigest: _digest, ...payload } = authority;
  authority.authorityDigest = sha256Text(stableJson(payload));
  fs.writeFileSync(
    path.join(cwd, relative),
    `${JSON.stringify(authority, null, 2)}\n`,
  );
}
