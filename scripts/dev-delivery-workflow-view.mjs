import fs from "node:fs";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
const actionPrefix =
  "./.buildchain/workflow-shell/actions/dev-delivery/";
export function workflowJobs(text) {
  const start = text.indexOf("\njobs:\n");
  if (start < 0) throw new Error("Workflow jobs are missing");
  return [
    ...text
      .slice(start + 7)
      .matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm),
  ].map((m) => ({ id: m[1], text: m[0] }));
}

export function nodeCalls(job) {
  return job.text
    .split(/(?=^      - )/m)
    .slice(1)
    .map((text) => {
      const uses = text.match(/^        uses: (.+)$/m)?.[1];
      if (!uses?.startsWith(actionPrefix)) return null;
      const id = text.match(/^        id: (.+)$/m)?.[1];
      const inputs = Object.fromEntries(
        [...text.matchAll(/^          ([\w-]+): (.+)$/gm)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      return { id, node: uses.slice(actionPrefix.length), inputs, text };
    })
    .filter(Boolean);
}

export function actionText(node, root = repositoryRoot) {
  if (!/^[a-z]+$/.test(node)) throw new Error("Invalid delivery node");
  return fs.readFileSync(
    path.join(root, `actions/dev-delivery/${node}/action.yml`),
    "utf8",
  );
}
