import { runOperation } from "../../runtime/action-process.mjs";
import { qualifyNative } from "./native-qualification.mjs";
import { verifyProviderBoundary } from "./provider-boundary.mjs";
await runOperation({
  execute: (env) => qualifyNative(env, "execute"),
  finalize: (env) => qualifyNative(env, "finalize"),
  boundary: verifyProviderBoundary,
});
