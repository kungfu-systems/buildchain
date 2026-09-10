import { requireValue } from "../../runtime/action-process.mjs";
export function enforceLanding(outcomes) {
  const nativeQualified =
    outcomes.alreadyQualified === "true" ||
    (outcomes.boundaryOutcome === "success" &&
      outcomes.nativeQualificationOutcome === "success");
  if (outcomes.deferLanding === "true") {
    requireValue(
      outcomes.warrantMode === "required",
      "defer-landing requires delivery-warrant-mode required",
    );
    requireValue(
      nativeQualified,
      "defer-landing requires exact native Warrant qualification",
    );
    console.log(
      "Exact required Warrant qualified; landing is explicitly deferred.",
    );
    return;
  }
  if (outcomes.nativeJobOutcome === "failure") {
    requireValue(
      outcomes.failureSettlementOutcome === "success",
      "Exact independently verified native failure did not settle its retained fence",
    );
    throw new Error(
      "Native execution failed; its exact verified failure root settled the retained fence",
    );
  }
  if (outcomes.runNative === "true") {
    requireValue(
      outcomes.sealJobOutcome === "success",
      "Fresh credentialless native evidence seal did not complete",
    );
    requireValue(
      outcomes.heartbeatJobOutcome === "success",
      "Independent credentialed Warrant heartbeat did not prove continuity through provider-terminal native and seal jobs; authority remains retained",
    );
  }
  requireValue(
    outcomes.mergeStepOutcome === "success",
    "Buildchain dev PR controller failed; inspect the uploaded receipt",
  );
  requireValue(
    outcomes.warrantMode !== "required" || nativeQualified,
    "Provisional Warrant did not atomically upgrade with an exact native proof",
  );
  requireValue(
    outcomes.targeted !== "true" || outcomes.targetedOk === "true",
    "Targeted PR was not admitted at its expected head",
  );
}
