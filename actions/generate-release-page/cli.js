/* eslint-disable no-restricted-globals */
import { generate } from "./lib/index.js";
import yargs from "yargs/yargs";

const argv = yargs(process.argv.slice(2))
  .option("token", { description: "token", type: "string" })
  .option("release-path", {
    description: "release path",
    type: "string",
    default: "static",
  })
  .option("product", { description: "product", type: "string" })
  .help().argv;

generate(argv);
