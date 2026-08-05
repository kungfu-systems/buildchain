import fs from "node:fs";
import path from "node:path";

function boundedText(value, maximum, label, requireValue) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= maximum, `${label} is invalid`);
}

export function validateDemoPresentation({ presentation, demos, publication, exactKeys, inside, requireValue, safeMarker }) {
  exactKeys(presentation, ["schema", "proofs", "materialization"], [], "scenario.presentation");
  requireValue(presentation.schema === "buildchain.declarative-demo-presentation/v1", "scenario presentation schema is unsupported");
  requireValue(Array.isArray(presentation.proofs) && presentation.proofs.length === demos.length, "scenario presentation must bind every demo exactly once");
  const labels = new Set();
  for (const [index, proof] of presentation.proofs.entries()) {
    const label = `scenario.presentation.proofs[${index}]`;
    exactKeys(proof, ["demoId", "label", "question", "summary"], ["transitionAfter"], label);
    requireValue(proof.demoId === demos[index].id, `${label}.demoId must preserve demo order`);
    boundedText(proof.label, 80, `${label}.label`, requireValue);
    requireValue(!labels.has(proof.label), `${label}.label is repeated`);
    labels.add(proof.label);
    boundedText(proof.question, 120, `${label}.question`, requireValue);
    requireValue(proof.question === demos[index].title, `${label}.question must equal the demo title used by capture and media`);
    boundedText(proof.summary, 500, `${label}.summary`, requireValue);
    if (proof.transitionAfter !== undefined) boundedText(proof.transitionAfter, 500, `${label}.transitionAfter`, requireValue);
  }
  const materialization = presentation.materialization;
  exactKeys(materialization, ["readmeMode", "technicalSpecPath", "technicalSpecTitle", "technicalMarker"], [], "scenario.presentation.materialization");
  requireValue(["full", "media-only"].includes(materialization.readmeMode), "scenario presentation readmeMode is invalid");
  const technicalSpecPath = inside("/repository", materialization.technicalSpecPath, "scenario presentation technicalSpecPath");
  const readmePath = inside("/repository", publication.readmePath, "scenario publication readmePath");
  requireValue(technicalSpecPath !== readmePath, "scenario presentation technical spec must be separate from the README");
  boundedText(materialization.technicalSpecTitle, 120, "scenario.presentation.materialization.technicalSpecTitle", requireValue);
  requireValue(safeMarker.test(materialization.technicalMarker), "scenario presentation technicalMarker is invalid");
}

function ensureOrderedMarkers(document, presentation, requireValue) {
  let result = document;
  for (const proof of presentation.proofs) {
    const marker = `${presentation.materialization.technicalMarker}:${proof.demoId}`;
    const start = `<!-- ${marker}:start -->`;
    const end = `<!-- ${marker}:end -->`;
    const first = result.indexOf(start);
    const last = result.indexOf(end);
    requireValue((first === -1) === (last === -1), "technical specification materialization markers are incomplete");
    if (first !== -1) {
      requireValue(result.indexOf(start, first + start.length) === -1 && result.indexOf(end, last + end.length) === -1 && last > first, "technical specification materialization markers are ambiguous");
    } else {
      result = `${result.trimEnd()}\n\n${start}\n${end}\n`;
    }
  }
  return result;
}

export function materializeDemoPresentation({ repository, scenario, demo, evidenceDirectory, imageLine, commandLines, inside, regular, replaceBlock, requireValue }) {
  const presentation = scenario.presentation;
  const proof = presentation.proofs.find((entry) => entry.demoId === demo.id);
  const technical = presentation.materialization;
  const technicalSpecPath = inside(repository, technical.technicalSpecPath, "technical specification path");
  const technicalRelative = path.relative(path.dirname(technicalSpecPath), evidenceDirectory).split(path.sep).join("/");
  const technicalMarker = `${technical.technicalMarker}:${demo.id}`;
  const technicalBlock = [
    `<!-- ${technicalMarker}:start -->`, `## ${proof.label}: ${proof.question}`, "", proof.summary, "",
    `[![${proof.question}](${technicalRelative}/demo.gif)](${technicalRelative}/public-evidence.json)`, "", "Commands:", "", "```text", commandLines, "```", "",
    `Native renditions: [1080p MP4](${technicalRelative}/demo.mp4) · [1080p WebM](${technicalRelative}/demo.webm) · [720p MP4](${technicalRelative}/demo-720p.mp4) · [720p WebM](${technicalRelative}/demo-720p.webm)`, "",
    `Claim boundary: ${demo.claimBoundary}`, "", `[Release Passport](${technicalRelative}/release-passport.json) · [auditable evidence](${technicalRelative}/public-evidence.json)`,
    ...(proof.transitionAfter ? ["", proof.transitionAfter] : []), `<!-- ${technicalMarker}:end -->`,
  ].join("\n");
  fs.mkdirSync(path.dirname(technicalSpecPath), { recursive: true });
  const existing = fs.existsSync(technicalSpecPath)
    ? regular(technicalSpecPath, "technical specification", 4 * 1024 * 1024).toString("utf8")
    : `# ${technical.technicalSpecTitle}\n`;
  const document = ensureOrderedMarkers(existing, presentation, requireValue);
  fs.writeFileSync(technicalSpecPath, replaceBlock(document, technicalMarker, technicalBlock));

  if (technical.readmeMode === "media-only") {
    return { blockLines: [imageLine], technicalSpecPath: technical.technicalSpecPath };
  }
  const readmePath = inside(repository, scenario.publication.readmePath, "README path");
  const technicalLink = path.relative(path.dirname(readmePath), technicalSpecPath).split(path.sep).join("/");
  return {
    blockLines: [`## ${proof.question}`, "", proof.summary, "", imageLine, "", `[Technical specification and evidence](${technicalLink})`, ...(proof.transitionAfter ? ["", proof.transitionAfter] : [])],
    technicalSpecPath: technical.technicalSpecPath,
  };
}
