import path from 'node:path';
import { command,requireValue } from '../../runtime/action-process.mjs';
import { exactRemoteBranch } from '../../providers/git-ref-readback.mjs';
import { writeGitHubOutputs } from '../../providers/commands/github-output.mjs';
import { materializeDemo } from '../commands/auditable-demo-platform.mjs';
import { demoScenario } from './demo-collection-io.mjs';
export function demoBranchName(sha){requireValue(/^[0-9a-f]{40}$/.test(sha||''),'Demo source SHA must be exact');return `automation/auditable-demo-${sha.slice(0,12)}`;}
export function establishDemoBranch(env,execute=command) {
  const cwd=path.join(env.GITHUB_WORKSPACE,'source'),branch=demoBranchName(env.SOURCE_SHA);const remote=exactRemoteBranch(branch,execute,cwd);
  if(remote){execute('git',['fetch','origin',`refs/heads/${branch}:refs/remotes/origin/${branch}`],{cwd});execute('git',['switch','-c',branch,'--track',`origin/${branch}`],{cwd});execute('git',['merge-base','--is-ancestor',env.SOURCE_SHA,'HEAD'],{cwd});}
  else execute('git',['switch','-c',branch],{cwd});
}
export function materializeDemoCollection(env,materialize=materializeDemo) {
  const {repository,scenarioPath,scenario}=demoScenario(env);
  for(const demo of scenario.demos)materialize({repositoryRoot:repository,scenarioPath,demoId:demo.id,captureRoot:path.join(env.GITHUB_WORKSPACE,`.demo-input/captures/${demo.id}/capture`),gateBundle:path.join(env.GITHUB_WORKSPACE,`.demo-input/qualified/${demo.id}/gate`),mediaBundle:path.join(env.GITHUB_WORKSPACE,`.demo-input/qualified/${demo.id}/media`),buildchainSha:env.BUILDCHAIN_WORKFLOW_SHA,rendererImage:env.RENDERER_IMAGE});
}
export function publishDemoPullRequest(env,execute=command) {
  const {repository,scenario}=demoScenario(env),branch=demoBranchName(env.SOURCE_SHA);const git=(args,pipe=false)=>execute('git',args,{cwd:repository,stdio:pipe?'pipe':'inherit'});const gh=args=>execute('gh',args,{cwd:repository,stdio:'pipe'}).trim();
  requireValue(git(['branch','--show-current'],true).trim()===branch,'Current branch differs from exact demo update branch');
  const rows=JSON.parse(gh(['pr','list','--repo',env.GITHUB_REPOSITORY,'--state','open','--head',branch,'--base',env.BASE_REF,'--json','url']));requireValue(rows.length<=1,'Demo materialization has multiple matching pull requests');
  const files=[scenario.publication.readmePath,scenario.publication.evidencePath];if(scenario.presentation)files.push(scenario.presentation.materialization.technicalSpecPath);git(['add','--',...files]);
  const changed=Boolean(git(['diff','--cached','--name-only','-z'],true));
  if(changed){git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-s','-m','docs: refresh auditable demo media']);git(['push','origin',`HEAD:refs/heads/${branch}`]);const source=git(['rev-parse','HEAD'],true).trim();requireValue(exactRemoteBranch(branch,execute,repository)===source,'Demo branch readback differs from the pushed commit');}
  let url=rows[0]?.url||'';if(!url&&changed)url=gh(['pr','create','--repo',env.GITHUB_REPOSITORY,'--base',env.BASE_REF,'--head',branch,'--title','docs: refresh auditable demo media','--body','Refreshes content-addressed auditable demo media from the exact declared standalone binary, qualified Gate, immutable renderer, and Release Passport. Identity and Product System metadata grant no authority.']);
  writeGitHubOutputs({url});return url;
}
