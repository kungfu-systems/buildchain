/* eslint-disable no-restricted-globals */
const pr = require("./pr.js");
//node cli.js --token ??? --owner kungfu-trade
const argv = require("yargs/yargs")(process.argv.slice(2))
  .option("token", { description: "token", type: "string" })
  .option("owner", { description: "owner", type: "string" })
  .option("apiKey", { description: "apiKey", type: "string" })
  .option("base", { description: "base", type: "string" })
  .help().argv;

// pr.getPrWithGraphQL(argv).catch(console.error);
pr.syncAirtableWithRest(argv).catch(console.error);
