var v=(o,e)=>()=>(e||o((e={exports:{}}).exports,e),e.exports);var b=v(r=>{var w=require("@actions/github"),u=require("fs-extra"),k=require("path"),S=require("git-client"),j=require("semver"),{spawnSync:N}=require("child_process"),_={shell:!0,stdio:"pipe",windowsHide:!0};async function p(...o){console.log("$ git",...o);let e=await S(...o);return console.log(e),e}r.rollbackRelease=async function(o){let e=u.readJSONSync("package.json");console.log(`token:${o.token}`),console.log(e);try{await r.solveAllPackages(o)}catch(s){console.log(s)}};r.solveAllPackages=async function(o){let s=N("yarn",["-s","workspaces","info"],_).output.filter(t=>t&&t.length>0).toString(),n=JSON.parse(s);for(let t in n){console.log(`package path is: ${n[t].location}`);let a=process.cwd();console.log(`process path is: ${a}`);let i=k.join(a,n[t].location),c=k.join(i,"package.json");console.log(`Package.json path is: ${c}`);let l=JSON.parse(u.readFileSync(c)),g={names:l.name.split(["/"])[1],delVersion:l.version,npm_package:c,config:l};if(`${l.private}`===!0)console.log("Package set {'Private': true} will not be published, just skipping!");else{console.log(`--- Starting to delete package: ${g.names}(version:${g.delVersion}) ---`);try{await r.deletePublishedPackages(o,g)}catch(d){console.log(`[Warning!] Error on delete published package:
`,d)}}}await r.createNewPullRequest(n,o)};function O(o){return u.existsSync(k.join(o,"lerna.json"))}function I(o){let e=k.join(o,O(o)?"lerna.json":"package.json"),s=JSON.parse(u.readFileSync(e));return j.parse(s.version)}r.createNewPullRequest=async function(o,e){let s=I(process.cwd()),t=`dev/${`v${s.major}/v${s.major}.${s.minor}`}`;await p("fetch"),await p("switch",t),await p("pull");let a=w.getOctokit(e.token),i=await a.graphql(`
    query {
      repository(name: "${e.repo}", owner: "${e.owner}") {
        id
        url
        pullRequests(last: 1, states: MERGED) {
          nodes {
            id
            state
            number
            title
          }
        }
      }
    }`),c=i.repository.pullRequests.nodes[0].number,l=i.repository.url,g=i.repository.id,d=i.repository.pullRequests.nodes[0].title,P=await p("rev-parse","HEAD"),V=e.owner+"/"+e.repo;console.log(`---------The branch now is pointing to ${P}`),console.log(`---------RepositoryNameWithOwner: ${V}`);for(let $ in o){console.log(`
package path is: ${o[$].location}`);let m=process.cwd();console.log(`process path is: ${m}
`);let q=k.join(m,o[$].location),f=k.join(q,"package.json"),h=JSON.parse(u.readFileSync(f)),y={names:h.name.split(["/"])[1],delVersion:h.version,npm_package:f,config:h};h.repository||(h.repository={url:`${l}.git`},u.writeFileSync(y.npm_package,JSON.stringify(y.config,null,2)))}await p("add","."),await p("commit","-m","creat new pr"),await p("push","origin",`HEAD:${t}`),console.log(`---Merged pr [${d}](pr number:[${c}]) failed. Creating a new open PR...`),console.log(`repo id:[${g}]`),console.log(`baseRef:[${e.baseRef}]`),console.log(`headRef:[${e.headRef}]`),console.log(`New pr title:[${d}]`);let J=await a.graphql(`
    mutation {
      createPullRequest(input: {repositoryId: "${g}", baseRefName: "${e.baseRef}", headRefName: "${e.headRef}", title: "${d}"}) {
        clientMutationId
      }
    }`);console.log(`New pr has created, which is:[${d}](${e.headRef}--->${e.baseRef});`)};r.deletePublishedPackage=async function(o,e){let s=w.getOctokit(o.token),n=1,t=await s.graphql(`
    query {
      repository(name: "${o.repo}", owner: "${o.owner}") {
        packages(names: "${e.names}", first: ${n}) {
          edges {
            node {
              name
              versions(first:${n}) {
                edges {
                  node {
                    id
                    version
                  }
                }
              }
            }
          }
        }
      }
    }`),a=0,i=t.repository.packages.edges[a].node.versions.edges[a].node.id,c=t.repository.packages.edges[a].node.versions.edges[a].node.version;if(console.log(`| Version [${e.delVersion}] needs to be deleted |`),console.log(`| Version [${c}] has found |`),e.delVersion==c){let l=await s.graphql(`
      mutation {
        deletePackageVersion(input: {packageVersionId: "${i}"}) {
          success
        }
      }`,{headers:{accept:"application/vnd.github.package-deletes-preview+json"}});console.log(`[Sucess!] Already has deleted package [${e.names}] with version [${e.delVersion}] 
`)}else console.log(`[Notice!] Package [${e.names}] with version [${e.delVersion}] didn't be published, earlier version [${c}] exists now.

`)};r.deletePublishedPackages=async function(o,e){let s=w.getOctokit(o.token),n=await s.rest.packages.getAllPackageVersionsForPackageOwnedByOrg({package_type:"npm",package_name:e.names,org:"kungfu-trader"});if(packageVersion=n.data[0].name,console.log(`| Version [${e.delVersion}] needs to be deleted |`),console.log(`| Version [${packageVersion}] has found |`),e.delVersion==packageVersion){let t=await s.rest.packages.deletePackageVersionForOrg({package_type:"npm",package_name:e.names,org:"kungfu-trader",package_version_id:n.data[0].id});console.log(`[Sucess!] Already has deleted package [${e.names}] with version [${e.delVersion}] 
`)}else console.log(`[Notice!] Package [${e.names}] with version [${e.delVersion}] didn't be published, earlier version [${packageVersion}] exists now.

`)}});var A=exports.lib=b(),R=require("@actions/core"),E=require("@actions/github"),F=async function(){let o=E.context,e=process.env.GITHUB_HEAD_REF||o.ref,s=process.env.GITHUB_BASE_REF||o.ref,n={token:R.getInput("token"),owner:o.repo.owner,repo:o.repo.repo,headRef:e,baseRef:s};await A.rollbackRelease(n)};require.main===module&&F().catch(o=>{console.log("test"),console.error(o),R.setFailed(o.message)});
