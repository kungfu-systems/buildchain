import kfdCategoryCatalog from "@kungfu-tech/kfd/adopter-conformance/category-profiles.json" with { type: "json" };
import kfdPackageJson from "@kungfu-tech/kfd/package.json" with { type: "json" };
import { resolveAdopterCategoryProfiles } from "@kungfu-tech/kfd/adopter-conformance/category-profile-resolver";
import { verifyAdopterCategoryInstanceManifest } from "@kungfu-tech/kfd/adopter-conformance/category-instance-verifier";
import { verifyAdopterManifestFromPackage } from "@kungfu-tech/kfd/adopter-conformance/toolchain";

import {
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  adopterDeliveryGateDigest,
  defineAdopterProtocolDriver,
} from "./adopter-delivery-gate.js";

export const KFD_ADOPTER_CATEGORY_PROTOCOL_ID =
  "kfd.adopter-category/instance-manifest";
export const KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION = "1.0.0";
export const KFD_ADOPTER_CATEGORY_DRIVER_REPORT_CONTRACT =
  "kungfu-buildchain-kfd-adopter-category-driver-report";

function freezeJson(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeJson(child);
  }
  return value;
}

const publishedCatalog = freezeJson(structuredClone(kfdCategoryCatalog));

function catalogCopy() {
  return structuredClone(publishedCatalog);
}

function sameJson(left, right) {
  try {
    return adopterDeliveryGateDigest(left) === adopterDeliveryGateDigest(right);
  } catch {
    return false;
  }
}

function issue(code, path, message) {
  return { code, path, message };
}

export function resolvePublishedKfdAdopterCategoryProfiles(selection) {
  return resolveAdopterCategoryProfiles(
    structuredClone(selection),
    catalogCopy(),
  );
}

export function verifyPublishedKfdAdopterCategoryInstance(
  instanceManifest,
  { adopterManifest, verifiedAt, maxAgeSeconds } = {},
) {
  const adopterReport = verifyAdopterManifestFromPackage(adopterManifest, {
    packageArtifactRoot: instanceManifest?.kfdCut?.packageRoot,
    verifiedAt,
    maxAgeSeconds,
  });
  return verifyAdopterCategoryInstanceManifest(instanceManifest, {
    catalog: catalogCopy(),
    adopterManifest,
    adopterReport,
    verifiedAt,
    maxAgeSeconds,
  });
}

function deliveryBindingIssues(request, adopterManifest) {
  const instance = request.declaration;
  const issues = [];
  if (
    request.project.instanceId !== instance?.instanceId ||
    request.project.adopterId !== instance?.project?.adopterId
  ) {
    issues.push(
      issue(
        "delivery-kfd-instance-binding-mismatch",
        "/project",
        "Delivery project identity must match the KFD category instance.",
      ),
    );
  }
  if (!sameJson(request.artifact, instance?.project?.artifact)) {
    issues.push(
      issue(
        "delivery-kfd-instance-binding-mismatch",
        "/artifact",
        "Delivery artifact must match the KFD category instance artifact.",
      ),
    );
  }
  if (
    adopterManifest?.kfdCut?.package?.name !== kfdPackageJson.name ||
    adopterManifest?.kfdCut?.package?.version !== kfdPackageJson.version ||
    instance?.kfdCut?.packageVersion !== kfdPackageJson.version
  ) {
    issues.push(
      issue(
        "delivery-kfd-package-cut-mismatch",
        "/declaration/kfdCut",
        "KFD declarations must bind the exact installed published package version.",
      ),
    );
  }
  return issues;
}

function driverReport(categoryReport, adapterIssues) {
  const valid = categoryReport?.valid === true && adapterIssues.length === 0;
  const report = {
    schemaVersion: 1,
    contract: KFD_ADOPTER_CATEGORY_DRIVER_REPORT_CONTRACT,
    valid,
    conforming: valid,
    qualifying: false,
    selfCertified: false,
    independentlyCertified: false,
    kfdPackage: {
      name: kfdPackageJson.name,
      version: kfdPackageJson.version,
    },
    categoryReport,
    adapterIssues,
    nonClaims: [
      "Category conformance does not grant runtime permission or release authorization.",
      "Buildchain carries the published KFD decision and does not certify or reinterpret it.",
    ],
  };
  return {
    valid,
    report,
    reportRoot: adopterDeliveryGateDigest(report),
    issues: [...(categoryReport?.issues ?? []), ...adapterIssues],
  };
}

export function createKfdAdopterCategoryProtocolDriver() {
  return defineAdopterProtocolDriver({
    interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
    id: KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
    version: KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
    verify({ request, context }) {
      const adapterIssues = deliveryBindingIssues(
        request,
        context?.adopterManifest,
      );
      let categoryReport = null;
      try {
        categoryReport = verifyPublishedKfdAdopterCategoryInstance(
          request.declaration,
          context,
        );
      } catch {
        adapterIssues.push(
          issue(
            "delivery-kfd-verification-context-invalid",
            "/protocol",
            "Published KFD verification could not reproduce from the supplied exact context.",
          ),
        );
      }
      return driverReport(categoryReport, adapterIssues);
    },
  });
}
