import {
  inspectConsumerCommandClosure,
  inspectConsumerContract,
} from "../packages/core/consumer/contract/inspection.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectJavaScriptInvocations,
  inspectJavaScriptModuleClosure,
} from "../packages/core/consumer/contract/javascript.js";
import { standardConsumerExample } from "../packages/core/consumer/contract/examples.js";
const inspect = (source, options = {}) =>
  inspectJavaScriptInvocations({ source, file: "src/wrapper.mjs", ...options });
const processes = (report) =>
  report.edges.filter((edge) => ["process", "shell"].includes(edge.kind));

test("JavaScript invocation analysis follows aliases, literal construction and invoked local helpers", () => {
  const report =
    inspect(`import {execFileSync as launch} from 'node:child_process';
    const args = ['release','upload','v1','dist/product.zip'];
    function executable(){ return 'g' + 'h'; }
    function run(command, argv){ launch(command, argv, {cwd:'product'}); }
    run(executable(),args);`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(
    processes(report).map(({ executable, argv, cwd }) => ({
      executable,
      argv,
      cwd,
    })),
    [
      {
        executable: "gh",
        argv: ["release", "upload", "v1", "dist/product.zip"],
        cwd: "product",
      },
    ],
  );
});

test("rehearsal protocol data and uncalled implementation functions are not orchestration edges", () => {
  const report = inspect(`import cp from 'node:child_process';
    const fixture={candidateRoot:'sample',request:'request-json',generationRoot:'sample'};
    const example='npm publish';
    export function productImplementation(){cp.execSync('npm publish');}
    console.log(JSON.stringify(fixture),example);`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(processes(report), []);
  const called = inspect(
    `import cp from 'node:child_process';
    export function productImplementation(){cp.execSync('npm publish');}`,
    { calledExports: [{ name: "productImplementation", arguments: [] }] },
  );
  assert.equal(processes(called)[0].script, "npm publish");
});

test("CommonJS and computed process API names retain exact command edges", () => {
  const report = inspect(
    `const cp = require('node:' + ['child','process'].join('_'));
    const start=cp['spawn'+'Sync']; start('npm',['pu'+'blish']);`,
    { file: "wrapper.cjs" },
  );
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(processes(report)[0].executable, "npm");
  assert.deepEqual(processes(report)[0].argv, ["publish"]);
});

test("relative module imports and invoked exports remain explicit graph edges", () => {
  const report =
    inspect(`import build from './build.js'; import {verify as check} from './check.js';
    build('dist'); check();`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(
    report.edges
      .filter((edge) => edge.kind === "module-call")
      .map(({ specifier, exportName }) => ({ specifier, exportName })),
    [
      { specifier: "./build.js", exportName: "default" },
      { specifier: "./check.js", exportName: "verify" },
    ],
  );
});

for (const [name, source] of [
  [
    "environment-selected executable",
    `import cp from 'node:child_process'; cp.execSync(process.env.COMMAND);`,
  ],
  ["computed loader", `await import(process.env.MODULE);`],
  ["eval", `eval('process.exit(23)');`],
  ["Function constructor", `new Function('process.exit(23)')();`],
  [
    "shadowed require",
    `function run(require){require('node:child_process').execSync('npm publish');} run(undefined);`,
  ],
  [
    "mutated command",
    `import cp from 'node:child_process'; let cmd='echo'; {cmd=process.env.CMD;} cp.execSync(cmd);`,
  ],
  [
    "unknown branch",
    `import cp from 'node:child_process'; if(process.env.CI)cp.execSync('npm publish');`,
  ],
  [
    "getter",
    `import cp from 'node:child_process'; const object={get x(){cp.execSync('npm publish');}}; object.x;`,
  ],
  [
    "spread execution",
    `import cp from 'node:child_process'; const object={...{},x:cp.execSync('npm publish')};`,
  ],
  [
    "descriptor execution",
    `import cp from 'node:child_process'; const object={};Object.defineProperty(object,'x',{get:()=>cp.execSync('npm publish')});object.x;`,
  ],
  ["prototype constructor", `console.log.constructor('process.exit(23)')();`],
  ["unresolved callback target", `const run = globalThis.external; run();`],
])
  test(`unresolved executable JavaScript never passes analysis: ${name}`, () => {
    const report = inspect(source);
    assert.equal(report.ok, false, name);
    assert(report.problems.length > 0);
  });

test("child process callbacks are inspected without running the script", () => {
  const report = inspect(`import cp from 'node:child_process';
    cp.exec('echo done',()=>cp.execSync('npm publish'));`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(
    processes(report)
      .map((edge) => edge.script)
      .sort(),
    ["echo done", "npm publish"],
  );
});

test("constant false branches and source strings never execute during inspection", () => {
  const report = inspect(`import cp from 'node:child_process';
    if(false)cp.execSync('npm publish');const text='process.exit(23)';`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(processes(report), []);
});

for (const type of ["npm", "binary", "paper"])
  test(`standard ${type} product source has a resolvable local JavaScript graph`, () => {
    for (const [file, source] of Object.entries(standardConsumerExample(type)))
      if (file.endsWith(".mjs")) {
        const report = inspect(source, { file });
        assert.equal(
          report.ok,
          true,
          `${file}: ${JSON.stringify(report.problems)}`,
        );
        assert(
          processes(report).every((edge) =>
            ["cc", "tar"].includes(edge.executable),
          ),
        );
      }
  });

test("recursive helpers and exhausted analysis budgets are reported as unresolved", () => {
  assert.equal(inspect("function cycle(){cycle();}cycle();").ok, false);
  assert.equal(
    inspect("const a=1;const b=2;console.log(a,b);", { maxNodes: 2 }).ok,
    false,
  );
});

test("assignments in blocks and invoked closures update outer command bindings", () => {
  for (const update of [
    "{cmd += ' && npm publish';}",
    "function change(){cmd += ' && npm publish';}change();",
  ]) {
    const report = inspect(
      `import cp from 'node:child_process';let cmd='echo';${update}cp.execSync(cmd);`,
    );
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(processes(report)[0].script, "echo && npm publish");
  }
});

for (const [name, source] of [
  [
    "template coercion",
    "const x={toString(){cp.execSync('npm publish');}}; const text=`${x}`;",
  ],
  [
    "binary coercion",
    "const x={valueOf(){cp.execSync('npm publish');}}; const text=x+1;",
  ],
  ["unknown argument array", "cp.spawnSync('npm',process.env.ARGS);"],
  [
    "opaque argument array",
    "cp.spawnSync('npm',JSON.parse(process.env.ARGS));",
  ],
  ["opaque cwd", "cp.execSync('echo', {cwd:JSON.parse(process.env.DIR)});"],
  [
    "process environment replacement",
    "cp.spawnSync('node',['script.mjs'],{env:{NODE_OPTIONS:'--require ./hidden.cjs'}});",
  ],
])
  test(`implicit invocation cannot disappear from the graph: ${name}`, () => {
    const report = inspect(`import cp from 'node:child_process';${source}`);
    assert.equal(report.ok, false, JSON.stringify(report));
  });

test("cyclic callback arguments terminate without hiding a callback", () => {
  const report = inspect(`import cp from 'node:child_process';
    const items=[];items.push(items,()=>cp.execSync('npm publish'));console.log(items);`);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(processes(report)[0].script, "npm publish");
});

test("short-circuit and conditional expressions preserve runtime branch selection", () => {
  for (const update of [
    "false && (cmd='echo')",
    "true || (cmd='echo')",
    "true ? 0 : (cmd='echo')",
  ]) {
    const report = inspect(
      `import cp from 'node:child_process'; let cmd='npm publish';${update};cp.execSync(cmd);`,
    );
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(processes(report)[0].script, "npm publish");
  }
  for (const condition of ["process.env.CI", "JSON.parse('true') === true"]) {
    const report = inspect(
      `import cp from 'node:child_process';let cmd='npm publish';${condition} && (cmd='echo');cp.execSync(cmd);`,
    );
    assert.equal(report.ok, false);
  }
});

test("await cannot silently invoke an unanalyzed thenable", () => {
  const report = inspect(
    "import cp from 'node:child_process';await {then(){cp.execSync('npm publish');}};",
  );
  assert.equal(report.ok, false);
});

for (const source of [
  "import run from './run.mjs';run(process.env.CMD);",
  "import run from './run.mjs';run(()=>process.exit(23));",
  "import run from './run.mjs';const a=[];a.push(a);run(a);",
  "fetch(process.env.URL);",
])
  test(`analyzer values never masquerade as concrete cross-module data: ${source}`, () => {
    assert.equal(inspect(source).ok, false);
  });

test("module closure reaches effects through multiple imported helpers", () => {
  const files = {
    "src/main.mjs": "import {run} from './helper.mjs';run('npm');",
    "src/helper.mjs":
      "import {publish} from './inner.mjs';export function run(tool){publish(tool,['publish']);}",
    "src/inner.mjs":
      "import cp from 'node:child_process';export function publish(tool,args){cp.spawnSync(tool,args);}",
    "unused.mjs": "eval(process.env.CODE)",
  };
  const report = inspectJavaScriptModuleClosure({
    files,
    entry: "src/main.mjs",
  });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(
    Object.keys(report.sources).sort(),
    Object.keys(files)
      .filter((x) => x.startsWith("src/"))
      .sort(),
  );
  assert.deepEqual(
    processes(report).map(({ executable, argv }) => ({ executable, argv })),
    [{ executable: "npm", argv: ["publish"] }],
  );
});

test("module closure inspects imported top-level effects and ignores uncalled exported bodies", () => {
  const report = inspectJavaScriptModuleClosure({
    entry: "main.mjs",
    files: {
      "main.mjs": "import './side.mjs';import './library.mjs';",
      "side.mjs":
        "import cp from 'node:child_process';cp.execSync('gh release upload v1 file');",
      "library.mjs":
        "import cp from 'node:child_process';export function release(){cp.execSync('npm publish');}",
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual(
    processes(report).map((x) => x.script),
    ["gh release upload v1 file"],
  );
  assert.match(report.sources["side.mjs"], /^[0-9a-f]{64}$/u);
});

for (const specifier of [
  "./missing.mjs",
  "../outside.mjs",
  "unresolved-package",
  "./data.json",
])
  test(`module closure refuses missing or unsupported executable source: ${specifier}`, () => {
    const report = inspectJavaScriptModuleClosure({
      files: { "main.mjs": `import '${specifier}';`, "data.json": "{}" },
      entry: "main.mjs",
    });
    assert.equal(report.ok, false);
  });

test("mutually recursive module calls and exhausted closure budgets cannot pass", () => {
  const files = {
    "main.mjs": "import {run} from './a.mjs';run();",
    "a.mjs":
      "import {run as other} from './b.mjs';export function run(){other();}",
    "b.mjs":
      "import {run as other} from './a.mjs';export function run(){other();}",
  };
  const recursive = inspectJavaScriptModuleClosure({
    files,
    entry: "main.mjs",
  });
  assert.equal(recursive.ok, false);
  assert(recursive.problems.some((x) => x.code === "cyclic-module-invocation"));
  const bounded = inspectJavaScriptModuleClosure({
    files,
    entry: "main.mjs",
    maxInvocations: 1,
  });
  assert.equal(bounded.ok, false);
  assert(bounded.problems.some((x) => x.code === "invocation-budget"));
});

test("a return from an expanded loop returns from its enclosing function", () => {
  const report = inspect(
    `import cp from 'node:child_process';function command(){for(const x of [1,2]){if(x===1)return 'npm publish';}return 'echo';}cp.execSync(command());`,
  );
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(processes(report)[0].script, "npm publish");
});

for (const source of [
  "let cmd='npm publish';try{}catch(error){cmd='echo';}cp.execSync(cmd);",
  "async function condition(){return false;}if(condition())cp.execSync('npm publish');",
  "async function thenable(){return {then(){cp.execSync('npm publish');}};}thenable();",
  "function* condition(){return false;}if(condition())cp.execSync('npm publish');",
  "function condition(){return false;}if(new condition())cp.execSync('npm publish');",
])
  test(`control-flow uncertainty remains explicit: ${source}`, () => {
    assert.equal(
      inspect(`import cp from 'node:child_process';${source}`).ok,
      false,
    );
  });

test("analysis requires a finite positive node budget", () => {
  for (const maxNodes of [NaN, Infinity, 0, -1])
    assert.equal(inspect("console.log(1)", { maxNodes }).ok, false);
});

test("command graph follows package hooks, shell wrappers and imported JavaScript calls", () => {
  const files = {
    "package.json": JSON.stringify({
      scripts: {
        build: "bash scripts/wrap.sh",
        prebuild: "node scripts/prepare.mjs",
      },
    }),
    "scripts/wrap.sh": "#!/bin/bash\nnode scripts/main.mjs\n",
    "scripts/prepare.mjs":
      "import fs from 'node:fs'; fs.writeFileSync('stamp', 'ready');",
    "scripts/main.mjs":
      "import {send} from './provider.mjs'; send('pub'+'lish');",
    "scripts/provider.mjs":
      "import {execFileSync as run} from 'node:child_process'; export function send(op){run('n'+'pm',[op]);}",
  };
  const report = graph(files, ["corepack pnpm@11.7.0 run build"]);
  assert.equal(report.sourceResolved, false);
  assert.equal(report.commandEdgesResolved, false);
  assert.ok(
    report.problems.some(
      (problem) => problem.code === "internal-orchestration",
    ),
  );
  assert.deepEqual(
    Object.keys(report.sources).sort(),
    Object.keys(files).sort(),
  );
});

test("a package post hook cannot hide provider orchestration", () => {
  const report = graph(
    {
      "package.json": JSON.stringify({
        scripts: {
          build: "node build.mjs",
          postbuild: "g'h' release upload v1 payload",
        },
      }),
      "build.mjs": "console.log('product');",
    },
    ["npm run build"],
  );
  assert.ok(
    report.problems.some(
      (problem) => problem.code === "internal-orchestration",
    ),
  );
});

test("uninvoked files and protocol strings used as product data do not become command edges", () => {
  const files = {
    "build.mjs":
      "import fs from 'node:fs';fs.writeFileSync('product.txt','npm publish --request-json');",
    "unused.mjs": "throw new Error('unused');",
  };
  const report = graph(files, ["node build.mjs"]);
  assert.equal(report.sourceResolved, true, JSON.stringify(report.problems));
  assert.deepEqual(Object.keys(report.sources), ["build.mjs"]);
  assert.equal(
    report.edges.some((edge) => edge.executable === "npm"),
    false,
  );
});

test("external compiler execution remains an unresolved implementation boundary", () => {
  const files = standardConsumerExample("binary");
  const report = graph(files, ["node src/build.mjs"]);
  assert.equal(report.sourceResolved, true);
  assert.equal(report.commandEdgesResolved, false);
  assert.deepEqual(
    report.boundaries.map((edge) => edge.executable),
    ["cc", "tar"],
  );
});

test("relative subprocess cwd resolves from its invoking JavaScript directory", () => {
  const report = graph(
    {
      "pkg/main.mjs":
        "import cp from 'node:child_process';cp.execFileSync('node',['child.mjs'],{cwd:'nested'});",
      "pkg/nested/child.mjs":
        "import cp from 'node:child_process';cp.execSync('npm pub'+'lish');",
    },
    ["node main.mjs"],
    { cwd: "pkg" },
  );
  assert.ok(report.sources["pkg/nested/child.mjs"]);
  assert.ok(
    report.problems.some(
      (problem) => problem.code === "internal-orchestration",
    ),
  );
});

for (const [name, files, commands] of [
  ["shell injection", {}, ["node $(echo hidden.mjs)"]],
  ["pipeline", {}, ["cat command | bash"]],
  ["missing source", {}, ["node missing.mjs"]],
  ["escaped source", {}, ["node ../outside.mjs"]],
  ["directory control", {}, ["cd product || node hidden.mjs"]],
  ["source option", { "main.mjs": "" }, ["node --require hidden.mjs main.mjs"]],
  ["script arguments", { "main.mjs": "" }, ["node main.mjs secret-selector"]],
  ["shell options", { "main.sh": "" }, ["bash -O extglob main.sh"]],
  [
    "package arguments",
    { "package.json": '{"scripts":{"build":"node main.mjs"}}' },
    ["npm run build -- publish"],
  ],
  ["conditional shell expansion", {}, ['bash -c "echo $COMMAND"']],
])
  test(`command graph reports unresolved ${name}`, () => {
    const report = graph(files, commands);
    assert.equal(report.sourceResolved, false);
    assert.equal(report.commandEdgesResolved, false);
  });

test("recursive package scripts and command budget exhaustion fail closed", () => {
  const files = {
    "package.json": JSON.stringify({
      scripts: { a: "npm run b", b: "npm run a" },
    }),
  };
  assert.ok(
    graph(files, ["npm run a"]).problems.some(
      (p) => p.code === "command-cycle",
    ),
  );
  assert.ok(
    graph(files, ["npm run a"], { maxCommands: 1 }).problems.some(
      (p) => p.code === "command-budget",
    ),
  );
  for (const maxCommands of [0, -1, Infinity, 1.5, 10001])
    assert.throws(() => graph(files, [], { maxCommands }), /budget/);
});

test("command parsing preserves a literal backslash within double quotes", () => {
  const report = graph({}, ['tool "literal\\q"']);
  assert.equal(report.boundaries[0].argv[0], "literal\\q");
});

test("direct executable wrappers are traversed without running consumer code", () => {
  const report = graph(
    {
      wrap: '#!/usr/bin/env node\nimport cp from "node:child_process";cp.execSync("gh release create v1");',
    },
    ["./wrap"],
  );
  assert.ok(
    report.problems.some(
      (problem) => problem.code === "internal-orchestration",
    ),
  );
});

function graph(files, commands, options = {}) {
  return inspectConsumerCommandClosure({ files, commands, ...options });
}

test("external tool data arguments are not interpreted as commands or protocol wiring", () => {
  for (const command of [
    "prettier --check packages/core/dev-delivery/warrant.js",
    "echo 'npm publish'",
    'echo \'{"candidateRoot":"fixture"}\'',
  ]) {
    const report = graph({}, [command]);
    assert.deepEqual(report.problems, []);
    assert.equal(report.commandEdgesResolved, false);
    assert.equal(report.boundaries[0].code, "external-executable");
  }
});

test("local npm install and ci traverse root lifecycle helpers without executing them", () => {
  const hooks =
    "preinstall install postinstall prepublish preprepare prepare postprepare dependencies".split(
      " ",
    );
  for (const command of ["npm install", "npm ci"])
    for (const hook of hooks) {
      const report = graph(
        {
          "package.json": JSON.stringify({
            scripts: { [hook]: "node hidden.mjs" },
          }),
          "hidden.mjs":
            "import cp from 'node:child_process';cp.execSync('npm pub'+'lish');",
        },
        [command],
      );
      assert.ok(report.sources["hidden.mjs"], `${command}: ${hook}`);
      assert.ok(
        report.problems.some((p) => p.code === "internal-orchestration"),
      );
      assert.equal(report.commandEdgesResolved, false);
    }
});

test("npm installation dependencies and option-specific behavior remain unresolved", () => {
  const files = { "package.json": '{"scripts":{"postinstall":"npm publish"}}' };
  for (const command of [
    "npm install --ignore-scripts",
    "npm ci --prefix nested",
    "pnpm install",
  ])
    assert.equal(graph(files, [command]).commandEdgesResolved, false);
  const plain = graph({ "package.json": "{}" }, ["npm install"]);
  assert.deepEqual(plain.problems, []);
  assert.equal(plain.boundaries[0].code, "package-manager-operation");
});

test("generated consumer contract gate rejects a computed publication hidden behind product scripts", () => {
  const files = standardConsumerExample("npm");
  files["src/build.mjs"] =
    "import {execSync as execute} from 'node:child_process'; execute(['n'+'pm','pub'+'lish'].join(' '));";
  const report = inspectConsumerContract(files);
  assert.equal(report.ok, false);
  assert.match(report.issues.join("\n"), /internal-orchestration/);
  const binary = inspectConsumerContract(standardConsumerExample("binary"));
  assert.equal(binary.ok, true);
  assert.equal(
    binary.commandClosures[0].commandEdgesResolved,
    false,
    "Template inspection does not approve unresolved compiler implementations",
  );
});

test("product source containing unused protocol fixtures is not consumer orchestration", () => {
  const files = standardConsumerExample("npm");
  files["fixtures/protocol.json"] =
    '{"candidateRoot":"fixture","fencingToken":1}';
  files["src/uninvoked.mjs"] = "export const command='npm publish';";
  const report = inspectConsumerContract(files);
  assert.equal(report.ok, true, report.issues.join("\n"));
  assert.equal(
    report.commandClosures[0].sources["src/uninvoked.mjs"],
    undefined,
  );
});
