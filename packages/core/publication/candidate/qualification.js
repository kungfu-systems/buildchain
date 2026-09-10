import { resolvePublicationToolchain } from "./toolchain.js";
import { hydratePublishedPublicationRegistry } from "./registry-hydration.js";
import { provePublicationReproducibility } from "./reproducibility.js";
import { readQualifiedManifest } from "./manifest.js";
import { bindQualifiedPackage } from "./paper-package.js";
import { consumerCommandSession } from "../../runtime/consumer-shell.js";
export async function qualifyPublicationCandidate(
  request,
  {
    resolve = resolvePublicationToolchain,
    hydrate = hydratePublishedPublicationRegistry,
    prove = provePublicationReproducibility,
    manifest = readQualifiedManifest,
    bind = bindQualifiedPackage,
    session = consumerCommandSession(request.env),
    observe = () => {},
  } = {},
) {
  const outcomes = {
    build: "skipped",
    verify: "skipped",
    manifest: "skipped",
    package: "skipped",
  };
  let manifestResult = {},
    packageResult = {};
  try {
    const toolchain = await resolve(request);
    if (request.preparePaperPackage) await hydrate({ cwd: request.cwd });
    if (toolchain.command) {
      outcomes.build = "failure";
      await prove({ ...request, toolchain });
      outcomes.build = "success";
    }
    if (request.verifyCommand) {
      outcomes.verify = "failure";
      await session.run({
        cwd: request.cwd,
        script: request.verifyCommand,
        strict: true,
      });
      outcomes.verify = "success";
    }
    outcomes.manifest = "failure";
    manifestResult = await manifest(request);
    outcomes.manifest = "success";
    if (request.preparePaperPackage) {
      outcomes.package = "failure";
      packageResult = await bind({ ...request, env: session.environment });
      outcomes.package = "success";
    }
    return { outcomes, manifest: manifestResult, package: packageResult };
  } finally {
    observe({ outcomes, manifest: manifestResult, package: packageResult });
  }
}
