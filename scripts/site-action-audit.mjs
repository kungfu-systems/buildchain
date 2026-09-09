import fs from "node:fs";
import path from "node:path";
import { enumerateActionInputs } from "../packages/core/contracts/public-surface-audit.js";

export function actionSurfaceAudit({ root, actionCapabilityGroup, publicSurfaceLifecycle }) { return enumerateActionInputs({ root }).map((entry) => ({
      apiRole: JSON.parse(fs.readFileSync(path.join(root,"architecture/code-layout.json"),"utf8")).publicActionNodes.includes(entry.id) ? "public" : "implementation",
      ...entry,
      capabilityGroup: actionCapabilityGroup(entry.id),
      status: "active",
      ...publicSurfaceLifecycle({
        owner: "buildchain-actions",
        maturity: "stable",
        introducedVersion: entry.id.startsWith("build-") ? "4.0.9-alpha.0" : undefined,
        nonDuplicationRationale: "One capability node owns the composite or JavaScript adapter boundary.",
      }),
    })); }
