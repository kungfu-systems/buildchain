/* eslint-disable no-restricted-globals */
import { syncAirtableWithRest } from "./pr.js";
import yargs from "yargs/yargs";
//node cli.js --token ??? --owner kungfu-trade
const argv = yargs(process.argv.slice(2))
  .option("token", { description: "token", type: "string" })
  .option("owner", { description: "owner", type: "string" })
  .option("apiKey", { description: "apiKey", type: "string" })
  .option("base", { description: "base", type: "string" })
  .help().argv;

// pr.getPrWithGraphQL(argv).catch(console.error);
syncAirtableWithRest(argv).catch(console.error);
