import fs from 'node:fs';
import path from 'node:path';
import { requireValue } from '../../runtime/action-process.mjs';
import { validateScenario } from '../commands/auditable-demo-platform.mjs';
import { writeGitHubOutputs } from '../../providers/commands/github-output.mjs';
export function demoScenario(env) {
  const repository=path.join(env.GITHUB_WORKSPACE,'source'),scenarioPath=path.resolve(repository,env.SCENARIO_PATH);const relative=path.relative(repository,scenarioPath);
  requireValue(relative&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative),'Demo scenario must belong to the checked-out source');
  return {repository,scenarioPath,scenario:validateScenario(JSON.parse(fs.readFileSync(scenarioPath,'utf8')))};
}
export function normalizedDemoDigest(raw) {const value=String(raw||'').replace(/^sha256:/,'');requireValue(/^[0-9a-f]{64}$/.test(value),'Demo artifact digest is invalid');return `sha256:${value}`;}
export function demoCollectionIdentity(env,kind) {
  requireValue(/^[0-9a-f]{40}$/.test(env.SOURCE_SHA||''),'Demo source SHA must be exact');
  writeGitHubOutputs({name:`declarative-demo-${kind}-${env.SOURCE_SHA.slice(0,12)}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`});
}
export default async function demoArtifactCoordinate({github,context},env=process.env) {
  const expected=normalizedDemoDigest(env.EXPECTED_DIGEST);const artifacts=await github.paginate(github.rest.actions.listWorkflowRunArtifacts,{owner:context.repo.owner,repo:context.repo.repo,run_id:context.runId,per_page:100});
  const matches=artifacts.filter(artifact=>artifact.name===env.EXPECTED_NAME&&!artifact.expired);requireValue(matches.length===1&&matches[0].digest===expected,'Exact same-run demo artifact is absent or drifted');
  const artifact=matches[0];requireValue(['binary-coordinate.json','capture-coordinate.json'].includes(env.COORDINATE_PATH),'Unknown demo coordinate output');
  fs.writeFileSync(env.COORDINATE_PATH,JSON.stringify({schema:'buildchain.github-artifact-coordinate/v1',repository:`${context.repo.owner}/${context.repo.repo}`,runId:String(context.runId),runAttempt:String(env.GITHUB_RUN_ATTEMPT),sourceSha:env.SOURCE_SHA,id:String(artifact.id),nodeId:artifact.node_id,name:artifact.name,digest:artifact.digest,sizeInBytes:artifact.size_in_bytes,createdAt:artifact.created_at,expiresAt:artifact.expires_at},null,2)+'\n');
}
