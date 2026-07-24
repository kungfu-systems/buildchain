#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validatePackageManagerContract } from "../packages/core/package-manager.js";

const cwd = path.resolve(
  process.env.BUILDCHAIN_PACKAGE_MANAGER_CWD || process.argv[2] || process.cwd(),
);
const expectedManager = process.env.BUILDCHAIN_EXPECTED_PACKAGE_MANAGER || "";
const contract = validatePackageManagerContract({ cwd, expectedManager });

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `name=${contract.name}\ndeclared-spec=${contract.declaredSpec}\ndeclared-version=${contract.declaredVersion}\n`,
  );
}

console.log(JSON.stringify({
  schemaVersion: 1,
  contract: "kungfu-buildchain-consumer-package-manager",
  ...contract,
}, null, 2));
