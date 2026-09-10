import fs from "node:fs";
import { domainCanonicalBytes } from "../../../contracts/canonical-contracts.js";
import { installationRoot } from "../../../runtime/installation-root.js";
import { createCampaignContext } from "./context.js";
import { seedStageCapsuleCampaign } from "./seed.js";
import { resumeStageCapsuleCampaign } from "./resume.js";
const { phase, request } = JSON.parse(fs.readFileSync(0, "utf8"));
const context = createCampaignContext({
  ...request,
  runtimeRoot: installationRoot(import.meta.url),
});
if (phase === "seed") seedStageCapsuleCampaign(context);
else if (phase === "resume")
  process.stdout.write(
    domainCanonicalBytes(resumeStageCapsuleCampaign(context)),
  );
else throw new Error("Unknown Stage Capsule campaign phase");
