import { pipelineNpmProvider } from "../../packages/core/publication/npm/pipeline-provider.js";

export function publicationApplyProvider(host) {
  const state = {
    tag: null,
    release: null,
    assets: [],
    writes: [],
    failAsset: true,
    npmIntegrity: null,
  };
  const repos = {
    listReleases: "releases",
    listReleaseAssets: "assets",
    createRelease: async (input) => {
      state.writes.push("release");
      state.release = { id: 7, ...input };
    },
    uploadReleaseAsset: async (input) => {
      if (state.failAsset) throw new Error("publication upload unavailable");
      state.writes.push(input.name);
      state.assets.push({
        id: state.assets.length + 1,
        name: input.name,
        size: input.data.length,
        bytes: Buffer.from(input.data),
      });
      throw new Error("asset response lost after successful upload");
    },
    getReleaseAsset: async ({ asset_id }) => ({
      data: state.assets.find(({ id }) => id === asset_id).bytes,
    }),
    updateRelease: async (input) => {
      state.writes.push("visibility");
      state.release.draft = input.draft;
    },
  };
  host.github = {
    rest: { repos },
    paginate: async (method, _args, map) => {
      const data =
        method === "releases"
          ? state.release
            ? [state.release]
            : []
          : state.assets;
      return map ? map({ data }) : data;
    },
  };
  const request = host.request;
  host.request = async (url, options = {}) => {
    if (url.endsWith("/git/refs") && options.method === "POST") {
      state.writes.push("tag");
      state.tag = {
        ref: options.body.ref,
        object: { type: "commit", sha: options.body.sha },
      };
      throw new Error("tag response lost after successful write");
    }
    if (url.includes("/git/ref/tags/")) return state.tag;
    return request(url, options);
  };
  const npmProvider = (input) =>
    pipelineNpmProvider({
      ...input,
      lookup: () => state.npmIntegrity || undefined,
      run: () => {
        state.writes.push("npm");
        state.npmIntegrity = input.artifacts[0].package.integrity;
        return { status: 0 };
      },
    });
  return { state, npmProvider };
}
