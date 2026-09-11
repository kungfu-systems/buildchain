import fs from "node:fs";
import path from "node:path";

// Domain functions own control flow. The journal records observations before and
// after each effect so finalizers can distinguish failure from a skipped stage.
export function transactionJournal(file, stageIds) {
  const stages = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(stages, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);
  };
  const assertStage = (id) => {
    if (!stageIds.includes(id))
      throw new Error(`Undeclared transaction stage: ${id}`);
  };
  return {
    stages,
    async observe(id, effect) {
      assertStage(id);
      stages[id] = { status: "running" };
      persist();
      try {
        const result = await effect();
        stages[id] = { status: "success" };
        persist();
        return result;
      } catch (error) {
        stages[id] = {
          status: "failure",
          exitCode: Number.isInteger(error.status) ? error.status : 1,
        };
        persist();
        throw error;
      }
    },
  };
}
