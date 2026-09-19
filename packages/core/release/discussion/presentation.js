import { isAttemptRoot } from "./threads.js";

const text = (value) =>
  String(value ?? "")
    .replace(
      /[&<>\[\]`*_\\|]/gu,
      (character) => `&#${character.charCodeAt(0)};`,
    )
    .replace(/[\r\n]/gu, " ");
const code = (value) => `\`${String(value).replace(/[`\r\n]/gu, " ")}\``;

function runLink(repository, writer) {
  const match = /^(\d+):(\d+)(?::.*)?$/u.exec(writer);
  return match
    ? `[${text(writer)}](https://github.com/${repository}/actions/runs/${match[1]}/attempts/${match[2]})`
    : code(writer);
}

function runtimeLink(runtime) {
  return `[${runtime.repository}@${runtime.sha.slice(0, 12)}](https://github.com/${runtime.repository}/commit/${runtime.sha})`;
}

export function renderIntent(intent) {
  return [
    `## ${intent.source?.qualification ? "Qualification" : "Release"}: ${text(intent.key)}`,
    `Repository: ${code(intent.repository)}`,
    "Each top-level transaction comment owns one attempt. Its replies contain node results, recovery checkpoints and downloadable evidence. Recovery attempts link to their predecessors.",
    `Expected nodes: ${intent.expectedNodes.map(code).join(" → ")}`,
    `Intent: ${code(intent.id)}`,
  ].join("\n\n");
}

function attachmentRows(record, repository) {
  return (record.payload?.attachments || []).map((attachment) => {
    const url = new URL(attachment.downloadUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      !url.pathname.startsWith(`/${repository}/releases/download/`) ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Attachment download must belong to the consumer repository",
      );
    return `| [${text(attachment.name)}](${url.href}) | ${text(attachment.mediaType)} | ${attachment.size} | ${code(attachment.digest)} |`;
  });
}

export function renderEvent(record, intent, state) {
  if (isAttemptRoot(record)) {
    const predecessor = state.roots.get(record.predecessor);
    return [
      `## Attempt ${text(record.attempt)}`,
      `Execution: ${runLink(intent.repository, record.writer)}  \nRuntime: ${runtimeLink(record.runtime)}`,
      record.predecessor
        ? `Resumes: ${predecessor?.url ? `[${text(record.predecessor)}](${predecessor.url})` : code(record.predecessor)}`
        : "Initial execution of this release intent.",
      `Nodes: ${intent.expectedNodes.map(code).join(" → ")}`,
      "Results and evidence are appended below. This root preserves the original execution context.",
    ].join("\n\n");
  }
  const label =
    record.kind === "checkpoint"
      ? `checkpoint ${record.sequence}`
      : record.status;
  const lines = [
    `### ${text(record.node)} · ${label}`,
    `Attempt: ${code(record.attempt)} · Writer: ${runLink(intent.repository, record.writer)}`,
    `Runtime: ${runtimeLink(record.runtime)}`,
  ];
  if (record.payload?.label) lines.push(text(record.payload.label));
  if (record.payload?.code)
    lines.push(`Failure code: ${code(record.payload.code)}`);
  const attachments = attachmentRows(record, intent.repository);
  if (attachments.length)
    lines.push(
      "| Attachment | Type | Bytes | SHA-256 |\n| --- | --- | ---: | --- |\n" +
        attachments.join("\n"),
      "Retained files use the transaction material archive. Access requires repository permission to read draft release assets.",
    );
  const { attachments: _attachments, ...details } = record.payload || {};
  if (Object.keys(details).length) {
    const json = JSON.stringify(details, null, 2);
    // HTML escaping keeps payload strings from closing the presentation container.
    lines.push(
      `<details><summary>Record details</summary><pre>${json.slice(0, 6000).replace(/[&<>]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}${json.length > 6000 ? "\n… See the retained JSON attachment for the complete material." : ""}</pre></details>`,
    );
  }
  lines.push(`Record: ${code(record.id)}`);
  return lines.join("\n\n");
}
