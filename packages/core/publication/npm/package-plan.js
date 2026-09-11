export function normalizePackageSet(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("package set must include at least one package");
  }
  return packages.map((pkg, index) => {
    const name = String(pkg?.name || "").trim();
    const version = String(pkg?.version || "").trim();
    if (!name) {
      throw new Error(`packages[${index}].name is required`);
    }
    if (!version) {
      throw new Error(`packages[${index}].version is required`);
    }
    return {
      name,
      version,
      role: pkg.role === "main" ? "main" : "platform",
      integrity: pkg.integrity ? String(pkg.integrity) : "",
    };
  });
}

export function existingPackageKey(entry) {
  return `${entry.name}@${entry.version}`;
}

export function planPackageSetPublish({
  packages = [],
  existingPackages = [],
  mainPackage = "",
  distTag = "alpha",
} = {}) {
  const normalized = normalizePackageSet(packages).map((pkg) => ({
    ...pkg,
    role: pkg.name === mainPackage ? "main" : pkg.role,
  }));
  const mainPackages = normalized.filter((pkg) => pkg.role === "main");
  if (mainPackages.length !== 1) {
    throw new Error("package set must contain exactly one main package");
  }
  const existing = new Map(
    existingPackages.map((pkg) => {
      const normalizedExisting = normalizePackageSet([pkg])[0];
      return [existingPackageKey(normalizedExisting), normalizedExisting];
    }),
  );
  const steps = [];
  for (const pkg of normalized) {
    const already = existing.get(existingPackageKey(pkg));
    if (already) {
      if (
        pkg.integrity &&
        already.integrity &&
        pkg.integrity !== already.integrity
      ) {
        throw new Error(
          `existing package integrity mismatch: ${pkg.name}@${pkg.version}`,
        );
      }
      steps.push({ action: "accept-existing", package: pkg });
    } else {
      steps.push({ action: "publish", package: pkg });
    }
  }
  const orderedSteps = [
    ...steps.filter((step) => step.package.role !== "main"),
    ...steps.filter((step) => step.package.role === "main"),
  ];
  const main = mainPackages[0];
  return {
    completeAfterPlan: true,
    visibilityGate: "main-package-last",
    distTag,
    steps: orderedSteps,
    distTagMove: {
      action: "move-dist-tag",
      package: main,
      distTag,
      after: "package-set-complete",
    },
  };
}
