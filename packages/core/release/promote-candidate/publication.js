import { assertHistoricalPromotionEffects } from "../promotion/compatibility-qualification.js";
import { publishWithDiscussion } from "../discussion/publication.js";
import { promoteReleaseCandidate } from "./transaction.js";
import {
  historicalPromotionContext,
  HISTORICAL_PUBLISHER,
} from "../promotion/compatibility-context.js";

// Both transports execute the same qualified provider transaction. Historical
// callers did not grant Discussions access; their evidence stays in the existing
// Actions artifacts and provider receipts instead of creating a Discussion.
export function publishCandidate(
  request,
  context,
  {
    historical = promoteReleaseCandidate,
    current = publishWithDiscussion,
  } = {},
) {
  assertHistoricalPromotionEffects(request);
  const retained = historicalPromotionContext(
    request["historical-inputs-json"],
  );
  if (
    Boolean(retained) !==
    (request["publisher-workflow-path"] === HISTORICAL_PUBLISHER)
  )
    throw new Error(
      "Historical publisher requires its admitted compatibility context",
    );
  if (retained && request["resume-discussion-id"])
    throw new Error(
      "Historical publication cannot resume a Discussion transaction",
    );
  return (retained ? historical : current)(request, context);
}
