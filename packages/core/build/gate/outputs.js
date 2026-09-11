export function gatePlanOutputs(matrix, matrixPath) {
  return {
    "gate-matrix-json": JSON.stringify(matrix.entries),
    "gate-matrix-count": String(matrix.entries.length),
    "gate-matrix-digest": matrix.digest,
    "gate-matrix-path": matrixPath,
    "gate-project-id": matrix.registry.projectId,
    "gate-registry-digest": matrix.registry.digest,
  };
}
export function gateExecutionOutputs(result) {
  return {
    "gate-platform-id": result.execution.platformId,
    "gate-receipt-path": result.receiptPath,
    "gate-validation-path": result.validationPath,
    "gate-execution-path": result.executionPath,
    "gate-qualifying": String(
      result.execution.receipt?.qualifying === true &&
        result.execution.validation?.qualifying === true,
    ),
  };
}
export function gateAggregateOutputs(aggregate, outputPath) {
  return {
    "gate-aggregate-path": outputPath,
    "gate-aggregate-json": JSON.stringify(aggregate),
    "gate-aggregate-digest": aggregate.digest,
    "gate-aggregate-status": aggregate.status,
    "gate-aggregate-qualifying": String(aggregate.qualifying),
  };
}
