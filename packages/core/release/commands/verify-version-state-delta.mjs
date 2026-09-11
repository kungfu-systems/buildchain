import { pathToFileURL } from "node:url";
import { verifyVersionStateDelta } from "../version-state/verification.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        verifyVersionStateDelta({
          baseSha: process.argv[2],
          headSha: process.argv[3],
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
