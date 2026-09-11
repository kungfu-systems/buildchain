export function normalizePublishSourceRef(ref = "") {
  return String(ref || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}
export function parseLockedPublishSource(ref = "") {
  const sourceRef = normalizePublishSourceRef(ref);
  if (sourceRef === "publish-gate/major") {
    return { sourceRef, channel: "major", line: "", consumerVersion: "" };
  }
  const match = sourceRef.match(
    /^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/,
  );
  if (!match) {
    return { sourceRef, channel: "", line: "", consumerVersion: "" };
  }
  return {
    sourceRef,
    channel: match[1],
    line: match[2],
    consumerVersion: match[3],
  };
}
export function checkSourceLock(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}
export function validateRequiredPublishSourceLock({
  sha,
  publishSourceRef = "",
  publishSourceSha = "",
  publishSourceLocked = "",
} = {}) {
  if (publishSourceSha && publishSourceSha !== sha) {
    throw new Error(
      `publish-source-sha ${publishSourceSha} does not match promotion sha ${sha}`,
    );
  }
  const parsed = parseLockedPublishSource(publishSourceRef);
  const locked = String(publishSourceLocked || "").toLowerCase();
  const effectiveSha = publishSourceSha || sha || "";
  const sourceLockReport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publish-source-lock-validation",
    ok: false,
    checks: [
      checkSourceLock(
        locked === "true" || locked === "1" || publishSourceLocked === true,
        "publish.source_locked",
        "publish source lock is required before package publication",
        { sourceLocked: publishSourceLocked || "" },
      ),
      checkSourceLock(
        !!parsed.channel,
        "publish.source_ref",
        "publish source ref uses publish-gate/{alpha,release,major}",
        {
          sourceRef: parsed.sourceRef || publishSourceRef || "",
          channel: parsed.channel,
        },
      ),
      checkSourceLock(
        /^[0-9a-f]{40}$/i.test(String(effectiveSha)),
        "publish.source_sha",
        "publish source SHA is a 40-character Git SHA",
        { sourceSha: effectiveSha },
      ),
    ],
    summary: {
      publishSource: {
        sourceRef: parsed.sourceRef || publishSourceRef || "",
        sourceSha: effectiveSha,
        sourceLocked: publishSourceLocked || "",
        channel: parsed.channel,
        line: parsed.line,
        consumerVersion: parsed.consumerVersion,
      },
    },
  };
  sourceLockReport.ok = sourceLockReport.checks.every(
    (check) => check.status === "pass",
  );
  if (!sourceLockReport.ok) {
    const failed = sourceLockReport.checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(`publish source-lock validation failed: ${failed}`);
  }
  return sourceLockReport;
}
