import fs from "node:fs";
import path from "node:path";
import { command } from "../../runtime/action-process.mjs";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

export function adopterSelection(env = process.env, emit = writeGitHubOutputs) {
  const request=JSON.parse(env.BUILDCHAIN_ADOPTER_REQUEST_JSON);
  const external=[request['consumer-repository'],request['consumer-ref'],request['invocation-source-path']];
  if(external.some(Boolean) && (!/^[\w.-]+\/[\w.-]+$/.test(external[0] || '') || !/^[0-9a-f]{40}$/i.test(external[1] || '') || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(external[2] || '')))
    throw Error('External adopter requires repository, exact commit and public invocation path together');
  if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(request.consumer || ''))throw Error('Adopter identity must be stable lowercase');
  const sha=String(request['consumer-ref'] || env.GITHUB_SHA).toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(sha) || !/^[0-9a-f]{40}$/.test(env.BUILDCHAIN_WORKFLOW_SHA || ''))throw Error('Adopter requires exact consumer and runtime commits');
  const output={repository:request['consumer-repository'] || env.GITHUB_REPOSITORY,sha};
  emit(output);return output;
}
export function adopterPaths(env) {
 const workspace=env.GITHUB_WORKSPACE || process.cwd();
 return {runtime:path.join(workspace,'.buildchain/workflow-shell'),consumer:path.join(workspace,'.buildchain/consumer'),evidence:path.join(workspace,'.buildchain/adopter-delivery')};
}
export function verifyAdopterCheckouts(env=process.env,run=command) {
 const paths=adopterPaths(env),request=JSON.parse(env.BUILDCHAIN_ADOPTER_REQUEST_JSON);
 const expected=env.BUILDCHAIN_CONSUMER_SHA || request['consumer-ref'] || env.GITHUB_SHA;
 for(const [directory,sha]of [[paths.runtime,env.BUILDCHAIN_WORKFLOW_SHA],[paths.consumer,expected]]){
  if(!/^[0-9a-f]{40}$/i.test(sha || '') || run('git',['-C',directory,'rev-parse','HEAD'],{stdio:'pipe'}).trim()!==sha.toLowerCase())throw Error('Adopter checkout drifted from exact admission');
 }
 return paths;
}
export function adopterInputFile(root,relative) {
 if(!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part=>!part || part==='..' || part==='.'))throw Error('Adopter input must be repository-relative');
 const file=fs.realpathSync(path.join(root,relative));
 if(!file.startsWith(fs.realpathSync(root)+path.sep)||!fs.statSync(file).isFile())throw Error('Adopter input escapes consumer repository');
 return file;
}
export function admitAdopter(env=process.env,run=command) {
 const paths=verifyAdopterCheckouts(env,run),request=JSON.parse(env.BUILDCHAIN_ADOPTER_REQUEST_JSON);
 adopterInputFile(paths.consumer,request['input-path']);
 return run(process.execPath,[path.join(paths.runtime,'packages/core/consumer/commands/consumer-policy.mjs'),'scan','--repository',request['consumer-repository'] || env.GITHUB_REPOSITORY,'--source-sha',request['consumer-ref'] || env.GITHUB_SHA],{env:{...env,
  BUILDCHAIN_CONSUMER_ROOT:paths.consumer,BUILDCHAIN_INVOKED_WORKFLOW:'.github/workflows/public-build-adopter-qualification.yml',
  BUILDCHAIN_INVOCATION_SOURCE_PATH:request['invocation-source-path'] || (env.GITHUB_REPOSITORY==='kungfu-systems/buildchain'?'.github/workflows/self-build-adopter-dogfood.yml':''),
  BUILDCHAIN_WORKFLOW_SHA:env.BUILDCHAIN_WORKFLOW_SHA,BUILDCHAIN_RUNTIME_SHA:env.BUILDCHAIN_WORKFLOW_SHA,
  BUILDCHAIN_STABLE_CONTRACT_LOCK_PATH:'.buildchain/contract-lock.json',BUILDCHAIN_ALPHA_CONTRACT_LOCK_PATH:'.buildchain/alpha-contract-lock.json',
  BUILDCHAIN_V4_POLICY_RECEIPT_PATH:'.buildchain/evidence/adopter-delivery-policy-receipt.json',
 }});
}
export function runAdopterConformance(env=process.env,run=command) {
 const paths=verifyAdopterCheckouts(env,run),request=JSON.parse(env.BUILDCHAIN_ADOPTER_REQUEST_JSON);
 const input=adopterInputFile(paths.consumer,request['input-path']);
 const platform=env.BUILDCHAIN_ADOPTER_PLATFORM;
 if(platform!==`${process.platform==='win32'?'windows':process.platform==='darwin'?'macos':process.platform}-${process.arch}`)throw Error('Adopter platform must match the real runner');
 return run(process.execPath,[path.join(paths.runtime,'packages/core/adoption/commands/cross-platform-adopter-qualification.mjs'),'run','--runtime-root',paths.runtime,'--consumer-root',paths.consumer,'--platform',platform,'--consumer',request.consumer,'--runtime-sha',env.BUILDCHAIN_WORKFLOW_SHA,'--consumer-sha',env.BUILDCHAIN_CONSUMER_SHA,'--input',input,'--output',path.join(paths.evidence,platform,'qualification-report.json')],{env});
}
export function reconcileAdopter(env=process.env,run=command){
 const paths=adopterPaths(env),request=JSON.parse(env.BUILDCHAIN_ADOPTER_REQUEST_JSON);
 return run(process.execPath,[path.join(paths.runtime,'packages/core/adoption/commands/cross-platform-adopter-qualification.mjs'),'aggregate','--reports-root',path.join(env.GITHUB_WORKSPACE,'.buildchain/platform-reports'),'--consumer',request.consumer,'--output',path.join(env.GITHUB_WORKSPACE,'.buildchain/adopter-delivery-qualification.json')],{env});
}
