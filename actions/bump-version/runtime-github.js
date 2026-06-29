import fs from 'node:fs';

function readPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function readContext() {
  const payload = readPayload();
  const [owner = '', repo = ''] = (process.env.GITHUB_REPOSITORY || '').split('/');
  return {
    actor: process.env.GITHUB_ACTOR || '',
    eventName: process.env.GITHUB_EVENT_NAME || '',
    issue: {
      number: payload.issue?.number || payload.pull_request?.number,
    },
    payload,
    ref: process.env.GITHUB_REF || '',
    repo: { owner, repo },
    sha: process.env.GITHUB_SHA || '',
  };
}

export const context = readContext();

function apiBase() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
}

function graphqlUrl() {
  return process.env.GITHUB_GRAPHQL_URL || `${apiBase()}/graphql`;
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

function fillRoute(route, params) {
  return route.replace(/\{([^}]+)\}/g, (_, key) => encodePath(params[key]));
}

export function githubClient(token) {
  async function requestJson(method, route, params = {}) {
    const bodyKeys = new Set(Object.keys(params));
    const path = fillRoute(route, params);
    for (const key of route.matchAll(/\{([^}]+)\}/g)) {
      bodyKeys.delete(key[1]);
    }

    const search = new URLSearchParams();
    const body = {};
    for (const key of bodyKeys) {
      const value = params[key];
      if (value === undefined) {
        continue;
      }
      if (method === 'GET') {
        search.set(key, String(value));
      } else {
        body[key] = value;
      }
    }

    const url = `${apiBase()}${path}${search.size ? `?${search}` : ''}`;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: method === 'GET' || Object.keys(body).length === 0 ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${text}`);
    }
    return { data, headers: Object.fromEntries(response.headers.entries()), status: response.status, url };
  }

  return {
    async graphql(query, variables = {}) {
      const { headers: _headers, ...actualVariables } = variables || {};
      const response = await fetch(graphqlUrl(), {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables: actualVariables }),
      });
      const text = await response.text();
      const result = text ? JSON.parse(text) : {};
      if (!response.ok || result.errors) {
        throw new Error(`GitHub GraphQL failed with ${response.status}: ${text}`);
      }
      return result.data;
    },
    request(route, params = {}) {
      const [method, path] = route.split(/\s+/, 2);
      return requestJson(method, path, params);
    },
    rest: {
      actions: {
        cancelWorkflowRun(params) {
          return requestJson('POST', '/repos/{owner}/{repo}/actions/runs/{run_id}/cancel', params);
        },
        listWorkflowRuns(params) {
          return requestJson('GET', '/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', params);
        },
      },
      git: {
        createRef(params) {
          return requestJson('POST', '/repos/{owner}/{repo}/git/refs', params);
        },
        getRef(params) {
          return requestJson('GET', '/repos/{owner}/{repo}/git/ref/{ref}', params);
        },
      },
      pulls: {
        get(params) {
          return requestJson('GET', '/repos/{owner}/{repo}/pulls/{pull_number}', params);
        },
      },
      repos: {
        merge(params) {
          return requestJson('POST', '/repos/{owner}/{repo}/merges', params);
        },
      },
    },
  };
}
