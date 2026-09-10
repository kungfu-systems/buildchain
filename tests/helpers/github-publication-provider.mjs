import crypto from "node:crypto";
export function fakeGitHub() {
  const state = {
    release: null,
    assets: [],
    refs: new Map(),
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    documents: new Map(),
    mutations: 0,
    releaseRequests: [],
    uploads: [],
  };
  const missing = () =>
    Promise.reject(Object.assign(new Error("missing"), { status: 404 }));
  const materialize = (ref, sha) => {
    const tree = state.trees.get(state.commits.get(sha));
    for (const entry of tree || []) {
      state.documents.set(`${ref}:${entry.path}`, state.blobs.get(entry.sha));
    }
  };
  return {
    state,
    octokit: {
      rest: {
        repos: {
          getReleaseByTag: () =>
            state.release
              ? Promise.resolve({ data: state.release })
              : missing(),
          listReleaseAssets: () => Promise.resolve({ data: state.assets }),
          createRelease: (request) => {
            state.releaseRequests.push(request);
            state.release = { id: 1, html_url: "https://example.test/release" };
            state.mutations += 1;
            return Promise.resolve({ data: state.release });
          },
          uploadReleaseAsset: ({ name, data }) => {
            state.uploads.push(name);
            state.assets.push({
              name,
              digest: `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`,
            });
            return Promise.resolve({ data: state.assets.at(-1) });
          },
          getContent: ({ ref, path: file }) =>
            state.documents.has(`${ref}:${file}`)
              ? Promise.resolve({
                  data: {
                    type: "file",
                    content: Buffer.from(
                      JSON.stringify(state.documents.get(`${ref}:${file}`)),
                    ).toString("base64"),
                  },
                })
              : missing(),
        },
        git: {
          getRef: ({ ref }) =>
            state.refs.has(ref)
              ? Promise.resolve({
                  data: { object: { sha: state.refs.get(ref) } },
                })
              : missing(),
          getCommit: ({ commit_sha: sha }) =>
            Promise.resolve({
              data: { tree: { sha: state.commits.get(sha) } },
            }),
          createBlob: ({ content }) => {
            const sha = `blob-${state.blobs.size}`;
            state.blobs.set(sha, JSON.parse(content));
            return Promise.resolve({ data: { sha } });
          },
          createTree: ({ tree }) => {
            const sha = `tree-${state.trees.size}`;
            state.trees.set(sha, tree);
            return Promise.resolve({ data: { sha } });
          },
          createCommit: ({ tree }) => {
            const sha = `commit-${state.commits.size}`;
            state.commits.set(sha, tree);
            return Promise.resolve({ data: { sha } });
          },
          createRef: ({ ref, sha }) => {
            const key = ref.replace(/^refs\//u, "");
            state.refs.set(key, sha);
            materialize(key.replace(/^heads\//u, ""), sha);
            state.mutations += 1;
            return Promise.resolve({});
          },
          updateRef: ({ ref, sha }) => {
            state.refs.set(ref, sha);
            materialize(ref.replace(/^heads\//u, ""), sha);
            state.mutations += 1;
            return Promise.resolve({});
          },
        },
      },
    },
  };
}
