import fs from "node:fs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
const receipt = JSON.parse(
  fs.readFileSync("github-governance-audit.json", "utf8"),
);
const { qualifyingCount, nonQualifyingCount } = receipt.inventory;
if (
  ![qualifyingCount, nonQualifyingCount].every(
    (value) => Number.isInteger(value) && value >= 0,
  ) ||
  !/^sha256:[a-f0-9]{64}$/u.test(receipt.auditRoot)
)
  throw new Error("invalid governance inventory receipt");
fs.appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  [
    "## GitHub governance authority",
    "",
    `- qualifying: ${qualifyingCount}`,
    `- non-qualifying: ${nonQualifyingCount}`,
    `- audit root: \`${receipt.auditRoot}\``,
    "",
  ].join("\n"),
);
writeGitHubOutputs({
  "non-qualifying": nonQualifyingCount,
  "audit-root": receipt.auditRoot,
});
