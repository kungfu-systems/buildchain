export function exactWorkflowRuntime(value) {
  if (!/^[0-9a-f]{40}$/iu.test(value || ""))
    throw new Error("Called workflow requires an exact commit SHA");
  return value.toLowerCase();
}
export function exactWorkflowRuntimeAction(core) {
  core.setOutput(
    "sha",
    exactWorkflowRuntime(core.getInput("workflow-sha", { required: true })),
  );
}
