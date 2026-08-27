import { parseWorkflowDocument } from "../packages/core/workflow-yaml-contract.js";

function lineCount(source) {
  const text = String(source || "");
  if (!text) return 0;
  const lines = text.split(/\r?\n/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function rustTokens(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  const advance = () => {
    if (source[index] === "\n") line += 1;
    index += 1;
  };
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      advance();
      continue;
    }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      advance();
      advance();
      while (index < source.length && depth > 0) {
        if (source.startsWith("/*", index)) {
          depth += 1;
          advance();
          advance();
        } else if (source.startsWith("*/", index)) {
          depth -= 1;
          advance();
          advance();
        } else {
          advance();
        }
      }
      continue;
    }
    const raw = source.slice(index).match(/^(?:br|r)(#+)?"/u);
    if (raw) {
      const suffix = `"${raw[1] || ""}`;
      for (let count = 0; count < raw[0].length; count += 1) advance();
      while (index < source.length && !source.startsWith(suffix, index)) {
        advance();
      }
      for (let count = 0; count < suffix.length; count += 1) advance();
      continue;
    }
    if (source[index] === '"' || source.startsWith('b"', index)) {
      if (source[index] === "b") advance();
      advance();
      while (index < source.length) {
        if (source[index] === "\\") {
          advance();
          if (index < source.length) advance();
        } else if (source[index] === '"') {
          advance();
          break;
        } else {
          advance();
        }
      }
      continue;
    }
    const character = source.slice(index).match(/^'(?:\\.|[^'\\\n])'/u);
    if (character) {
      for (let count = 0; count < character[0].length; count += 1) advance();
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (identifier) {
      tokens.push({ value: identifier[0], line });
      index += identifier[0].length;
      continue;
    }
    const operator = [
      "=>",
      "&&",
      "||",
      "::",
      "->",
      "<=",
      ">=",
      "==",
      "!=",
    ].find((candidate) => source.startsWith(candidate, index));
    tokens.push({ value: operator || source[index], line });
    index += (operator || source[index]).length;
  }
  return tokens;
}

function rustFunctions(tokens) {
  const functions = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "fn") continue;
    const name =
      tokens[index + 1]?.value || `<anonymous@${tokens[index].line}>`;
    let body = index + 2;
    while (body < tokens.length && !["{", ";"].includes(tokens[body].value)) {
      body += 1;
    }
    if (tokens[body]?.value !== "{") continue;
    let depth = 1;
    let end = body + 1;
    while (end < tokens.length && depth > 0) {
      if (tokens[end].value === "{") depth += 1;
      if (tokens[end].value === "}") depth -= 1;
      end += 1;
    }
    if (depth !== 0) continue;
    functions.push({ name, token: index, body, end: end - 1 });
  }
  return functions;
}

function isRustDecision(tokens, index) {
  const value = tokens[index].value;
  if (["if", "for", "while", "loop", "?", "=>"].includes(value)) return true;
  if (!["&&", "||"].includes(value)) return false;
  return !["=", "(", "{", "[", ",", ";", "return", "move"].includes(
    tokens[index - 1]?.value,
  );
}

function analyzeRust(_file, source) {
  const tokens = rustTokens(source);
  const parsed = rustFunctions(tokens);
  const byStart = new Map(parsed.map((entry) => [entry.token, entry]));
  const functions = parsed.map((entry) => {
    let complexity = 1;
    for (let index = entry.body + 1; index < entry.end; index += 1) {
      const nested = byStart.get(index);
      if (nested && nested.end <= entry.end) {
        index = nested.end;
        continue;
      }
      if (isRustDecision(tokens, index)) complexity += 1;
    }
    const start = tokens[entry.token].line;
    const end = tokens[entry.end].line;
    return {
      name: entry.name,
      start,
      end,
      lines: end - start + 1,
      complexity,
    };
  });
  return {
    lines: lineCount(source),
    complexity: functions.reduce((total, entry) => total + entry.complexity, 0),
    functions,
  };
}

function semanticYamlLines(source) {
  const result = [];
  let blockIndent = null;
  for (const [line, raw] of String(source || "")
    .split(/\r?\n/u)
    .entries()) {
    const indent = raw.match(/^(\s*)/u)?.[1].length || 0;
    if (blockIndent !== null) {
      if (!raw.trim() || indent > blockIndent) continue;
      blockIndent = null;
    }
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    result.push({ line: line + 1, indent, text });
    if (/:\s*[>|][+-]?\s*(?:#.*)?$/u.test(raw)) blockIndent = indent;
  }
  return result;
}

function analyzeWorkflow(_file, source) {
  const lines = semanticYamlLines(source);
  const document = parseWorkflowDocument(source);
  const jobsEntry = lines.find(
    (entry) => entry.indent === 0 && entry.text === "jobs:",
  );
  const jobs = [];
  if (jobsEntry) {
    const candidates = lines.filter(
      (entry) => entry.line > jobsEntry.line && entry.indent > jobsEntry.indent,
    );
    const jobIndent = Math.min(...candidates.map((entry) => entry.indent));
    for (const entry of candidates) {
      if (
        entry.indent === jobIndent &&
        /^[A-Za-z0-9_.-]+:\s*(?:#.*)?$/u.test(entry.text)
      ) {
        jobs.push(entry);
      }
    }
  }
  const stepsByJob = jobs.map((job, jobIndex) => {
    const endLine = jobs[jobIndex + 1]?.line || Number.POSITIVE_INFINITY;
    const stepRoot = lines.find(
      (entry) =>
        entry.line > job.line &&
        entry.line < endLine &&
        entry.indent > job.indent &&
        entry.text === "steps:",
    );
    if (!stepRoot) return 0;
    const stepLines = lines.filter(
      (entry) =>
        entry.line > stepRoot.line &&
        entry.line < endLine &&
        entry.indent > stepRoot.indent,
    );
    const stepIndent = Math.min(...stepLines.map((entry) => entry.indent));
    return stepLines.filter(
      (entry) => entry.indent === stepIndent && entry.text.startsWith("- "),
    ).length;
  });
  const decisions = lines.filter((entry) =>
    /^(?:-\s+)?(?:if|matrix):/u.test(entry.text),
  ).length;
  return {
    lines: lineCount(source),
    jobs: document.jobs.length,
    steps: stepsByJob.reduce((total, count) => total + count, 0),
    maxStepsPerJob: Math.max(0, ...stepsByJob),
    decisions,
  };
}

export { analyzeRust, analyzeWorkflow };
