import { runOperation } from "../../runtime/action-process.mjs";
import { resolvePublicationToolchain } from "./publication-toolchain.mjs";
import { readQualifiedManifest } from "./qualified-manifest.mjs";
import { bindQualifiedPackage } from "./qualified-package.mjs";
import {
  publicationControllerIdentities,
  provePublicationReproducibility,
  namePublicationArtifact,
} from "./candidate-build.mjs";
await runOperation({
  identities: publicationControllerIdentities,
  toolchain: resolvePublicationToolchain,
  reproducibility: provePublicationReproducibility,
  manifest: readQualifiedManifest,
  package: bindQualifiedPackage,
  names: namePublicationArtifact,
});
