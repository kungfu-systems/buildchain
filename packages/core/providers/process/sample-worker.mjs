import { sampleProcessTree } from "../../observability/process/sampling.js";
try {
  const request = JSON.parse(process.argv[2]);
  const report = await sampleProcessTree({
    ...request,
    cwd: process.cwd(),
    environment: process.env,
  });
  if (report.exit.error || report.exit.signal || report.exit.status !== 0)
    process.exitCode = report.exit.status || 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
