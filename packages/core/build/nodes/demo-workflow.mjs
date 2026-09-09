import { command,runOperation } from '../../runtime/action-process.mjs';
import { writeGitHubOutputs } from '../../providers/commands/github-output.mjs';
import { captureDemoCollection,qualifyDemoCollection,renderDemoCollection } from './demo-collection.mjs';
import { demoCollectionIdentity,normalizedDemoDigest } from './demo-collection-io.mjs';
import { establishDemoBranch,materializeDemoCollection,publishDemoPullRequest } from './demo-publication.mjs';
await runOperation({source:()=>writeGitHubOutputs({sha:command('git',['-C','source','rev-parse','HEAD'],{stdio:'pipe'}).trim()}),capture:captureDemoCollection,gate:qualifyDemoCollection,render:renderDemoCollection,'capture-identity':env=>demoCollectionIdentity(env,'captures'),'evidence-identity':env=>demoCollectionIdentity(env,'evidence'),digest:env=>writeGitHubOutputs({digest:normalizedDemoDigest(env.RAW)}),branch:establishDemoBranch,materialize:materializeDemoCollection,publish:publishDemoPullRequest});
