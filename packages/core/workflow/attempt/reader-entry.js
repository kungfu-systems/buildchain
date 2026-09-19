import fs from "node:fs";
import { readBusinessAttempt } from "./reader.js";
export { readBusinessAttempt } from "./reader.js";

// Captured, provider-authenticated JSON only. No live ref lookup or effects.
if (typeof require !== "undefined" && require.main === module) {
  const state = readBusinessAttempt(JSON.parse(fs.readFileSync(0, "utf8")));
  const { status, reason, attempt, generation, missing, recovery } = state;
  process.stdout.write(
    `${JSON.stringify({ status, reason, attempt, generation, missing, recovery })}\n`,
  );
}
