export function verifyNativeQualificationReadback(
  result,
  { pullRequestNumber, expectedHead },
  { native },
) {
  if (
    result.ok !== true ||
    result.outcome !== (native ? "native-proof-ready" : "qualified-warrant")
  )
    throw new Error("Native qualification did not reach the expected outcome");
  if (
    result.qualifiedWarrant?.phase !== (native ? "provisional" : "qualified") ||
    result.qualifiedWarrant.pullRequestNumber !== pullRequestNumber ||
    result.qualifiedWarrant.sourceHead !== expectedHead
  )
    throw new Error("Native qualification Warrant identity or phase drift");
  for (const key of [
    "nativeProofRoot",
    "nativeReuseDecisionRoot",
    ...(!native ? ["qualificationReceiptRoot"] : []),
  ]) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(result[key] || ""))
      throw new Error(`Native qualification ${key} is missing`);
  }
  return {
    "native-proof-root": result.nativeProofRoot,
    "decision-root": result.nativeReuseDecisionRoot,
    ...(!native
      ? { "qualification-receipt-root": result.qualificationReceiptRoot }
      : {}),
  };
}
