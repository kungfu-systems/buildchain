export function rejectRequestAction(core) {
  throw new Error(core.getInput("reason", { required: true }));
}
