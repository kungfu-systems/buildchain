import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { command } from '../../runtime/action-process.mjs';
import { prepareArtifact } from '../commands/auditable-demo-platform.mjs';
import { demoScenario } from './demo-collection-io.mjs';
import { collectionContainerArguments,requireDemoImage } from './demo-collection-container.mjs';
function writable(directory){fs.mkdirSync(directory,{recursive:true});fs.chmodSync(directory,0o777);}
function demoCommand(env,args,execute){execute(process.execPath,[path.join(env.GITHUB_WORKSPACE,'.buildchain/runtime/packages/core/build/commands/auditable-demo.mjs'),...args]);}
export function captureDemoCollection(env,execute=command) {
  requireDemoImage(env.RENDERER_IMAGE);const {scenario,scenarioPath}=demoScenario(env);prepareArtifact({scenarioPath,artifactRoot:path.join(env.GITHUB_WORKSPACE,'source-artifact')});execute('docker',['pull',env.RENDERER_IMAGE]);
  for(const demo of scenario.demos){writable(`capture-collection/${demo.id}`);execute('docker',collectionContainerArguments(env,'capture',demo.id));}
}
export function qualifyDemoCollection(env,execute=command) {
  requireDemoImage(env.RENDERER_IMAGE);const {scenario}=demoScenario(env);execute('docker',['pull',env.RENDERER_IMAGE]);const absolute=relative=>path.join(env.GITHUB_WORKSPACE,relative);
  for(const demo of scenario.demos){const root=`qualified-collection/${demo.id}`;fs.mkdirSync(`${root}/diagnostics`,{recursive:true});writable(`${root}/smoke-output`);writable(`${root}/render-output`);
    demoCommand(env,['run-adapter','--source-root',absolute('.buildchain/runtime'),'--artifact-root',absolute(`capture-collection/${demo.id}/capture`),'--source-coordinate',absolute('capture-coordinate.json'),'--adapter','packages/core/build/commands/auditable-demo-platform.mjs','--adapter-arguments-json','[]','--output',absolute(`${root}/adapter`),'--diagnostics',absolute(`${root}/diagnostics`)],execute);
    demoCommand(env,['prepare-smoke','--adapter-output',`${root}/adapter`,'--output',`${root}/smoke-input`],execute);execute('docker',collectionContainerArguments(env,'smoke',demo.id));writable(`${root}/smoke-inspection`);execute('docker',collectionContainerArguments(env,'inspect-smoke',demo.id));
    demoCommand(env,['finalize-gate','--adapter-output',`${root}/adapter`,'--smoke-input',`${root}/smoke-input`,'--smoke-output',`${root}/smoke-output`,'--source-coordinate','capture-coordinate.json','--diagnostics',`${root}/diagnostics`,'--adapter','packages/core/build/commands/auditable-demo-platform.mjs','--renderer-image',env.RENDERER_IMAGE,'--source-sha',env.SOURCE_SHA,'--media-profile',env.MEDIA_PROFILE,'--media-inspection',`${root}/smoke-inspection/media-inspection.json`,'--output',`${root}/gate`],execute);
  }
}
export function renderDemoCollection(env,execute=command) {
  requireDemoImage(env.RENDERER_IMAGE);const {scenario}=demoScenario(env);
  for(const demo of scenario.demos){const root=`qualified-collection/${demo.id}`;const gateRoot=`sha256:${crypto.createHash('sha256').update(fs.readFileSync(`${root}/gate/checksums.sha256`)).digest('hex')}`;
    execute('docker',collectionContainerArguments(env,'validate',demo.id));execute('docker',collectionContainerArguments(env,'render',demo.id));writable(`${root}/render-inspection`);execute('docker',collectionContainerArguments(env,'inspect-render',demo.id));
    demoCommand(env,['finalize-media','--gate-bundle',`${root}/gate`,'--gate-root',gateRoot,'--render-output',`${root}/render-output`,'--renderer-image',env.RENDERER_IMAGE,'--source-sha',env.SOURCE_SHA,'--media-profile',env.MEDIA_PROFILE,'--media-inspection',`${root}/render-inspection/media-inspection.json`,'--output',`${root}/media`],execute);
  }
}
