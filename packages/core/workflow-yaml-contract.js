function indentation(line) {
  return line.match(/^(\s*)/)?.[1].length || 0;
}

function stripComment(value) {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (
      char === "#" &&
      !quote &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(value) {
  const trimmed = stripComment(String(value || "").trim());
  if (
    trimmed.length >= 2 &&
    trimmed[0] === trimmed.at(-1) &&
    ['"', "'"].includes(trimmed[0])
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function blockValue(lines, entry) {
  if (!/^[>|][+-]?$/.test(entry.value)) return entry.value;
  const values = [];
  for (let index = entry.line + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentation(line) <= entry.indent) break;
    values.push(line);
  }
  const content = values.filter((line) => line.trim());
  const contentIndent = content.length
    ? Math.min(...content.map(indentation))
    : entry.indent + 2;
  return values
    .map((line) => line.slice(Math.min(contentIndent, line.length)))
    .join("\n")
    .trimEnd();
}

function directEntries(lines, parentLine) {
  const parentIndent = indentation(lines[parentLine]);
  let childIndent = null;
  for (let index = parentLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = indentation(line);
    if (indent <= parentIndent) break;
    childIndent = childIndent === null ? indent : Math.min(childIndent, indent);
  }
  if (childIndent === null) return [];
  const entries = [];
  for (let index = parentLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const indent = indentation(line);
    if (trimmed && indent <= parentIndent) break;
    if (!trimmed || trimmed.startsWith("#") || indent !== childIndent)
      continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (match) {
      entries.push({
        key: match[1],
        value: stripComment(match[2] || ""),
        line: index,
        indent,
      });
    }
  }
  return entries;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function topLevelEntry(lines, key) {
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(?:\\s*(.*))?$`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (match)
      return {
        key,
        value: stripComment(match[1] || ""),
        line: index,
        indent: 0,
      };
  }
  return null;
}

function childEntry(lines, parent, key) {
  return (
    directEntries(lines, parent.line).find((entry) => entry.key === key) || null
  );
}

function scalar(value) {
  const raw = stripComment(String(value || "").trim());
  if (raw.length >= 2 && raw[0] === raw.at(-1) && ['"', "'"].includes(raw[0])) {
    return { kind: "string", value: raw.slice(1, -1) };
  }
  const text = unquote(raw);
  if (/^\$\{\{[\s\S]*\}\}$/.test(text))
    return { kind: "expression", value: text };
  if (/^(true|false)$/i.test(text))
    return { kind: "boolean", value: text.toLowerCase() === "true" };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text))
    return { kind: "number", value: Number(text) };
  if (/^(null|~)$/i.test(text)) return { kind: "null", value: null };
  return { kind: "string", value: text };
}

function parsePermissions(lines, entry) {
  if (!entry) return {};
  if (entry.value) return { "*": unquote(entry.value) };
  return Object.fromEntries(
    directEntries(lines, entry.line).map((item) => [
      item.key,
      unquote(item.value),
    ]),
  );
}

function parseTriggers(lines) {
  const on = topLevelEntry(lines, "on");
  if (!on) return [];
  if (on.value) {
    const inline = unquote(on.value);
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline
        .slice(1, -1)
        .split(",")
        .map((value) => unquote(value.trim()))
        .filter(Boolean)
        .sort();
    }
    return inline ? [inline] : [];
  }
  const events = [];
  for (const event of directEntries(lines, on.line)) {
    const types = childEntry(lines, event, "types");
    const rawTypes = types ? unquote(types.value) : "";
    if (rawTypes.startsWith("[") && rawTypes.endsWith("]")) {
      for (const type of rawTypes
        .slice(1, -1)
        .split(",")
        .map((value) => unquote(value.trim()))
        .filter(Boolean)) {
        events.push(`${event.key}:${type}`);
      }
    } else {
      events.push(event.key);
    }
  }
  return [...new Set(events)].sort();
}

function definition(lines, entry) {
  const properties = Object.fromEntries(
    directEntries(lines, entry.line).map((item) => [
      item.key,
      blockValue(lines, item),
    ]),
  );
  return {
    name: entry.key,
    type: unquote(properties.type || "string"),
    required: scalar(properties.required || "false").value === true,
    default:
      properties.default === undefined ? null : scalar(properties.default),
  };
}

export function parseReusableWorkflowInterface(text) {
  const lines = String(text || "").split(/\r?\n/);
  const on = topLevelEntry(lines, "on");
  const workflowCall = on && childEntry(lines, on, "workflow_call");
  if (!workflowCall) {
    return {
      reusable: false,
      inputs: [],
      secrets: [],
      outputs: [],
      permissions: parsePermissions(lines, topLevelEntry(lines, "permissions")),
    };
  }
  const inputs = childEntry(lines, workflowCall, "inputs");
  const secrets = childEntry(lines, workflowCall, "secrets");
  const outputs = childEntry(lines, workflowCall, "outputs");
  return {
    reusable: true,
    inputs: inputs
      ? directEntries(lines, inputs.line)
          .map((entry) => definition(lines, entry))
          .sort((a, b) => compareCodeUnits(a.name, b.name))
      : [],
    secrets: secrets
      ? directEntries(lines, secrets.line)
          .map((entry) => definition(lines, entry))
          .sort((a, b) => compareCodeUnits(a.name, b.name))
      : [],
    outputs: outputs
      ? directEntries(lines, outputs.line)
          .map((entry) => entry.key)
          .sort()
      : [],
    permissions: parsePermissions(lines, topLevelEntry(lines, "permissions")),
  };
}

function parseJobMap(lines, entry) {
  if (!entry) return {};
  return Object.fromEntries(
    directEntries(lines, entry.line).map((item) => [
      item.key,
      scalar(blockValue(lines, item)),
    ]),
  );
}

export function parseWorkflowCallJobs(text) {
  const lines = String(text || "").split(/\r?\n/);
  const jobs = topLevelEntry(lines, "jobs");
  if (!jobs) return [];
  const topPermissions = parsePermissions(
    lines,
    topLevelEntry(lines, "permissions"),
  );
  return directEntries(lines, jobs.line)
    .map((job) => {
      const properties = directEntries(lines, job.line);
      const property = (name) =>
        properties.find((entry) => entry.key === name) || null;
      const secrets = property("secrets");
      return {
        id: job.key,
        uses: unquote(property("uses")?.value || ""),
        with: parseJobMap(lines, property("with")),
        secrets:
          secrets?.value === "inherit"
            ? "inherit"
            : parseJobMap(lines, secrets),
        permissions: property("permissions")
          ? parsePermissions(lines, property("permissions"))
          : topPermissions,
      };
    })
    .filter((job) => job.uses);
}

export function parseWorkflowDocument(text) {
  return {
    triggers: parseTriggers(String(text || "").split(/\r?\n/)),
    interface: parseReusableWorkflowInterface(text),
    callJobs: parseWorkflowCallJobs(text),
  };
}
