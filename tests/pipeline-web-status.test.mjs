import { businessAttempt } from "../packages/core/workflow/attempt/identity.js";
import { attemptRecord } from "../packages/core/workflow/attempt/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { identities } from "./helpers/business-attempt.mjs";
import { readBusinessAttempt } from "../packages/core/workflow/attempt/reader.js";
import {
  pipelineWebStatus,
  projectPipelineStatus,
} from "../packages/core/workflow/pipeline/web-status.js";

function published() {
  const f = identities([
    "admission",
    "publish",
    "distribution",
    "next-development",
  ]);
  const records = [f.event()];
  for (const phase of ["admission", "publish"])
    records.push(f.event(records.at(-1), { phase, state: "success" }));
  records.push(
    f.event(records.at(-1), {
      phase: "distribution",
      state: "failure",
      reason: "<provider> | unavailable",
    }),
  );
  return readBusinessAttempt({ intent: f.intent, records });
}

test("web status preserves publication success and links the exact remaining attempt and provider runs", () => {
  const observed = published();
  const output = pipelineWebStatus(
    observed,
    "https://github.com/example/consumer/discussions/1",
  );
  assert.match(
    output,
    /Publication succeeded.*whole attempt is incomplete: Distribution, Next development version/,
  );
  assert.ok(output.includes(observed.attempt));
  assert.ok(
    output.includes(
      "| Step | State |\n| --- | --- |\n| Source admission | success |",
    ),
  );
  assert.match(output, /actions\/workflows\/buildchain-recover.yml/);
  assert.match(output, /actions\/runs\/100\/attempts\/1/);
  assert.match(output, /does not undo completed publication/);
  assert.doesNotMatch(output, /<provider>/);
  assert.throws(
    () =>
      pipelineWebStatus(
        observed,
        "https://github.com/other/repo/discussions/1",
      ),
    /another provider/,
  );
});

test("an unavailable Discussion cannot hide the authoritative attempt status from the workflow summary", async () => {
  const observed = published();
  let output = "",
    warned = false;
  const core = {
    warning: () => {
      warned = true;
    },
    summary: {
      addRaw: (value) => {
        output = value;
        return { write: async () => {} };
      },
    },
  };
  const result = await projectPipelineStatus(
    { journal: { read: async () => observed } },
    {
      core,
      project: async () => {
        throw new Error("provider unavailable");
      },
    },
  );
  assert.equal(warned, true);
  assert.equal(result.journalHead, observed.head);
  assert.ok(output.includes(observed.attempt));
  assert.match(output, /incomplete/);
});

test("a new recovery shows the immutable predecessor publication while its own qualification remains pending", () => {
  const previous = published(),
    old = previous.history.at(-1);
  const identity = businessAttempt({
    intent: previous.intent,
    generation: old.generation,
    predecessor: previous.attempt,
    requestKey: "recover:fixture",
  });
  const root = attemptRecord({
    intent: previous.intent,
    attempt: identity,
    generation: old.generation,
    runtime: old.events[0].runtime,
    writer: { ...old.events[0].payload.writer, runId: "200" },
    eventKey: "recovery",
    phase: "attempt",
    state: "running",
  });
  const observed = readBusinessAttempt({
    intent: previous.intent,
    records: [...previous.history.flatMap((item) => item.events), root],
  });
  const output = pipelineWebStatus(observed);
  assert.ok(output.includes(`Attempt: \`${identity.id}\``));
  assert.ok(
    output.includes(
      `Publication succeeded in predecessor \`${previous.attempt}\``,
    ),
  );
  assert.match(output, /Product publication \| pending/);
  assert.match(output, /does not undo completed publication/);
});
