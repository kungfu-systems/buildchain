import fs from 'node:fs';
import os from 'node:os';

function inputName(name) {
  return `INPUT_${name.replace(/ /g, '_').replace(/-/g, '_').toUpperCase()}`;
}

export function getInput(name) {
  return process.env[inputName(name)] || '';
}

export function setOutput(name, value) {
  const output = `${name}=${String(value)}${os.EOL}`;
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    return;
  }
  console.log(output.trimEnd());
}

export function setFailed(message) {
  process.exitCode = 1;
  console.error(message);
}
