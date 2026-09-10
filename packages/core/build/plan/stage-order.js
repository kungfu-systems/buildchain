export function assertStageOrder(stages, stage) {
  const order = ["install", "build", "verify"];
  const index = order.indexOf(stage);
  if (index < 0 || Object.hasOwn(stages, stage))
    throw new Error("Invalid or repeated build stage");
  for (const prerequisite of order.slice(0, index)) {
    if (!["success", "not-required"].includes(stages[prerequisite]))
      throw new Error(`Missing successful ${prerequisite} before ${stage}`);
  }
}
