import fs from "node:fs";

const stage = process.argv[2] || "unknown";
fs.mkdirSync(".buildchain", { recursive: true });
fs.appendFileSync(".buildchain/source-check-events.txt", `${stage}\n`);
