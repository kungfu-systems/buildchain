import fs from "node:fs";
import path from "node:path";
import {
  createHousekeeperWorkflowPlan,
  applyHousekeeperWorkflowScope,
} from "./transactions.js";
import { renderHousekeeperWorkflowReport } from "./report.js";

export async function runHousekeepingTransaction(
  { options, scope, planPath },
  client,
) {
  if (!["plan", "branches", "pull-requests"].includes(scope))
    throw new Error(
      "Housekeeper scope must be plan, branches or pull-requests",
    );
  const planning = scope === "plan";
  const result = planning
    ? await createHousekeeperWorkflowPlan(options, client)
    : await applyHousekeeperWorkflowScope({
        options,
        scope,
        client,
        plan: JSON.parse(fs.readFileSync(planPath, "utf8")),
      });
  const directory = result.options.outputDirectory;
  const reportPath = path.join(
    directory,
    planning ? "report.md" : `${scope}-report.md`,
  );
  const receiptPath = path.join(
    directory,
    planning ? "report-receipt.json" : `${scope}-receipt.json`,
  );
  const report = renderHousekeeperWorkflowReport(result.plan, result.receipt, {
    mode: result.options.mode,
    ...(planning ? {} : { scope }),
  });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(result.receipt, null, 2) + "\n");
  fs.writeFileSync(reportPath, report);
  let outputs;
  if (planning) {
    const destination = path.join(directory, "plan.json");
    fs.writeFileSync(destination, JSON.stringify(result.plan, null, 2) + "\n");
    outputs = {
      "plan-path": destination,
      "report-path": reportPath,
      "report-receipt-path": receiptPath,
      "plan-root": result.plan.planRoot,
      "report-receipt-root": result.receipt.receiptRoot,
      "action-count": result.plan.actions.length,
      "branch-action-count": result.plan.actions.filter(
        (action) => action.kind === "delete-branch",
      ).length,
      "pull-request-action-count": result.plan.actions.filter((action) =>
        action.kind.endsWith("-pull-request"),
      ).length,
      outcome:
        result.plan.actions.length === 0
          ? "no-actions"
          : `${result.options.mode}-ready`,
    };
  } else
    outputs = {
      "receipt-path": receiptPath,
      "report-path": reportPath,
      "receipt-root": result.receipt.receiptRoot,
      "outcome-count": result.receipt.outcomes.length,
      "selected-action-count": result.scopedPlan.actions.length,
      outcome:
        result.scopedPlan.actions.length === 0 ? "no-actions" : "applied",
    };
  return { ...result, report, outputs };
}
