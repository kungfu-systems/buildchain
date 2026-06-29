var he=Object.defineProperty;var fe=(e,t)=>{for(var o in t)he(e,o,{get:t[o],enumerable:!0})};var ae={};fe(ae,{currentVersion:()=>b,ensureBranchesProtection:()=>ne,ensureLerna:()=>H,exec:()=>O,getBumpKeyword:()=>q,getChannel:()=>C,gitCall:()=>i,resetDefaultBranch:()=>se,setOpts:()=>$e,suspendBranchesProtection:()=>re,tryBump:()=>N,tryMerge:()=>K,tryPublish:()=>U,verify:()=>G});import*as _ from"@actions/github";import D from"fs";import X from"os";import T from"path";import Z from"git-client";import F from"semver";import{spawnSync as ee}from"child_process";import{createRequire as me}from"module";var de=me(import.meta.url),m=de("./package-manager.cjs"),Ee=m.assertPackageManager,xe=m.commandForKungfuUpgrade,je=m.commandForRunScript,Q=m.commandForVersion,Ae=m.detectLockfile,Y=m.detectPackageManager,Le=m.getCurrentLockInfo,Te=m.getNpmLockInfo,Ne=m.getPnpmLockInfo,z=m.getWorkspaceInfo,Se=m.getYarnLockInfo,Ve=m.shellJoin;var te=["main","release/*/*","alpha/*/*","dev/*/*"],y={dry:!1},M={shell:!0,stdio:"pipe",windowsHide:!0};function B(e){return D.existsSync(T.join(e,"lerna.json"))}function k(e){let t=T.join(e,B(e)?"lerna.json":"package.json"),o=JSON.parse(D.readFileSync(t));return F.parse(o.version)}function L(e){return`${e.major}.${e.minor}`}function C(e){return e.replace(/^refs\/heads\//,"").split("/")[0]}function E(e,t,o,r=!1){let s=k(e),n=Number(L(s)),l=n-.1,u=C(t),h=C(o),d=`${u}->${h}`,w={"dev->alpha":"prerelease","alpha->release":"patch","release->main":"preminor","release->release":"preminor","main->main":"premajor"},f=h==="release"&&o.split("/").pop()==="lts",x=u==="release"&&(h==="main"||f);if(t.replace(u,"")!==o.replace(h,"")&&!x)throw new Error(`Versions not match for head/base refs: ${t} -> ${o}`);if(u==="main")return w[d];let I=t.match(/(\w+)\/v(\d+)\/v(\d+\.\d)/),g=`The version of head ref ${t} does not match current ${s}`;if(!I)throw new Error(g);let j=Number(I[2]),P=Number(I[3]);if(j!==s.major||P>n)throw new Error(g);if(P<l)throw new Error(g);if(P===l&&!r)throw new Error(g);return w[d]}function O(e,t=[],o=M){if(console.log("$",e,...t),y.dry)return;let r=ee(e,t,o),s=r.output.filter(n=>n&&n.length>0).toString();if(console.log(s),r.status!==0)throw new Error(`Failed with status ${r.status}`)}async function i(...e){if(console.log("$ git",...e),y.dry)return;let t=await Z(...e);console.log(t)}async function we(e){if(y.dry){console.log(`$ git tag -d ${e} # if local tag exists`);return}try{await Z("rev-parse","--verify",`refs/tags/${e}`)}catch{return}await i("tag","-d",e)}async function R(e,t){return await _.getOctokit(e.token).graphql(t,{headers:{Connection:"close"}})}async function V(e,t,o,r=!0){let s=k(e.cwd),n=F.inc(s,t,"alpha"),l=["--message",o?`"${o}"`:`"Move on to v${n}"`],u=t==="patch"?[]:l,h=r?[]:["--no-git-tag-version"];if(r&&await we(`v${n}`),B(e.cwd)){if(t==="patch"||t==="prepatch"){let f=`release/v${s.major}/lerna-bump-patch`;await i("switch","-C",f,"HEAD")}let d=t==="prerelease"&&!o?["--force-publish"]:[],w=["--yes","--no-push",...u,...h,...d];O("lerna",["version",`${t}`,...w])}else{let d=Y(e.cwd).name,w=Q(d,t,{preid:"alpha",message:u[1],tag:r});O(w.cmd,w.args)}}async function be(e){let t=o=>{let r=JSON.parse(D.readFileSync(T.join(o,"package.json")));if(r.private)console.log(`> bypass private package ${r.name}`);else{let s={cwd:o,...M};O("npm",["publish"],s)}};if(B(e.cwd)){console.log("> detected lerna, use package-manager workspace metadata for npm publish");let o=z(e.cwd);if(Object.keys(o).length>0)for(let r in o)t(T.join(e.cwd,o[r].location));else throw new Error("Found lerna.json without package workspace metadata, please configure workspaces/packages.")}else console.log("> use npm publish"),t(e.cwd)}async function oe(e){let t={},{repository:o}=await R(e,`query{repository(name:"${e.repo}",owner:"${e.owner}"){id}}`),r=await R(e,`
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
        }`);for(let s of r.repository.branchProtectionRules.nodes)t[s.pattern]=s.id;for(let s of te.filter(n=>!(n in t))){console.log(`> creating protection rule for branch name pattern ${s}`);let{createBranchProtectionRule:n}=await R(e,`
      mutation {
        createBranchProtectionRule(input: {
          repositoryId: "${o.id}"
          pattern: "${s}"
        }) {
          branchProtectionRule { id }
        }
      }
    `);t[s]=n.branchProtectionRule.id}return t}async function ne(e){if(!e.protection)return;let t=await oe(e);for(let o in t){let r=t[o],s=o.split("/")[0]!=="dev",n=s||e.protectDevBranches,l=o.split("/")[0]==="release",h=`
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${r}"
          requiresApprovingReviews: ${n},
          requiredApprovingReviewCount: ${n?1:0},
          dismissesStaleReviews: true,
          restrictsReviewDismissals: true,
          requiresStatusChecks: true,
          requiresCodeOwnerReviews: ${l},
          requiredStatusCheckContexts: ${s?'["verify"]':"[]"},
          requiresStrictStatusChecks: true,
          requiresConversationResolution: true,
          isAdminEnforced: true,
          restrictsPushes: ${n},
          allowsForcePushes: false,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;if(console.log(`> ensure protection for branch name pattern ${o}`),y.dry){console.log(h);continue}await R(e,h)}}async function re(e,t=te){if(!e.protection)return;let o=await oe(e);for(let r of t){let n=`
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${o[r]}"
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
    `;if(console.log(`> suspend protection for branch name pattern ${r}`),y.dry){console.log(n);continue}await R(e,n)}}async function ge(e,t){let r={premajor:["release","alpha","dev"],preminor:["release","alpha","dev"],patch:["release","alpha","dev"],prerelease:["dev"]}[t].map(a=>`${a}/*/*`);await re(e,r).catch(console.error);let s=_.getOctokit(e.token),n=k(e.cwd),l=a=>i("push","-f","origin",`HEAD:refs/tags/${a}`),u=a=>l(`v${L(a)}-alpha`),h=a=>l(`v${L(a)}`),d=a=>s.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`tags/v${a.major}.${a.minor+1}`}).catch(()=>l(`v${a.major}`));await u(n),await{premajor:async()=>{await i("push","-f","origin",`HEAD~1:refs/heads/release/v${e.version.major}/lts`)},preminor:async()=>{},patch:async a=>{await h(a),await d(a),await i("push","-f","origin",`HEAD:refs/tags/v${a}`),e.skipBaseBranchPush?console.log(`> skip pushing release commit to protected base branch ${e.baseRef}`):await i("push","-f","origin",`HEAD:refs/heads/${e.baseRef}`),await V(e,"prerelease"),await u(k(e.cwd))},prerelease:async()=>{await i("push","-f","origin",`HEAD~1:refs/tags/v${e.version}`)}}[t](n);let f=k(e.cwd),x=L(f),I=F.inc(f,"prepatch","alpha"),g=f.prerelease.length?f:I,{data:j}=await s.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`tags/v${x}-alpha`}),P=async a=>{if(console.log(`> merge ${e.repo}/v${x} into ${e.repo}/${a}`),y.dry)return;let{data:S}=await s.rest.git.getRef({owner:e.owner,repo:e.repo,ref:`heads/${a}`}).catch(()=>s.rest.git.createRef({owner:e.owner,repo:e.repo,ref:`refs/heads/${a}`,sha:j.object.sha})),$=await s.rest.repos.merge({owner:e.owner,repo:e.repo,base:S.ref,head:j.object.sha,commit_message:`Update ${a} to work on ${g}`});if($.status!==201&&$.status!==204)throw console.error($),new Error(`Merge failed with status ${$.status}`)},v={premajor:["release","alpha","dev"],preminor:["release","alpha","dev"],patch:["alpha"],prerelease:["dev"]},A=`v${f.major}/v${f.major}.${f.minor}`;if(console.log(`${X.EOL}# https://docs.github.com/en/rest/reference/repos#merge-a-branch${X.EOL}`),e.skipChannelBranchMerge)console.log(`> skip merging version tag into protected channel branches: ${v[t].join(", ")}`);else for(let a of v[t])await P(`${a}/${A}`);if(t==="patch"){let a=`dev/${A}`,S=`alpha/${A}`,$=`origin/alpha/${A}`,pe=`release/v${f.major}/lerna-bump-patch`;await i("fetch"),await i("switch","-c",a,`origin/${a}`),await V(e,"prepatch","auto",!1),await i("commit","-a","-m",`Update ${a} to work on ${g}`),await i("fetch","origin",S),B(e.cwd)&&(await i("switch",a),await i("merge","--no-commit",pe)),await i("merge","--no-ff",$,"-m",`Merge ${$} into ${a}`),await i("push","origin",`HEAD:${a}`),await i("switch",e.baseRef)}await ne(e).catch(console.error),e.resetDefaultBranch?await se(e):console.log("> skip resetting default branch")}async function se(e){let t=_.getOctokit(e.token),o=await R(e,`
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
    }`);if(typeof o.repository.refs.edges[0]>"u")return;let s="dev/"+o.repository.refs.edges[0].node.name;await t.request("PATCH /repos/{owner}/{repo}",{owner:e.owner,repo:e.repo,default_branch:s})}function $e(e){y.dry=e.dry}var b=()=>k(process.cwd()),q=e=>E(e.cwd,e.headRef,e.baseRef),H=e=>{B(e.cwd)&&ee("lerna",["--version"],M).status!==0&&O("npm",["install","-g","lerna@^5.0.0"])},N=e=>V(e,E(e.cwd,e.headRef,e.baseRef)),U=async e=>{if(e.publish){process.env.NODE_AUTH_TOKEN=e.token;let t=E(e.cwd,e.headRef,e.baseRef);(t==="patch"||t==="prerelease")&&await be(e)}},K=e=>ge(e,E(e.cwd,e.headRef,e.baseRef,!0)),G=async e=>{let t=E(e.cwd,e.headRef,e.baseRef);if(!t)throw new Error(`No rule to bump for head/base refs: ${e.headRef} -> ${e.baseRef}`);let o=_.getOctokit(e.token);try{let r=await o.rest.actions.listWorkflowRuns({owner:e.owner,repo:e.repo,workflow_id:"release-verify.yml",branch:e.headRef,per_page:6});r.status===200&&console.log(`> workflow release-verify triggered by commit ${e.commitId}`);let s=r.data.workflow_runs;for(let n of s.slice(1)){let l=n.head_commit;n.head_sha!==e.commitId&&(console.debug(`> found workflow run #${n.run_number} with status [${n.status}] for commit ${n.head_sha}`),n.status!=="completed"&&(console.log(`> cancel workflow run #${n.run_number} committed by ${l.committer.name} with "${l.message}"`),await o.rest.actions.cancelWorkflowRun({owner:e.owner,repo:e.repo,run_id:n.id})))}}catch(r){console.error(r)}return t};import ie from"fs";import J from"path";import{fileURLToPath as ye}from"url";import W from"semver";import*as c from"@actions/core";import*as p from"@actions/github";var ke=ye(import.meta.url),Re=J.dirname(ke);function ue(){let e=p.context.issue;return e.number?e.number:p.context.payload.pull_request.number}var Ce=async function(e){let t=p.context;if(t.eventName==="pull_request"){let o=p.getOctokit(e.token),{data:r}=await o.rest.pulls.get({owner:e.owner,repo:e.repo,pull_number:ue()});if((e.action==="auto"||e.action==="postbuild")&&!r.merged)throw new Error(`Pull request [${r.html_url}] must be merged to perform action ${e.action}`);e.pullRequest=r}if(t.eventName==="workflow_dispatch"&&(C(e.headRef)!=="main"||C(e.baseRef)!=="main"))throw new Error(`Manual trigger on head [${e.headRef}] -> base [${e.baseRef}] not supported`);await i("config","--global","user.name",e.actor),await i("config","--global","user.email",`${e.actor}@users.noreply.github.com`),H(e)},qe=async function(e){if(p.context.eventName==="pull_request"&&e.action==="verify"){let t=q(e),o=p.getOctokit(e.token),r={premajor:n=>`Prepare v${W.inc(n,"major")}`,preminor:n=>`Prepare v${W.inc(n,"minor")}`,patch:n=>`Release v${n.prerelease.length?W.inc(n,"patch"):n}`,prerelease:n=>`Prerelease v${n}`},s=`mutation {
                updatePullRequest(input: {
                    pullRequestId: "${e.pullRequest.node_id}"
                    title: "${r[t](b())}"
                }) { pullRequest { id } }
            }`;await o.graphql(s)}},ce=async e=>{c.setOutput("prebuild-version",`v${b()}`),q(e)==="patch"&&await N(e),c.setOutput("version",`v${b()}`)},le=async e=>{await U(e),q(e)!=="patch"&&await N(e),await K(e),c.setOutput("postbuild-version",`v${b()}`)},Ie=async e=>{let t=c.getInput("token"),o=process.env.GITHUB_HEAD_REF||p.context.ref,r=process.env.GITHUB_BASE_REF||p.context.ref;if(p.context.eventName==="pull_request"&&c.getInput("action")==="verify"){let s=p.context.repo,n=p.getOctokit(t),u=(await n.graphql(`
            query {
            repository(name: "${s.repo}", owner: "${s.owner}") {
                pullRequest(number: ${ue()}) { id }
            }
        }`)).repository.pullRequest.id,h=`Invalid Pull Request from ${o} to ${r} for version ${b()}: ${e.message}`;await n.graphql(`mutation{addComment(input:{subjectId:"${u}",body:"${h}"}){subject{id}}}`),await n.graphql(`mutation {updatePullRequest(input:{pullRequestId:"${u}", state:CLOSED}) {pullRequest{id}}}`)}},Pe={auto:async e=>{await ce(e),await le(e)},prebuild:ce,postbuild:le,verify:G},Oe=async function(){let e=p.context,t=process.env.GITHUB_HEAD_REF||e.ref,o=process.env.GITHUB_BASE_REF||e.ref,r={cwd:process.cwd(),owner:e.repo.owner,repo:e.repo.repo,actor:e.actor,token:c.getInput("token"),action:c.getInput("action"),publish:c.getInput("no-publish")==="false",protection:c.getInput("no-protection")==="false",protectDevBranches:c.getInput("protect-dev-branches")==="true",resetDefaultBranch:c.getInput("reset-default-branch")!=="false",skipBaseBranchPush:c.getInput("skip-base-branch-push")==="true",skipChannelBranchMerge:c.getInput("skip-channel-branch-merge")==="true",commitId:e.sha,headRef:t,baseRef:o,keyword:q({cwd:process.cwd(),headRef:t,baseRef:o}),version:b()};c.setOutput("keyword",r.keyword),await Ce(r),await Pe[r.action](r),await qe(r)};if(process.env.GITHUB_ACTION){let e=J.join(J.dirname(Re),"package.json"),t=ie.existsSync(e)?JSON.parse(ie.readFileSync(e)):{};t.name&&(process.env.GITHUB_ACTION_REPOSITORY===t.name.slice(1)||process.env.KUNGFU_ACTION_BUMP_VERSION_ALLOW_LOCAL==="true")&&Oe().catch(o=>{console.error(o),c.setFailed(o.message),Ie(o).catch(console.error)})}export{Pe as actions,ae as lib,Ce as setup,qe as teardown};
