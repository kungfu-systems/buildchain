export function dependencyCycles(layers) {
  const graph = new Map(
    layers.map((layer) => [layer.id, new Set(layer.mayDependOn || [])]),
  );
  const cycles = [];
  const complete = new Set();
  const active = new Set();
  const stack = [];
  const visit = (id) => {
    if (active.has(id)) {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    if (complete.has(id)) return;
    active.add(id);
    stack.push(id);
    for (const target of graph.get(id) || []) visit(target);
    stack.pop();
    active.delete(id);
    complete.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return cycles;
}
