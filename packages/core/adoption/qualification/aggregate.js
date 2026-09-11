import { qualifyCrossPlatformAdopters } from "../cross-platform-adopter-qualification.js";
import { collectReports, writeJson } from "./io.js";
export function reconcileAdopterReports({ reportsRoot, consumers, output }) {
  const qualification = qualifyCrossPlatformAdopters({
    reports: collectReports(reportsRoot),
    consumers,
  });
  if (output) writeJson(output, qualification);
  return qualification;
}
