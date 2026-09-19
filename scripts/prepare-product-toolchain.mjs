import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Product prerequisites cross command phases through the runner file protocol.
// An explicit cache works with the credential-isolated Windows environment too.
fs.appendFileSync(
  process.env.GITHUB_ENV,
  `GOTOOLCHAIN=go1.25.14+auto\nGOCACHE=${path.join(os.tmpdir(), "buildchain-go-cache")}\nGOPATH=${path.join(os.tmpdir(), "buildchain-go")}\n`,
);
