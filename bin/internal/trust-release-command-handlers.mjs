import { INSPECTION_COMMAND_HANDLERS } from "./trust-release-inspection-handlers.mjs";
import { RELEASE_COMMAND_HANDLERS } from "./trust-release-release-handlers.mjs";
import { handleVerifyCommand } from "./trust-release-verification-handlers.mjs";

const TRUST_RELEASE_COMMAND_HANDLERS = Object.freeze({
  ...RELEASE_COMMAND_HANDLERS,
  verify: handleVerifyCommand,
  ...INSPECTION_COMMAND_HANDLERS,
});
const TRUST_RELEASE_COMMANDS = new Set(
  Object.keys(TRUST_RELEASE_COMMAND_HANDLERS),
);

export { TRUST_RELEASE_COMMANDS, TRUST_RELEASE_COMMAND_HANDLERS };
