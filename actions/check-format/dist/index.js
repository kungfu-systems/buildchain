var l=(t,e)=>()=>(e||t((e={exports:{}}).exports,e),e.exports);var c=l(r=>{var a=require("@actions/github"),p=require("fs-extra"),$=require("path"),d=require("git-client"),{spawnSync:m}=require("child_process"),f={shell:!0,stdio:"pipe",windowsHide:!0};function q(t,e=[],n=f){console.log("$",t,...e);let o=m(t,e,n),s=o.output.filter(u=>u&&u.length>0).toString();if(console.log(s),o.status!==0)throw new Error(`Failed with status ${o.status}`);return s}async function w(...t){console.log("$ git",...t);let e=await d(...t);return console.log(e),e}r.checkFormat=async function(t){if(p.readJSONSync("package.json").scripts.format!==void 0){q("yarn",["run","format"]);let o=await w("status","--short");if(o)throw console.log(`
! Found unformatted code`),r.addPullRequestComment(t,o),new Error(`Found unformatted code
${o}`)}else console.log('[info] package.json does not define "format" action in scrips.')};r.addPullRequestComment=async function(t,e){let n=a.getOctokit(t.token),o=await n.graphql(`
    query {
      repository(name: "${t.repo}", owner: "${t.owner}") {
        pullRequest(number: ${t.pullRequestNumber}) { id }
      }
  }`);console.log(`[info] Found unformatted code in repo [${t.owner}/${t.repo}]'s ${t.pullRequestNumber}th pull-request`);let s=o.repository.pullRequest.id,u=`Unformatted code:
${e}`;await n.graphql(`mutation{addComment(input:{body:"${u}", subjectId:"${s}"}){clientMutationId}}`)}});var h=exports.lib=c(),i=require("@actions/core"),b=require("@actions/github"),g=async function(){let t=b.context,e=()=>t.issue.number?t.issue.number:t.payload.pull_request.number,n={token:i.getInput("token"),owner:t.repo.owner,repo:t.repo.repo,pullRequestNumber:e()};await h.checkFormat(n)};require.main===module&&g().catch(t=>{console.error(t),i.setFailed(t.message)});
