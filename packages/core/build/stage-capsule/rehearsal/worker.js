import fs from "node:fs";
import { installationRoot } from "../../../runtime/installation-root.js";
import {
  emitCheckpointRehearsal,
  restoreCheckpointRehearsal,
} from "./checkpoint.js";
const { phase, request } = JSON.parse(fs.readFileSync(0, "utf8"));
const context = { ...request, runtimeRoot: installationRoot(import.meta.url) };
if (phase === "emit") emitCheckpointRehearsal(context);
else if (phase === "restore") restoreCheckpointRehearsal(context);
else throw new Error("Unknown Stage Capsule checkpoint phase");
