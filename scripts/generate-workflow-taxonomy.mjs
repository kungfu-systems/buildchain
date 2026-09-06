#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  readWorkflowTaxonomy,
  renderWorkflowCatalog,
  TAXONOMY_DOC,
  workflowPath,
  writeWorkflowSource,
} from "./workflow-taxonomy.mjs";

const root = process.cwd();
const policy = readWorkflowTaxonomy(root);
if (!policy) throw new Error("workflow taxonomy is missing");
for (const entry of policy.entries) {
  writeWorkflowSource(
    root,
    workflowPath(entry),
    fs.readFileSync(path.join(root, workflowPath(entry)), "utf8"),
  );
}
fs.writeFileSync(path.join(root, TAXONOMY_DOC), renderWorkflowCatalog(policy));
process.stdout.write(
  `Generated ${policy.entries.length} canonical workflow declarations and their exact compatibility projections.\n`,
);
