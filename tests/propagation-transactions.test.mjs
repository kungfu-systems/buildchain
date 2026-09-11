import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planReleasePropagation,
  createReleasePropagationWork,
} from "../packages/core/release/release-propagation.js";
import { propagationWorkContext } from "./helpers/propagation-work.mjs";
import {
  readPropagation,
  writePropagation,
} from "../packages/core/release/propagation/store.js";
import {
  materializePropagation,
  reconcilePropagation,
  propagationJournal,
} from "../packages/core/release/propagation/transactions.js";
import { transactionJournal } from "../packages/core/observability/transaction-journal.js";

async function workspace(run, { captureOnly = false } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "propagation-transaction-"),
  );
  try {
    const fixture = (name) =>
      JSON.parse(
        fs.readFileSync(
          new URL(
            `../fixtures/release-propagation-shaped/${name}`,
            import.meta.url,
          ),
        ),
      );
    const plan = planReleasePropagation({
      graph: fixture("graph.json"),
      upstreamRelease: fixture("upstream-alpha.json"),
    });
    const target = plan.targets[0];
    const context = {
      workspace: root,
      request: {
        "downstream-target": target.target,
        "downstream-repository": target.repository,
        "dry-run": true,
        "refresh-managed-readme-badges": true,
        "downstream-update-command": "update",
        "downstream-prepare-command": "prepare",
        "downstream-verify-command": "verify",
      },
    };
    writePropagation(
      "work.json",
      createReleasePropagationWork({
        plan,
        target: target.target,
        expectedDownstreamBaseSha: "a".repeat(40),
        ...(captureOnly ? {} : { workContext: propagationWorkContext() }),
      }),
      context,
    );
    writePropagation(
      "target.json",
      {
        lock_path: target.lockPath,
        branch: target.branch,
        propagation_key: target.propagationKey,
      },
      context,
    );
    await run(context);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("materialization observes the ordered transaction and records success only after consumer verification", async () =>
  workspace(async (context) => {
    const calls = [],
      ports = {
        lock: () => {
          calls.push("lock");
          return { lock_sha: "a".repeat(64) };
        },
        consume: (_, script) => calls.push(script),
        badges: () => calls.push("badges"),
        record: () => calls.push("record"),
        summary: () => calls.push("summary"),
      };
    await materializePropagation(context, ports);
    assert.deepEqual(calls, [
      "lock",
      "update",
      "prepare",
      "badges",
      "verify",
      "record",
      "summary",
    ]);
    assert.equal(
      readPropagation("execution.json", context)["record-materialization"]
        .status,
      "success",
    );
  }));
test("consumer failure keeps the original exit code and never verifies, records, or summarizes success", async () =>
  workspace(async (context) => {
    const calls = [];
    await assert.rejects(
      materializePropagation(context, {
        lock: () => ({ lock_sha: "a".repeat(64) }),
        consume: (_, script) => {
          calls.push(script);
          if (script === "prepare")
            throw Object.assign(new Error("consumer failure"), { status: 37 });
        },
        badges: () => calls.push("badges"),
        record: () => calls.push("record"),
        summary: () => calls.push("summary"),
      }),
      (error) => error.status === 37,
    );
    assert.deepEqual(calls, ["update", "prepare"]);
    const journal = readPropagation("execution.json", context);
    assert.deepEqual(journal.prepare, { status: "failure", exitCode: 37 });
    assert.equal(journal["record-materialization"], undefined);
  }));
test("capture-only Work cannot invoke a materialization effect even if request commands are present", async () =>
  workspace(
    async (context) => {
      const before = fs.readFileSync(
        path.join(
          context.workspace,
          ".buildchain/release-propagation/work.json",
        ),
      );
      assert.deepEqual(
        await materializePropagation(context, {
          lock: () => {
            throw new Error("unauthorized effect");
          },
        }),
        { execute: false },
      );
      assert.deepEqual(
        fs.readFileSync(
          path.join(
            context.workspace,
            ".buildchain/release-propagation/work.json",
          ),
        ),
        before,
      );
    },
    { captureOnly: true },
  ));
test("failed predecessor still exposes captured Work, but cannot prepare a PR or receipt", async () =>
  workspace(async (context) => {
    await propagationJournal(context).observe("emit-work", () => {});
    const calls = [],
      emitted = [];
    await assert.rejects(
      reconcilePropagation(context, false, (value) => emitted.push(value), {
        outcome: () => calls.push("outcome"),
        receipt: () => calls.push("receipt"),
        expose: () => {
          calls.push("expose");
          return { "work-root": "exact" };
        },
      }),
      /predecessors/,
    );
    assert.deepEqual(calls, ["expose"]);
    assert.deepEqual(emitted, [{ "work-root": "exact" }]);
  }));
test("dry-run delivery emits receipt and Work without opening a PR or claiming delivery", async () =>
  workspace(async (context) => {
    await propagationJournal(context).observe("emit-work", () => {});
    const calls = [];
    await reconcilePropagation(context, true, () => {}, {
      outcome: () => calls.push("outcome"),
      open: () => calls.push("open"),
      receipt: () => {
        calls.push("receipt");
        return {};
      },
      record: () => calls.push("record"),
      expose: () => {
        calls.push("expose");
        return {};
      },
    });
    assert.deepEqual(calls, ["outcome", "receipt", "expose"]);
  }));
test("journal leaves an observable running stage before the effect and rejects undeclared stages", async () =>
  workspace(async (context) => {
    const file = path.join(context.workspace, "journal.json");
    const journal = transactionJournal(file, ["effect"]);
    await journal.observe("effect", () =>
      assert.equal(JSON.parse(fs.readFileSync(file)).effect.status, "running"),
    );
    await assert.rejects(
      journal.observe("undeclared", () => {}),
      /Undeclared/,
    );
  }));
