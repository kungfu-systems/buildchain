import path from 'node:path';
import { requireValue } from '../../runtime/action-process.mjs';
export function requireDemoImage(image) {requireValue(/^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/.test(image||''),'renderer-image must be immutable');}
export function collectionContainerArguments(env,operation,id) {
  requireDemoImage(env.RENDERER_IMAGE);requireValue(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id||''),'Demo id is not canonical');
  requireValue(['capture','smoke','inspect-smoke','validate','render','inspect-render'].includes(operation),'Unknown collection container operation');
  const root=`qualified-collection/${id}`,image=env.RENDERER_IMAGE;
  const memory=operation==='render'?'1g':['capture','smoke'].includes(operation)?'512m':'128m';
  const args=['run','--rm','--network','none','--read-only','--user','65532:65532','--pids-limit','256','--security-opt','no-new-privileges','--tmpfs',`/tmp:rw,noexec,nosuid,size=${memory}`];
  const volume=(from,to)=>['--volume',`${path.join(env.GITHUB_WORKSPACE,from)}:${to}`];
  if(operation==='capture')return [...args,...volume('.buildchain/runtime','/runtime:ro'),...volume('source-artifact','/artifact:ro'),...volume(`source/${env.SCENARIO_PATH}`,'/scenario.json:ro'),...volume('binary-coordinate.json','/source-coordinate.json:ro'),...volume(`capture-collection/${id}`,'/output'),'--entrypoint','python3',image,'/runtime/packages/core/providers/commands/auditable-demo-capture.py','--artifact-root','/artifact','--scenario','/scenario.json','--source-coordinate','/source-coordinate.json','--demo-id',id,'--network-isolation','docker-none','--output','/output/capture'];
  if(operation.startsWith('inspect-')){const kind=operation.slice('inspect-'.length);return [...args,...volume('.buildchain/runtime','/buildchain:ro'),...volume(`${root}/${kind}-output`,'/media:ro'),...volume(`${root}/${kind}-inspection`,'/inspection'),'--entrypoint','node',image,'/buildchain/packages/core/build/commands/auditable-demo.mjs','inspect-media','--render-output','/media','--renderer-image',image,'--output','/inspection/media-inspection.json'];}
  const smoke=operation==='smoke';const media=['--scene','/input/scene.json','--transcript','/input/complete-transcript.txt','--projection','/input/public-projection.json'];
  if(!smoke)media.push('--terminal-capture','/input/terminal-capture.json','--rendition-set','/input/rendition-set.json');
  const input=smoke?`${root}/smoke-input`:`${root}/gate`;if(operation==='validate')return [...args,...volume(input,'/input:ro'),image,'demo-renderer','--validate-only',...media];
  return [...args,...volume(input,'/input:ro'),...volume(`${root}/${smoke?'smoke':'render'}-output`,'/output'),image,'demo-renderer',...media,'--output','/output','--renderer-image',image];
}
