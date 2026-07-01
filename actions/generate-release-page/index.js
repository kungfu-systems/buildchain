/* eslint-disable no-restricted-globals */
import * as core from "@actions/core";
import * as lib from "./lib/index.js";

export const main = function () {
  const argv = {
    token: core.getInput("token"),
    apiKey: core.getInput("apiKey"),
    product: core.getInput("product"),
    releasePath: core.getInput("release-path"),
    baseUrl: core.getInput("release-url"),
    lowerEdge: core.getInput("lower-edge"),
    upperEdge: core.getInput("upper-edge"),
    baseId: core.getInput("base-id"),
    bucketRelease: core.getInput("bucket-release"),
    exclude: core.getInput("exclude"),
    productName: core.getInput("product-name"),
    repo: core.getInput("repo"),
    title: core.getInput("title"),
  };
  lib.generate(argv);
};

if (process.env.GITHUB_ACTION) {
  main();
}

export { lib };
