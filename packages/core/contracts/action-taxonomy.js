const segment = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function inspectActionTaxonomy(actions, taxonomy) {
  const issues = [];
  if (taxonomy?.schema !== "buildchain.action-taxonomy/v1")
    return ["unsupported action taxonomy schema"];
  const declared = new Set();
  for (const [capability, domain] of Object.entries(taxonomy.domains || {})) {
    if (!segment.test(capability))
      issues.push(`invalid action capability: ${capability}`);
    if (!Object.keys(domain.groups || {}).length)
      issues.push(
        `action capability has no responsibility groups: ${capability}`,
      );
    for (const [group, spec] of Object.entries(domain.groups || {})) {
      const owner = `${capability}/${group}`;
      if (!segment.test(group))
        issues.push(`invalid action responsibility group: ${owner}`);
      if (
        typeof spec.responsibility !== "string" ||
        spec.responsibility.trim().length < 20
      )
        issues.push(`${owner}: a concrete responsibility is required`);
      if (!Array.isArray(spec.operations) || !spec.operations.length) {
        issues.push(`${owner}: responsibility group has no operations`);
        continue;
      }
      for (const operation of spec.operations) {
        const directory = `actions/${owner}/${operation}`;
        if (!segment.test(operation))
          issues.push(`${owner}: invalid operation ${operation}`);
        if (declared.has(directory))
          issues.push(`duplicate action operation: ${directory}`);
        declared.add(directory);
      }
    }
  }
  const actual = new Set(actions.map((action) => action.directory));
  for (const directory of actual)
    if (!declared.has(directory))
      issues.push(`undeclared action responsibility: ${directory}`);
  for (const directory of declared)
    if (!actual.has(directory))
      issues.push(`declared action is missing: ${directory}`);
  return issues;
}
