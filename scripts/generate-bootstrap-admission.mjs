import fs from "node:fs";
import { format } from "prettier";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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
