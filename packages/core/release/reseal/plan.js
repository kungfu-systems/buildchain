import path from "node:path";
import { normalizeTailResealRequest, planTailReseal } from "../tail-reseal.js";
import {
  verifyTailPolicyBindings,
  admitTailResealFromGitHub,
} from "./admission.js";
import { writeJson } from "./files.js";
export async function admitTailResealPlan(
  { request: input, receipt, workspace, runtimeSha, sourceSha, repository },
  github,
) {
  const request = normalizeTailResealRequest(input);
  if (request.repository !== repository)
    throw new Error("Tail reseal repository differs from invoked repository");
  const directory = path.join(workspace, ".buildchain/tail-reseal");
  writeJson(path.join(directory, "request.json"), input);
  writeJson(path.join(directory, "consumer-policy-receipt.json"), receipt);
  const plan = planTailReseal(request);
  writeJson(path.join(directory, "plan.json"), plan);
  verifyTailPolicyBindings({ request, receipt, runtimeSha, sourceSha });
  const admission = await admitTailResealFromGitHub(request, github);
  writeJson(path.join(directory, "admission.json"), admission);
  return { request, plan, admission };
}
