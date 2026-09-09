import { INSPECTION_COMMAND_HANDLERS } from "./inspection-handlers.mjs";
import { RELEASE_COMMAND_HANDLERS } from "./release-handlers.mjs";
import { handleVerifyCommand } from "./verification-handlers.mjs";

const TRUST_RELEASE_COMMAND_HANDLERS = Object.freeze({
  ...RELEASE_COMMAND_HANDLERS,
  verify: handleVerifyCommand,
  ...INSPECTION_COMMAND_HANDLERS,
});
const TRUST_RELEASE_COMMANDS = new Set(
  Object.keys(TRUST_RELEASE_COMMAND_HANDLERS),
);

export { TRUST_RELEASE_COMMANDS, TRUST_RELEASE_COMMAND_HANDLERS };
