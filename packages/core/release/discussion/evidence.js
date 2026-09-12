// Evidence is declared transaction data, never an implicit upload of workspace
// files, environment variables, raw exceptions or authenticated HTTP responses.
export async function retainAttachment(materials, { name, mediaType, bytes }) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(name) ||
    !["application/json", "text/plain", "application/octet-stream"].includes(
      mediaType,
    )
  )
    throw new Error("Invalid transaction attachment descriptor");
  const handle = await materials.put(bytes, { name, mediaType });
  if (!handle.downloadUrl)
    throw new Error("Retained attachment is missing its provider download URL");
  return { name, mediaType, ...handle };
}

export function diagnosticReport(session, state, node, code) {
  return {
    schema: "buildchain.release-diagnostics/v1",
    intent: session.intent.id,
    attempt: session.attempt,
    node,
    code: String(code || "execution-failed")
      .replace(/[^a-zA-Z0-9._-]/gu, "-")
      .slice(0, 160),
    events: state.records
      .filter((record) => record.attempt === session.attempt)
      .map(({ id, node, kind, status, sequence, writer }) => ({
        id,
        node,
        kind,
        status,
        sequence,
        writer,
      })),
  };
}

export function diagnosticLog(report) {
  return Buffer.from(
    [
      `Release intent ${report.intent}`,
      `Attempt ${report.attempt}: ${report.node} ${report.code}`,
      ...report.events.map(
        (event) =>
          `${event.node} ${event.kind} ${event.sequence} ${event.status} writer=${event.writer} record=${event.id}`,
      ),
      "",
    ].join("\n"),
  );
}
