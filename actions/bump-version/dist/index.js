var ce=Object.defineProperty;var le=(e,t)=>{for(var o in t)ce(e,o,{get:t[o],enumerable:!0})};var oe={};le(oe,{currentVersion:()=>d,ensureBranchesProtection:()=>Z,ensureLerna:()=>F,exec:()=>_,getBumpKeyword:()=>k,getChannel:()=>R,gitCall:()=>a,resetDefaultBranch:()=>te,setOpts:()=>fe,suspendBranchesProtection:()=>ee,tryBump:()=>x,tryMerge:()=>K,tryPublish:()=>U,verify:()=>G});import*as B from"@actions/github";import L from"fs";import Q from"os";import T from"path";import Y from"git-client";import H from"semver";import{spawnSync as M}from"child_process";var z=["main","release/*/*","alpha/*/*","dev/*/*"],$={dry:!1},N={shell:!0,stdio:"pipe",windowsHide:!0};function P(e){return L.existsSync(T.join(e,"lerna.json"))}function y(e){let t=T.join(e,P(e)?"lerna.json":"package.json"),o=JSON.parse(L.readFileSync(t));return H.parse(o.version)}function S(e){return`${e.major}.${e.minor}`}function R(e){return e.replace(/^refs\/heads\//,"").split("/")[0]}function E(e,t,o,s=!1){let r=y(e),n=Number(S(r)),l=n-.1,u=R(t),p=R(o),m=`${u}->${p}`,q={"dev->alpha":"prerelease","alpha->release":"patch","release->main":"preminor","release->release":"preminor","main->main":"premajor"},f=p==="release"&&o.split("/").pop()==="lts",I=u==="release"&&(p==="main"||f);if(t.replace(u,"")!==o.replace(p,"")&&!I)throw new Error(`Versions not match for head/base refs: ${t} -> ${o}`);if(u==="main")return q[m];let C=t.match(/(\w+)\/v(\d+)\/v(\d+\.\d)/),w=`The version of head ref ${t} does not match current ${r}`;if(!C)throw new Error(w);let j=Number(C[2]),O=Number(C[3]);if(j!==r.major||O>n)throw new Error(w);if(O<l)throw new Error(w);if(O===l&&!s)throw new Error(w);return q[m]}function _(e,t=[],o=N){if(console.log("$",e,...t),$.dry)return;let s=M(e,t,o),r=s.output.filter(n=>n&&n.length>0).toString();if(console.log(r),s.status!==0)throw new Error(`Failed with status ${s.status}`)}async function a(...e){if(console.log("$ git",...e),$.dry)return;let t=await Y(...e);console.log(t)}async function ue(e){if($.dry){console.log(`$ git tag -d ${e} # if local tag exists`);return}try{await Y("rev-parse","--verify",`refs/tags/${e}`)}catch{return}await a("tag","-d",e)}async function g(e,t){return await B.getOctokit(e.token).graphql(t,{headers:{Connection:"close"}})}async function D(e,t,o,s=!0){let r=y(e.cwd),n=H.inc(r,t,"alpha"),l=["--message",o?`"${o}"`:`"Move on to v${n}"`],u=t==="patch"?[]:l,p=s?[]:["--no-git-tag-version"];if(s&&await ue(`v${n}`),P(e.cwd)){if(t==="patch"||t==="prepatch"){let f=`release/v${r.major}/lerna-bump-patch`;await a("switch","-C",f,"HEAD")}let m=t==="prerelease"&&!o?["--force-publish"]:[],q=["--yes","--no-push",...u,...p,...m];_("lerna",["version",`${t}`,...q])}else{let m=["--preid","alpha",...u,...p];_("yarn",["version",`--${t}`,...m])}}async function pe(e){let t=o=>{let s=JSON.parse(L.readFileSync(T.join(o,"package.json")));if(s.private)console.log(`> bypass private package ${s.name}`);else{let r={cwd:o,...N};_("npm",["publish"],r)}};if(P(e.cwd)){console.log("> detected lerna, use yarn workspaces publish");let s=M("yarn",["-s","workspaces","info"],N).output.filter(r=>r&&r.length>0).toString();if(s.toString().split(" ")[0]!=="error"){let r=JSON.parse(s);for(let n in r){let l=r[n];t(T.join(e.cwd,l.location))}}else console.log("[error]: Found lerna.json in a non-workspace project, please remove lerna.json in your project!")}else console.log("> use npm publish"),t(e.cwd)}async function X(e){let t={},{repository:o}=await g(e,`query{repository(name:"${e.repo}",owner:"${e.owner}"){id}}`),s=await g(e,`
        query {
          repository(name: "${e.repo}", owner: "${e.owner}") {
            branchProtectionRules(first:100) {
              nodes {
                id
                creator { login }
                pattern
              }
            }
          }
        }`);for(let r of s.repository.branchProtectionRules.nodes)t[r.pattern]=r.id;for(let r of z.filter(n=>!(n in t))){console.log(`> creating protection rule for branch name pattern ${r}`);let{createBranchProtectionRule:n}=await g(e,`
      mutation {
        createBranchProtectionRule(input: {
          repositoryId: "${o.id}"
          pattern: "${r}"
        }) {
          branchProtectionRule { id }
        }
      }
    `);t[r]=n.branchProtectionRule.id}return t}async function Z(e){if(!e.protection)return;let t=await X(e);for(let o in t){let s=t[o],r=o.split("/")[0]!=="dev",n=r||e.protectDevBranches,l=o.split("/")[0]==="release",p=`
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${s}"
          requiresApprovingReviews: ${n},
          requiredApprovingReviewCount: ${n?1:0},
          dismissesStaleReviews: true,
          restrictsReviewDismissals: true,
          requiresStatusChecks: true,
          requiresCodeOwnerReviews: ${l},
          requiredStatusCheckContexts: ${r?'["verify"]':"[]"},
          requiresStrictStatusChecks: true,
          requiresConversationResolution: true,
          isAdminEnforced: true,
          restrictsPushes: ${n},
          allowsForcePushes: false,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;if(console.log(`> ensure protection for branch name pattern ${o}`),$.dry){console.log(p);continue}await g(e,p)}}async function ee(e,t=z){if(!e.protection)return;let o=await X(e);for(let s of t){let n=`
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${o[s]}"
          requiresApprovingReviews: false,
          requiredApprovingReviewCount: 0,
          dismissesStaleReviews: false,
          restrictsReviewDismissals: false,
          requiresStatusChecks: false,
          requiresCodeOwnerReviews: false,
          requiresStrictStatusChecks: false,
          requiresConversationResolution: false,
          isAdminEnforced: true,
          restrictsPushes: false,
          allowsForcePushes: true,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;if(console.log(`> suspend protection for branch name pattern ${s}`),$.dry){console.log(n);continue}await g(e,n)}}async function he(e,t){let s={premajor:["release","alpha","dev"],preminor:["release","alpha","dev"],patch:["release","alpha","dev"],prerelease:["dev"]}[t].map(i=>`${i}/*/*`);await ee(e,s).catch(console.error);let r=B.getOctokit(e.token),n=y(e.cwd),l=i=>a("push","-f","origin",`HEAD:refs/tags/${i}`),u=i=>l(`v${S(i)}-alpha`),p=i=>l(`v${S(i)}`),m=i=>r.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`tags/v${i.major}.${i.minor+1}`}).catch(()=>l(`v${i.major}`));await u(n),await{premajor:async()=>{await a("push","-f","origin",`HEAD~1:refs/heads/release/v${e.version.major}/lts`)},preminor:async()=>{},patch:async i=>{await p(i),await m(i),await a("push","-f","origin",`HEAD:refs/tags/v${i}`),e.skipBaseBranchPush?console.log(`> skip pushing release commit to protected base branch ${e.baseRef}`):await a("push","-f","origin",`HEAD:refs/heads/${e.baseRef}`),await D(e,"prerelease"),await u(y(e.cwd))},prerelease:async()=>{await a("push","-f","origin",`HEAD~1:refs/tags/v${e.version}`)}}[t](n);let f=y(e.cwd),I=S(f),C=H.inc(f,"prepatch","alpha"),w=f.prerelease.length?f:C,{data:j}=await r.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`tags/v${I}-alpha`}),O=async i=>{if(console.log(`> merge ${e.repo}/v${I} into ${e.repo}/${i}`),$.dry)return;let{data:V}=await r.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`heads/${i}`}).catch(()=>r.rest.git.createRef({owner:e.owner,repo:e.repo,ref:`refs/heads/${i}`,sha:j.object.sha})),b=await r.rest.repos.merge({owner:e.owner,repo:e.repo,base:V.ref,head:j.object.sha,commit_message:`Update ${i} to work on ${w}`});if(b.status!==201&&b.status!==204)throw console.error(b),new Error(`Merge failed with status ${b.status}`)},W={premajor:["release","alpha","dev"],preminor:["release","alpha","dev"],patch:["alpha"],prerelease:["dev"]},A=`v${f.major}/v${f.major}.${f.minor}`;if(console.log(`${Q.EOL}# https://docs.github.com/en/rest/reference/repos#merge-a-branch${Q.EOL}`),e.skipChannelBranchMerge)console.log(`> skip merging version tag into protected channel branches: ${W[t].join(", ")}`);else for(let i of W[t])await O(`${i}/${A}`);if(t==="patch"){let i=`dev/${A}`,V=`alpha/${A}`,b=`origin/alpha/${A}`,ae=`release/v${f.major}/lerna-bump-patch`;await a("fetch"),await a("switch","-c",i,`origin/${i}`),await D(e,"prepatch","auto",!1),await a("commit","-a","-m",`Update ${i} to work on ${w}`),await a("fetch","origin",V),P(e.cwd)&&(await a("switch",i),await a("merge","--no-commit",ae)),await a("merge","--no-ff",b,"-m",`Merge ${b} into ${i}`),await a("push","origin",`HEAD:${i}`),await a("switch",e.baseRef)}await Z(e).catch(console.error),e.resetDefaultBranch?await te(e):console.log("> skip resetting default branch")}async function te(e){let t=B.getOctokit(e.token),o=await g(e,`
    query {
      repository(owner: "${e.owner}", name: "${e.repo}") {
        refs(refPrefix: "refs/heads/dev/", last: 1) {
          edges {
            node {
             name
            }
          }
        }
      }
    }`);if(typeof o.repository.refs.edges[0]>"u")return;let r="dev/"+o.repository.refs.edges[0].node.name;await t.request("PATCH /repos/{owner}/{repo}",{owner:e.owner,repo:e.repo,default_branch:r})}function fe(e){$.dry=e.dry}var d=()=>y(process.cwd()),k=e=>E(e.cwd,e.headRef,e.baseRef),F=e=>{P(e.cwd)&&M("lerna",["--version"],N).status!==0&&_("npm",["install","-g","lerna@^5.0.0"])},x=e=>D(e,E(e.cwd,e.headRef,e.baseRef)),U=async e=>{if(e.publish){process.env.NODE_AUTH_TOKEN=e.token;let t=E(e.cwd,e.headRef,e.baseRef);(t==="patch"||t==="prerelease")&&await pe(e)}},K=e=>he(e,E(e.cwd,e.headRef,e.baseRef,!0)),G=async e=>{let t=E(e.cwd,e.headRef,e.baseRef);if(!t)throw new Error(`No rule to bump for head/base refs: ${e.headRef} -> ${e.baseRef}`);let o=B.getOctokit(e.token);try{let s=await o.rest.actions.listWorkflowRuns({owner:e.owner,repo:e.repo,workflow_id:"release-verify.yml",branch:e.headRef,per_page:6});s.status===200&&console.log(`> workflow release-verify triggered by commit ${e.commitId}`);let r=s.data.workflow_runs;for(let n of r.slice(1)){let l=n.head_commit;n.head_sha!==e.commitId&&(console.debug(`> found workflow run #${n.run_number} with status [${n.status}] for commit ${n.head_sha}`),n.status!=="completed"&&(console.log(`> cancel workflow run #${n.run_number} committed by ${l.committer.name} with "${l.message}"`),await o.rest.actions.cancelWorkflowRun({owner:e.owner,repo:e.repo,run_id:n.id})))}}catch(s){console.error(s)}return t};import ne from"fs";import J from"path";import{fileURLToPath as me}from"url";import v from"semver";import*as c from"@actions/core";import*as h from"@actions/github";var de=me(import.meta.url),we=J.dirname(de);function ie(){let e=h.context.issue;return e.number?e.number:h.context.payload.pull_request.number}var be=async function(e){let t=h.context;if(t.eventName==="pull_request"){let o=h.getOctokit(e.token),{data:s}=await o.rest.pulls.get({owner:e.owner,repo:e.repo,pull_number:ie()});if((e.action==="auto"||e.action==="postbuild")&&!s.merged)throw new Error(`Pull request [${s.html_url}] must be merged to perform action ${e.action}`);e.pullRequest=s}if(t.eventName==="workflow_dispatch"&&(R(e.headRef)!=="main"||R(e.baseRef)!=="main"))throw new Error(`Manual trigger on head [${e.headRef}] -> base [${e.baseRef}] not supported`);await a("config","--global","user.name",e.actor),await a("config","--global","user.email",`${e.actor}@users.noreply.github.com`),F(e)},$e=async function(e){if(h.context.eventName==="pull_request"&&e.action==="verify"){let t=k(e),o=h.getOctokit(e.token),s={premajor:n=>`Prepare v${v.inc(n,"major")}`,preminor:n=>`Prepare v${v.inc(n,"minor")}`,patch:n=>`Release v${n.prerelease.length?v.inc(n,"patch"):n}`,prerelease:n=>`Prerelease v${n}`},r=`mutation {
                updatePullRequest(input: {
                    pullRequestId: "${e.pullRequest.node_id}"
                    title: "${s[t](d())}"
                }) { pullRequest { id } }
            }`;await o.graphql(r)}},se=async e=>{c.setOutput("prebuild-version",`v${d()}`),k(e)==="patch"&&await x(e),c.setOutput("version",`v${d()}`)},re=async e=>{await U(e),k(e)!=="patch"&&await x(e),await K(e),c.setOutput("postbuild-version",`v${d()}`)},ye=async e=>{let t=c.getInput("token"),o=process.env.GITHUB_HEAD_REF||h.context.ref,s=process.env.GITHUB_BASE_REF||h.context.ref;if(h.context.eventName==="pull_request"&&c.getInput("action")==="verify"){let r=h.context.repo,n=h.getOctokit(t),u=(await n.graphql(`
            query {
            repository(name: "${r.repo}", owner: "${r.owner}") {
                pullRequest(number: ${ie()}) { id }
            }
        }`)).repository.pullRequest.id,p=`Invalid Pull Request from ${o} to ${s} for version ${d()}: ${e.message}`;await n.graphql(`mutation{addComment(input:{subjectId:"${u}",body:"${p}"}){subject{id}}}`),await n.graphql(`mutation {updatePullRequest(input:{pullRequestId:"${u}", state:CLOSED}) {pullRequest{id}}}`)}},ge={auto:async e=>{await se(e),await re(e)},prebuild:se,postbuild:re,verify:G},Re=async function(){let e=h.context,t=process.env.GITHUB_HEAD_REF||e.ref,o=process.env.GITHUB_BASE_REF||e.ref,s={cwd:process.cwd(),owner:e.repo.owner,repo:e.repo.repo,actor:e.actor,token:c.getInput("token"),action:c.getInput("action"),publish:c.getInput("no-publish")==="false",protection:c.getInput("no-protection")==="false",protectDevBranches:c.getInput("protect-dev-branches")==="true",resetDefaultBranch:c.getInput("reset-default-branch")!=="false",skipBaseBranchPush:c.getInput("skip-base-branch-push")==="true",skipChannelBranchMerge:c.getInput("skip-channel-branch-merge")==="true",commitId:e.sha,headRef:t,baseRef:o,keyword:k({cwd:process.cwd(),headRef:t,baseRef:o}),version:d()};c.setOutput("keyword",s.keyword),await be(s),await ge[s.action](s),await $e(s)};if(process.env.GITHUB_ACTION){let e=J.join(J.dirname(we),"package.json"),t=ne.existsSync(e)?JSON.parse(ne.readFileSync(e)):{};t.name&&(process.env.GITHUB_ACTION_REPOSITORY===t.name.slice(1)||process.env.KUNGFU_ACTION_BUMP_VERSION_ALLOW_LOCAL==="true")&&Re().catch(o=>{console.error(o),c.setFailed(o.message),ye(o).catch(console.error)})}export{ge as actions,oe as lib,be as setup,$e as teardown};
