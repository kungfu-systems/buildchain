/* eslint-disable no-restricted-globals */
const lib = require("./lib.js");

const argv = require("yargs/yargs")(process.argv.slice(2))
  .option("token", { description: "token", type: "string" })
  .option("release-path", {
    description: "release path",
    type: "string",
    default: "static",
  })
  .option("product", { description: "product", type: "string" })
  .help().argv;

lib.generate(argv);
