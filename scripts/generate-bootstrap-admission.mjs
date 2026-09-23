import fs from "node:fs";
import { format } from "prettier";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readConsumerUpgrade } from "../packages/core/consumer/compatibility-workflows.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/universal-workflow-bootstrap.json"),
    "utf8",
  ),
);
const target = path.join(
  root,
  "architecture/universal-workflow-capability-policy.json",
);
const policy = JSON.parse(fs.readFileSync(target, "utf8"));
for (const entry of readConsumerUpgrade(root)?.entries || []) {
  if (!entry.interface.workflow_call) continue;
  for (const field of [
    "inventoryWorkflows",
    "directCapabilityWorkflows",
    "bootstrapGovernedWorkflows",
  ]) {
    if (
      contract[field].includes(entry.target) &&
      !contract[field].includes(entry.path)
    )
      contract[field].push(entry.path);
    contract[field].sort();
  }
}
fs.writeFileSync(
  path.join(root, "architecture/universal-workflow-bootstrap.json"),
  await format(JSON.stringify(contract), { parser: "json" }),
);
policy.contractRoots = contract.bootstrap.admissionPolicySources
  .map((file) => {
    if (path.isAbsolute(file) || file.split("/").includes(".."))
      throw new Error(`Invalid admission source: ${file}`);
    return `sha256:${crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex")}`;
  })
  .sort();
fs.writeFileSync(
  target,
  await format(JSON.stringify(policy), { parser: "json" }),
);
