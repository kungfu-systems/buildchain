var h=(e,t)=>()=>(t||e((t={exports:{}}).exports,t),t.exports);var a=h(c=>{var{Octokit:u}=require("@octokit/rest"),l=require("@actions/github");c.approveAndMerge=async function(e){let t=await q(e);if(!t){console.error("empty ruleId for alpha!");return}if(!await d(e)){console.log("Not labeled batch_upgrade_alpha!");return}await s(e,!1,t),await w(e),await s(e,!0,t)};var d=async function(e){let t=new u({auth:e.token});try{console.log("owner",e.owner,"repo",e.repo,"pullRequest",e.pullRequestNumber);let o=await t.request(`GET /repos/kungfu-trader/${e.repo}/pulls/${e.pullRequestNumber}`,{owner:"kungfu-trader",repo:e.repo,pull_number:e.pullRequestNumber,headers:{"X-GitHub-Api-Version":"2022-11-28"}});console.log("labels:",o.data.labels);for(let r of o.data.labels)if(r.name=="batch_upgrade_alpha")return!0}catch(o){console.error(o)}return!1};async function q(e){let t="";try{let r=await l.getOctokit(e.token).graphql(`
          query {
            repository(name: "${e.repo}", owner: "kungfu-trader") {
              branchProtectionRules(first:100) {
                nodes {
                  id
                  pattern
                }
              }
            }
          }`);for(let n of r.repository.branchProtectionRules.nodes)n.pattern=="alpha/*/*"&&(t=n.id)}catch(o){console.error(o)}return t}var s=async function(e,t,o){let r=l.getOctokit(e.token),p=`
      mutation {
        updateBranchProtectionRule(input: {
          branchProtectionRuleId: "${o}"
          requiresApprovingReviews: ${t},
          requiredApprovingReviewCount: 1,
          dismissesStaleReviews: ${t},
          restrictsReviewDismissals: ${t},
          requiresStatusChecks: ${t},
          requiresCodeOwnerReviews: false,
          requiredStatusCheckContexts: ["verify"],
          requiresStrictStatusChecks: ${t},
          requiresConversationResolution: ${t},
          isAdminEnforced: true,
          restrictsPushes: false,
          allowsForcePushes: false,
          allowsDeletions: false
        }) { clientMutationId }
      }
    `;await r.graphql(p)},w=async function(e){let t=new u({auth:e.token});try{let o=await t.request(`PUT /repos/kungfu-trader/${e.repo}/pulls/${e.pullRequestNumber}/merge`,{owner:"kungfu-trader",repo:e.repo,pull_number:"PULL_NUMBER",headers:{"X-GitHub-Api-Version":"2022-11-28"}});console.log("pull request",e.pullRequestNumber,"merge success!")}catch(o){console.error(o)}}});var b=exports.lib=a(),i=require("@actions/core"),f=require("@actions/github"),k=async function(){let e=f.context,t=e.payload.pull_request.number,o={token:i.getInput("token"),owner:e.payload.repository.owner.login,repo:e.payload.repository.name,pullRequestNumber:t};o.token&&await b.approveAndMerge(o)};require.main===module&&k().catch(e=>{console.error(e),i.setFailed(e.message)});
