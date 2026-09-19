export function pipelineActionOutputs(core, result) {
  core.setOutput("operation", result.operation);
  core.setOutput("context", JSON.stringify(result.context || {}));
  core.setOutput(
    "matrix",
    JSON.stringify({ include: result.context?.platforms || [] }),
  );
  core.setOutput("request", JSON.stringify(result.request || {}));
  core.setOutput("attempt", result.attempt || result.context?.attempt || "");
  core.info(result.reason || result.operation);
}
