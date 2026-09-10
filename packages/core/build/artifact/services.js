import { createBuildArtifactStore } from "./store.js";
import { createBuildArtifactTransport } from "./transport.js";
import { createBuildAttestationService } from "./attestation.js";
import { createS3ObjectClient } from "../../providers/artifact-relay/s3-client.js";

export function createBuildArtifactServices(
  context,
  { token, awsCredentials, artifactClient, verifyAttestation },
) {
  const store = createBuildArtifactStore({ token, client: artifactClient });
  const relay = createS3ObjectClient({ credentials: awsCredentials });
  return {
    store,
    ...createBuildArtifactTransport({ ...context, store, relay }),
    ...createBuildAttestationService({ ...context, store, verifyAttestation }),
  };
}
