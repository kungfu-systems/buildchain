import fs from "node:fs";
import path from "node:path";
import { publishedDigest, runNpm } from "./registry.js";
import { createNativeChildEnvironment } from "../../dev-delivery/native/execution.js";
import {
  publicationFile,
  publicationPath,
  writeImmutablePublicationFile,
} from "../pipeline/files.js";

export function pipelineNpmEnvironment(directory, environment = process.env) {
  const cwd = path.resolve(directory);
  const config = path.join(cwd, ".buildchain-publisher.npmrc");
  fs.mkdirSync(cwd, { recursive: true });
  writeImmutablePublicationFile(
    config,
    environment.NODE_AUTH_TOKEN
      ? "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n"
      : "",
  );
  const env = {
    ...createNativeChildEnvironment(environment),
    NPM_CONFIG_USERCONFIG: config,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
  };
  for (const key of [
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "NODE_AUTH_TOKEN",
    "GITHUB_ACTIONS",
  ])
    if (environment[key]) env[key] = environment[key];
  return env;
}

export function pipelineNpmProvider({
  directory,
  artifacts,
  environment = process.env,
  run = runNpm,
  lookup = publishedDigest,
}) {
  const cwd = path.resolve(directory);
  const env = pipelineNpmEnvironment(directory, environment);
  const registry = "https://registry.npmjs.org/";
  const args = { cwd, env, registry };
  function artifactFor(effect) {
    const found = artifacts.filter(
      (artifact) => artifact.id === effect.product,
    );
    if (
      found.length !== 1 ||
      found[0].package?.name !== effect.name ||
      found[0].package?.version !== effect.version ||
      found[0].package?.integrity !== effect.integrity
    )
      throw new Error("npm publication changed qualified package identity");
    const artifact = found[0];
    const file = publicationPath(cwd, artifact.file);
    const bytes = publicationFile(file);
    if (
      bytes.integrity !== effect.integrity ||
      bytes.digest !== artifact.digest
    )
      throw new Error("npm publication bytes changed after qualification");
    return file;
  }
  return {
    async observe(effect) {
      artifactFor(effect);
      if (effect.access === "restricted" && !env.NODE_AUTH_TOKEN)
        throw new Error(
          "Restricted npm readback requires a configured package read credential",
        );
      const integrity = lookup({
        ...args,
        name: effect.name,
        version: effect.version,
      });
      return integrity ? { state: "present", integrity } : { state: "absent" };
    },
    matches: (effect, observed) =>
      observed.state === "present" && observed.integrity === effect.integrity,
    async apply(effect) {
      const file = artifactFor(effect);
      const result = run({
        cwd,
        env,
        args: [
          "publish",
          file,
          "--ignore-scripts",
          "--provenance=false",
          "--access",
          effect.access,
          "--tag",
          effect.tag,
          `--registry=${registry}`,
        ],
        allowFailure: true,
      });
      if (result.status !== 0)
        throw new Error(
          `Sealed npm publication failed with exit ${result.status}`,
        );
    },
  };
}
