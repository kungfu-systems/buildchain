import fs from "node:fs";
import { publicationContext, uniquePublicationMaterial } from "./context.js";
import { distributePipelineProducts } from "./distribution.js";
import { nextPipelineDevelopment } from "./next-development.js";

export async function settlePipelinePublication(
  context,
  host,
  directory,
  environment,
) {
  const { session, journal } = await publicationContext(context, host);
  if (session.observed.phases.publish?.payload.state !== "success")
    throw new Error(
      "Publication must retain success before distribution and next-development",
    );
  fs.mkdirSync(directory, { recursive: true });
  const retained = await uniquePublicationMaterial(
    journal,
    "publication/qualified/",
  );
  if (session.observed.phases.distribution?.payload.state !== "success") {
    const receipt = await distributePipelineProducts(
      context,
      host,
      journal,
      retained,
      environment,
      directory,
    );
    await journal.record("publication/distribution-complete", receipt, {
      phase: "distribution",
      state: "success",
    });
  }
  const next = await nextPipelineDevelopment(context, host, journal);
  await journal.record("publication/next-development-result", next, {
    phase: "next-development",
    state: next.state,
  });
  await host.project(session);
  return next;
}
