#!/usr/bin/env node
import { checkWorkflowTaxonomy } from "../packages/core/workflow/workflow-taxonomy.mjs";

const result = checkWorkflowTaxonomy(process.cwd());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
