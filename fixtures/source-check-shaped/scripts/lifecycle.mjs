import fs from "node:fs";

const stage = process.argv[2] || "unknown";
const mode = process.env.BUILDCHAIN_CHECK_MODE || "unknown";
fs.mkdirSync(".buildchain", { recursive: true });
fs.appendFileSync(".buildchain/source-check-events.txt", `${stage}:${mode}\n`);
