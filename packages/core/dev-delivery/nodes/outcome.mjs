import { requireValue, runOperation } from "../../runtime/action-process.mjs";
import { pathToFileURL } from "node:url";

export function enforceReservation(env) {
  if (env.WARRANT_MODE !== "off") {
    requireValue(
      env.QUALIFY_OUTCOME === "success",
      "Exact source qualification failed before Warrant scheduling",
    );
    requireValue(
      env.SUBMIT_OUTCOME === "success",
      "Delivery candidate submission failed",
    );
  }
  requireValue(
    env.WARRANT_MODE !== "required" || env.WARRANT_OUTCOME === "success",
    "Exact Delivery Warrant selection failed",
  );
  requireValue(
    env.HANDOFF_REQUIRED !== "true" || env.HANDOFF_DISPATCHED === "true",
    "Active Warrant handoff was not dispatched",
  );
}
export function enforceLanding(env) {
  const nativeQualified =
    env.ALREADY_QUALIFIED === "true" ||
    (env.BOUNDARY_OUTCOME === "success" && env.NATIVE_OUTCOME === "success");
  if (env.DEFER_LANDING === "true") {
    requireValue(
      env.WARRANT_MODE === "required",
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
  if (env.NATIVE_JOB_OUTCOME === "failure") {
    requireValue(
      env.FAILURE_FINAL_OUTCOME === "success",
      "Exact independently verified native failure did not settle its retained fence",
    );
    throw new Error(
      "Native execution failed; its exact verified failure root settled the retained fence",
    );
  }
  if (env.RUN_NATIVE === "true") {
    requireValue(
      env.SEAL_JOB_OUTCOME === "success",
      "Fresh credentialless native evidence seal did not complete",
    );
    requireValue(
      env.HEARTBEAT_JOB_OUTCOME === "success",
      "Independent credentialed Warrant heartbeat did not prove continuity through provider-terminal native and seal jobs; authority remains retained",
    );
  }
  requireValue(
    env.MERGE_STEP_OUTCOME === "success",
    "Buildchain dev PR controller failed; inspect the uploaded receipt",
  );
  requireValue(
    env.WARRANT_MODE !== "required" || nativeQualified,
    "Provisional Warrant did not atomically upgrade with an exact native proof",
  );
  requireValue(
    env.TARGETED !== "true" || env.TARGETED_OK === "true",
    "Targeted PR was not admitted at its expected head",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runOperation({ reserve: enforceReservation, land: enforceLanding });
