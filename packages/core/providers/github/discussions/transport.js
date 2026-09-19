const fields =
  "id number url body author { __typename login ... on Node { id } } lastEditedAt repository { nameWithOwner }";
const commentFields =
  "id url body author { __typename login ... on Node { id } } lastEditedAt replyTo { id }";

export function discussionTransport(graphql) {
  async function request(query, variables) {
    try {
      return await graphql(query, variables);
    } catch (error) {
      const code =
        error.errors?.[0]?.extensions?.code ||
        error.errors?.[0]?.type ||
        error.status ||
        "unknown";
      error.code = `discussion-provider-${String(code).replace(/[^a-zA-Z0-9-]/gu, "-")}`;
      throw error;
    }
  }
  async function repository(repository) {
    const [owner, name] = repository.split("/");
    const result = await request(
      `
        query ($owner: String!, $name: String!) {
          viewer {
            login
            id
          }
          repository(owner: $owner, name: $name) {
            id
            hasDiscussionsEnabled
            discussionCategories(first: 25) {
              nodes {
                id
                name
                slug
              }
            }
          }
        }
      `,
      { owner, name },
    );
    if (!result.repository?.hasDiscussionsEnabled)
      throw new Error(
        `Enable Discussions in ${repository} before release execution`,
      );
    return { ...result.repository, viewer: result.viewer };
  }
  async function list(repository, categoryId, after = null) {
    const [owner, name] = repository.split("/");
    const result = await request(
      `query($owner:String!,$name:String!,$category:ID!,$after:String){repository(owner:$owner,name:$name){discussions(first:100,after:$after,categoryId:$category,orderBy:{field:CREATED_AT,direction:ASC}){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}`,
      { owner, name, category: categoryId, after },
    );
    return result.repository.discussions;
  }
  async function get(id) {
    const result = await request(
      `query($id:ID!){node(id:$id){... on Discussion{${fields}}}}`,
      { id },
    );
    if (!result.node?.repository)
      throw new Error("Release Discussion was not found");
    return result.node;
  }
  async function comments(id, after = null) {
    const result = await request(
      `query($id:ID!,$after:String){node(id:$id){... on Discussion{comments(first:100,after:$after){nodes{${commentFields} replies{totalCount}} pageInfo{hasNextPage endCursor}}}}}`,
      { id, after },
    );
    if (!result.node?.comments)
      throw new Error("Release Discussion comments are unavailable");
    return result.node.comments;
  }
  async function replies(id, after = null) {
    const result = await request(
      `query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{replies(first:100,after:$after){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}}}}`,
      { id, after },
    );
    if (!result.node?.replies)
      throw new Error("Release Discussion replies are unavailable");
    return result.node.replies;
  }
  async function create({ repositoryId, categoryId, title, body }) {
    const result = await request(
      `mutation($input:CreateDiscussionInput!){createDiscussion(input:$input){discussion{${fields}}}}`,
      { input: { repositoryId, categoryId, title, body } },
    );
    return result.createDiscussion.discussion;
  }
  async function append(id, body, replyToId = null) {
    const result = await request(
      `mutation($input:AddDiscussionCommentInput!){addDiscussionComment(input:$input){comment{${commentFields}}}}`,
      {
        input: { discussionId: id, body, ...(replyToId ? { replyToId } : {}) },
      },
    );
    return result.addDiscussionComment.comment;
  }
  return { repository, list, get, comments, replies, create, append };
}

export async function collectDiscussionPages(readPage, limit = 100) {
  let cursor = null;
  const nodes = [];
  const cursors = new Set();
  for (let page = 0; page < limit; page++) {
    const result = await readPage(cursor);
    if (!Array.isArray(result?.nodes) || !result.pageInfo)
      throw new Error("Incomplete Discussion page");
    nodes.push(...result.nodes);
    if (Buffer.byteLength(JSON.stringify(nodes)) > 32 * 1024 * 1024)
      throw new Error(
        "Discussion read exceeds its byte bound; refusing an incomplete view",
      );
    if (!result.pageInfo.hasNextPage) return nodes;
    cursor = result.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("Discussion pagination did not advance");
    cursors.add(cursor);
  }
  throw new Error(
    "Discussion page limit exceeded; refusing an incomplete transaction view",
  );
}
