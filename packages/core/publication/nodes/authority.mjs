import { runOperation } from "../../runtime/action-process.mjs";
import {
  requireImmutableAuthority,
  requireSealedInputs,
  requireManagedInputs,
} from "./authority-admission.mjs";
import {
  resolveControllerEvidence,
  auditControlPlane,
  recordAuthorityDryRun,
  exportAuthorityResult,
} from "./authority-io.mjs";

await runOperation({
  immutable: requireImmutableAuthority,
  "sealed-inputs": requireSealedInputs,
  "managed-inputs": requireManagedInputs,
  governance: async (env) =>
    (await import("./authority-governance.mjs")).verifyLiveGovernance(env),
  controller: resolveControllerEvidence,
  "consumer-gate": async (env) =>
    (await import("./authority-consumer-gate.mjs")).assembleConsumerGate(env),
  "audit-candidate": (env) => auditControlPlane(env, "candidate"),
  "audit-artifact": (env) => auditControlPlane(env, "artifact"),
  "audit-binary": (env) => auditControlPlane(env, "binary"),
  verify: async (env) =>
    (await import("./authority-verification.mjs")).verifySealedAdmission(env),
  "dry-run": recordAuthorityDryRun,
  outputs: exportAuthorityResult,
});
