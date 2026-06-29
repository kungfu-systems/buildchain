var A=(n,e)=>()=>(e||n((e={exports:{}}).exports,e),e.exports);var x=A((ie,E)=>{var p=require("fs"),l=require("path"),G=new Set(["pnpm","yarn","npm"]);function w(n){return p.existsSync(n)?JSON.parse(p.readFileSync(n,"utf8")):null}function N(n){let e=String(n||"").match(/^(pnpm|yarn|npm)(?:@|$)/);return e?e[1]:null}function $(n){if(!G.has(n))throw new Error(`Unsupported package manager: ${n}`);return n}function H(n=process.cwd()){let e=process.env.BUILDCHAIN_PACKAGE_MANAGER,o=N(e);if(e&&!o)throw new Error(`Unsupported package manager from BUILDCHAIN_PACKAGE_MANAGER: ${e}`);if(o)return{name:o,reason:"BUILDCHAIN_PACKAGE_MANAGER"};let s=w(l.join(n,"package.json")),r=N(s?.packageManager);if(r)return{name:r,reason:"packageManager",packageManager:s.packageManager};let t=[["pnpm","pnpm-lock.yaml"],["yarn","yarn.lock"],["npm","package-lock.json"],["npm","npm-shrinkwrap.json"]];for(let[c,a]of t)if(p.existsSync(l.join(n,a)))return{name:c,reason:"lockfile",lockfile:a};throw new Error("Unable to detect package manager. Add packageManager to package.json or commit a supported lockfile.")}function L(n,e){return $(n),n==="pnpm"?{cmd:"pnpm",args:["run",e]}:n==="npm"?{cmd:"npm",args:["run",e]}:{cmd:"yarn",args:["run",e]}}function U(n,e,o={}){$(n);let s=[];return n==="yarn"?s.push("version",`--${e}`):s.push("version",e),s.push(...o.preid?["--preid",o.preid]:[]),s.push(...o.message?["--message",o.message]:[]),s.push(...o.tag===!1?["--no-git-tag-version"]:[]),{cmd:n,args:s}}function h(n){return[n.cmd,...n.args].map(e=>{let o=String(e);return/^[A-Za-z0-9_./:@=+-]+$/.test(o)?o:JSON.stringify(o)}).join(" ")}function B(n,e="@kungfu-trader"){return $(n),n==="pnpm"?{primary:h({cmd:"pnpm",args:["update","--recursive","--filter",`${e}/*`,"--ignore-scripts"]}),fallback:"pnpm install --ignore-scripts --lockfile-only"}:n==="npm"?{primary:h({cmd:"npm",args:["update","--workspaces","--ignore-scripts"]}),fallback:"npm install --ignore-scripts --package-lock-only --dry-run"}:{primary:h({cmd:"yarn",args:["upgrade","--scope",e,"--ignore-scripts"]}),fallback:h({cmd:"yarn",args:["install","-scope",e,"--ignore-scripts","--force","--dry-run"]})}}function V(n){return n?Array.isArray(n.workspaces)?n.workspaces:Array.isArray(n.workspaces?.packages)?n.workspaces.packages:Array.isArray(n.packages)?n.packages:[]:[]}function K(n){let e=l.join(n,"pnpm-workspace.yaml");if(!p.existsSync(e))return[];let o=[],s=!1;for(let r of p.readFileSync(e,"utf8").split(/\r?\n/)){if(/^\s*packages\s*:\s*$/.test(r)){s=!0;continue}if(s&&/^\S/.test(r))break;let t=s&&r.match(/^\s*-\s*["']?([^"']+)["']?\s*$/);t&&o.push(t[1])}return o}function T(n,e){return l.relative(n,e).split(l.sep).join("/")}function z(n,e){if(!e||e.startsWith("!"))return[];let o=e.replace(/\/package\.json$/,""),s=o.split("/"),r=s.indexOf("*");if(r===-1){let i=l.join(n,o,"package.json");return p.existsSync(i)?[l.dirname(i)]:[]}let t=s.slice(0,r).join("/"),c=s.slice(r+1).join("/"),a=l.join(n,t);return p.existsSync(a)?p.readdirSync(a,{withFileTypes:!0}).filter(i=>i.isDirectory()).map(i=>l.join(a,i.name,c)).filter(i=>p.existsSync(l.join(i,"package.json"))):[]}function Y(n=process.cwd()){let e=w(l.join(n,"package.json")),o=w(l.join(n,"lerna.json")),s=[...V(e),...V(o),...K(n)],r={},t=new Set;for(let c of s)for(let a of z(n,c)){let i=T(n,a);if(t.has(i))continue;t.add(i);let k=w(l.join(a,"package.json"));k?.name&&(r[k.name]={location:i})}return r}function q(n=process.cwd()){for(let e of["pnpm-lock.yaml","yarn.lock","package-lock.json","npm-shrinkwrap.json"]){let o=l.join(n,e);if(p.existsSync(o))return{lockfile:e,filePath:o}}return null}function j(n,e,o){e&&o&&e.startsWith("@kungfu-trader/")&&n.set(e,o)}function I(n){if(!n)return;let e=new Map;for(let o of n.split(/\n(?=\S)/)){let r=(o.split(/\r?\n/,1)[0]||"").match(/@kungfu-trader\/([^@,\s:"]+)/),t=o.match(/^\s+version\s+"?([^"\s]+)"?/m);j(e,r&&`@kungfu-trader/${r[1]}`,t?.[1])}return e}function _(n){let e=new Map,o=/@kungfu-trader\/([^@\s:'")]+)@([^:\s'")]+)/g;for(let s of n.matchAll(o))j(e,`@kungfu-trader/${s[1]}`,s[2].split("(")[0]);return e}function M(n,e={}){for(let[o,s]of Object.entries(e||{}))j(n,o,s?.version),M(n,s?.dependencies)}function O(n){let e=JSON.parse(n),o=new Map;for(let[s,r]of Object.entries(e.packages||{})){let t=s.match(/node_modules\/(@kungfu-trader\/[^/]+)$/);j(o,t?.[1],r?.version)}return M(o,e.dependencies),o}function Z(n=process.cwd()){let e=q(n);if(!e)return;let o=p.readFileSync(e.filePath,"utf8");return e.lockfile==="yarn.lock"?I(o):e.lockfile==="pnpm-lock.yaml"?_(o):O(o)}E.exports={assertPackageManager:$,commandForKungfuUpgrade:B,commandForRunScript:L,commandForVersion:U,detectLockfile:q,detectPackageManager:H,getCurrentLockInfo:Z,getNpmLockInfo:O,getPnpmLockInfo:_,getWorkspaceInfo:Y,getYarnLockInfo:I,shellJoin:h}});var F=A(u=>{var P=require("@actions/github"),d=require("fs-extra"),f=require("path"),Q=require("git-client"),X=require("semver"),{spawnSync:le}=require("child_process"),{getWorkspaceInfo:ee}=x();async function g(...n){console.log("$ git",...n);let e=await Q(...n);return console.log(e),e}u.rollbackRelease=async function(n){let e=d.readJSONSync("package.json");console.log(`token:${n.token}`),console.log(e);try{await u.solveAllPackages(n)}catch(o){console.log(o)}};u.solveAllPackages=async function(n){let e=ee(process.cwd());if(Object.keys(e).length===0)throw new Error("No workspace packages found; configure package.json workspaces, lerna packages, or pnpm-workspace.yaml.");for(let o in e){console.log(`package path is: ${e[o].location}`);let s=process.cwd();console.log(`process path is: ${s}`);let r=f.join(s,e[o].location),t=f.join(r,"package.json");console.log(`Package.json path is: ${t}`);let c=JSON.parse(d.readFileSync(t)),a={names:c.name.split(["/"])[1],delVersion:c.version,npm_package:t,config:c};if(`${c.private}`===!0)console.log("Package set {'Private': true} will not be published, just skipping!");else{console.log(`--- Starting to delete package: ${a.names}(version:${a.delVersion}) ---`);try{await u.deletePublishedPackages(n,a)}catch(i){console.log(`[Warning!] Error on delete published package:
`,i)}}}await u.createNewPullRequest(e,n)};function ne(n){return d.existsSync(f.join(n,"lerna.json"))}function oe(n){let e=f.join(n,ne(n)?"lerna.json":"package.json"),o=JSON.parse(d.readFileSync(e));return X.parse(o.version)}u.createNewPullRequest=async function(n,e){let o=oe(process.cwd()),r=`dev/${`v${o.major}/v${o.major}.${o.minor}`}`;await g("fetch"),await g("switch",r),await g("pull");let t=P.getOctokit(e.token),c=await t.graphql(`
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
    }`),a=c.repository.pullRequests.nodes[0].number,i=c.repository.url,k=c.repository.id,y=c.repository.pullRequests.nodes[0].title,J=await g("rev-parse","HEAD"),D=e.owner+"/"+e.repo;console.log(`---------The branch now is pointing to ${J}`),console.log(`---------RepositoryNameWithOwner: ${D}`);for(let b in n){console.log(`
package path is: ${n[b].location}`);let S=process.cwd();console.log(`process path is: ${S}
`);let W=f.join(S,n[b].location),R=f.join(W,"package.json"),m=JSON.parse(d.readFileSync(R)),v={names:m.name.split(["/"])[1],delVersion:m.version,npm_package:R,config:m};m.repository||(m.repository={url:`${i}.git`},d.writeFileSync(v.npm_package,JSON.stringify(v.config,null,2)))}await g("add","."),await g("commit","-m","creat new pr"),await g("push","origin",`HEAD:${r}`),console.log(`---Merged pr [${y}](pr number:[${a}]) failed. Creating a new open PR...`),console.log(`repo id:[${k}]`),console.log(`baseRef:[${e.baseRef}]`),console.log(`headRef:[${e.headRef}]`),console.log(`New pr title:[${y}]`);let ae=await t.graphql(`
    mutation {
      createPullRequest(input: {repositoryId: "${k}", baseRefName: "${e.baseRef}", headRefName: "${e.headRef}", title: "${y}"}) {
        clientMutationId
      }
    }`);console.log(`New pr has created, which is:[${y}](${e.headRef}--->${e.baseRef});`)};u.deletePublishedPackage=async function(n,e){let o=P.getOctokit(n.token),s=1,r=await o.graphql(`
    query {
      repository(name: "${n.repo}", owner: "${n.owner}") {
        packages(names: "${e.names}", first: ${s}) {
          edges {
            node {
              name
              versions(first:${s}) {
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
    }`),t=0,c=r.repository.packages.edges[t].node.versions.edges[t].node.id,a=r.repository.packages.edges[t].node.versions.edges[t].node.version;if(console.log(`| Version [${e.delVersion}] needs to be deleted |`),console.log(`| Version [${a}] has found |`),e.delVersion==a){let i=await o.graphql(`
      mutation {
        deletePackageVersion(input: {packageVersionId: "${c}"}) {
          success
        }
      }`,{headers:{accept:"application/vnd.github.package-deletes-preview+json"}});console.log(`[Sucess!] Already has deleted package [${e.names}] with version [${e.delVersion}]
`)}else console.log(`[Notice!] Package [${e.names}] with version [${e.delVersion}] didn't be published, earlier version [${a}] exists now.

`)};u.deletePublishedPackages=async function(n,e){let o=P.getOctokit(n.token),s=await o.rest.packages.getAllPackageVersionsForPackageOwnedByOrg({package_type:"npm",package_name:e.names,org:"kungfu-trader"});if(packageVersion=s.data[0].name,console.log(`| Version [${e.delVersion}] needs to be deleted |`),console.log(`| Version [${packageVersion}] has found |`),e.delVersion==packageVersion){let r=await o.rest.packages.deletePackageVersionForOrg({package_type:"npm",package_name:e.names,org:"kungfu-trader",package_version_id:s.data[0].id});console.log(`[Sucess!] Already has deleted package [${e.names}] with version [${e.delVersion}]
`)}else console.log(`[Notice!] Package [${e.names}] with version [${e.delVersion}] didn't be published, earlier version [${packageVersion}] exists now.

`)}});var se=exports.lib=F(),C=require("@actions/core"),re=require("@actions/github"),te=async function(){let n=re.context,e=process.env.GITHUB_HEAD_REF||n.ref,o=process.env.GITHUB_BASE_REF||n.ref,s={token:C.getInput("token"),owner:n.repo.owner,repo:n.repo.repo,headRef:e,baseRef:o};await se.rollbackRelease(s)};require.main===module&&te().catch(n=>{console.log("test"),console.error(n),C.setFailed(n.message)});
