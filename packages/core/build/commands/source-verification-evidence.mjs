import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectSourceVerification, startSourceVerification, sealSourceVerification, recordSourceVerification, verificationProvider } from "../verification/source.js";

export async function main(mode) {
  const workspace = process.cwd(), env = process.env;
  const options = { workspace, env, runtimeRoot: path.join(workspace, ".buildchain/runtime"), summaryPath: env.GITHUB_STEP_SUMMARY, provider: verificationProvider({ workspace, env, token: env.GH_TOKEN }) };
  if (mode === "plan") { const decision = await selectSourceVerification(options); recordSourceVerification(options, decision); if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `decision=${decision.decision}\n`); console.log(JSON.stringify(decision)); return decision; }
  if (mode === "start") return startSourceVerification(options);
  if (mode === "seal") return sealSourceVerification({ ...options, started: JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/source-verification/start.json"), "utf8")) });
  throw new Error(`unknown verification evidence mode: ${mode}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
