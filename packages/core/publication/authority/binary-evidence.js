import path from "node:path";
import {
  validateControllerPlan,
  validateControllerReceipt,
} from "../../observability/controller-evidence.js";
import { one, oneEvidenceFile, sha256File } from "./evidence.js";
function validateBundle(manifest, archivePath, { sourceSha, releaseTag }) {
  if (manifest?.contract !== "kungfu-buildchain-release-evidence-bundle") {
    throw new Error("binary release evidence bundle contract mismatch");
  }
  if (manifest.release?.tag !== releaseTag)
    throw new Error("binary release evidence tag mismatch");
  if (String(manifest.release?.sourceSha || "").toLowerCase() !== sourceSha) {
    throw new Error("binary release evidence source mismatch");
  }
  if (
    sha256File(archivePath) !==
    String(manifest.bundle?.sha256 || "").replace(/^sha256:/, "")
  ) {
    throw new Error("binary release evidence archive digest mismatch");
  }
  const names = new Set(
    (manifest.files || []).map((entry) => entry.bundlePath),
  );
  for (const requiredPath of [
    "release-assets/buildchain-aarch64-apple-darwin.tar.gz",
    "release-assets/buildchain-x86_64-unknown-linux-gnu.tar.gz",
    "release-assets/buildchain-x86_64-pc-windows-msvc.zip",
    "release-assets/checksums.txt",
    "release-passport/buildchain.release.json",
  ]) {
    if (!names.has(requiredPath))
      throw new Error(`binary release evidence is missing ${requiredPath}`);
  }
}

export function collectBinaryAdmissionEvidence({
  evidenceRoot,
  sourceSha,
  publicationVersion,
  registry,
}) {
  const releaseTag = `v${publicationVersion}`,
    passportRoot = path.join(evidenceRoot, "binary-passport"),
    controllerRoot = path.join(evidenceRoot, "binary-controller");
  const manifest = one(passportRoot, "buildchain-release-bundle.json"),
    archivePath = oneEvidenceFile(
      passportRoot,
      "buildchain-release-bundle.tar.gz",
    );
  const controllerPlan = one(controllerRoot, "plan.json"),
    controllerReceipt = one(controllerRoot, "receipt.json");
  validateBundle(manifest, archivePath, { sourceSha, releaseTag });
  const planValidation = validateControllerPlan(controllerPlan);
  if (!planValidation.ok || !planValidation.qualifying)
    throw new Error(
      `binary distribution controller plan did not qualify: ${planValidation.issues.join("; ")}`,
    );
  const validation = validateControllerReceipt(controllerReceipt, {
    plan: controllerPlan,
    expectedSourceSha: sourceSha,
  });
  if (!validation.ok || !validation.qualifying)
    throw new Error(
      `binary distribution controller receipt did not qualify: ${validation.issues.join("; ")}`,
    );
  if (controllerReceipt.controller?.id !== "binary-distribution")
    throw new Error(
      "binary distribution controller receipt has the wrong controller id",
    );
  return {
    controllerReceipt,
    runtimeSha: controllerReceipt.runtime.sha,
    artifactDigest: manifest.bundle.sha256,
    registry,
  };
}
