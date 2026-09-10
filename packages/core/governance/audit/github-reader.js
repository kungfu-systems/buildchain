import { spawnSync } from "node:child_process";
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];
export function createGovernanceReader(token) {
  function githubApi(route, label) {
    return command(
      token,
      "gh",
      [
        "api",
        route,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ],
      label,
    );
  }

  function readCodeowners(repository, ref) {
    const attempts = CODEOWNERS_PATHS.map((candidatePath) => {
      const encoded = candidatePath
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return {
        path: candidatePath,
        result: githubApi(
          `repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
          `${repository} ${candidatePath}`,
        ),
      };
    });
    const found = attempts.find((attempt) => attempt.result.ok);
    return {
      path: found?.path || "",
      source: found ? decodeContent(found.result) : "",
      readable: attempts.every((attempt) => resolvedAbsence(attempt.result)),
      attempts: attempts.map((attempt) => ({
        path: attempt.path,
        status: attempt.result.ok ? "present" : attempt.result.reason,
      })),
    };
  }

  function readRulesets(repository) {
    const listing = githubApi(
      `repos/${repository}/rulesets?includes_parents=true&per_page=100`,
      `${repository} rulesets`,
    );
    if (!listing.ok) {
      return {
        readable: listing.reason === "not-found",
        listing,
        rulesets: [],
      };
    }
    const rulesets = [];
    let readable = true;
    for (const entry of Array.isArray(listing.data) ? listing.data : []) {
      if (!entry?.id) continue;
      const detail = githubApi(
        `repos/${repository}/rulesets/${entry.id}`,
        `${repository} ruleset ${entry.id}`,
      );
      readable = readable && detail.ok;
      if (detail.ok) rulesets.push(detail.data);
    }
    return { readable, listing, rulesets };
  }

  function readBranchNames(repository) {
    const names = [];
    for (let page = 1; page <= 20; page += 1) {
      const response = githubApi(
        `repos/${repository}/branches?per_page=100&page=${page}`,
        `${repository} branches page ${page}`,
      );
      if (!response.ok) {
        return { readable: false, result: response, names: [] };
      }
      const entries = Array.isArray(response.data) ? response.data : [];
      names.push(
        ...entries.map((entry) => String(entry?.name || "")).filter(Boolean),
      );
      if (entries.length < 100) {
        return {
          readable: true,
          result: response,
          names: [...new Set(names)].sort(),
        };
      }
    }
    return {
      readable: false,
      result: {
        ok: false,
        reason: "pagination-limit",
      },
      names: [],
    };
  }

  function readOrganizationRepositories(organization) {
    const repositories = [];
    for (let page = 1; page <= 20; page += 1) {
      const response = githubApi(
        `orgs/${organization}/repos?per_page=100&type=all&page=${page}`,
        `managed repositories page ${page}`,
      );
      if (!response.ok) {
        return { readable: false, result: response, repositories: [] };
      }
      const entries = Array.isArray(response.data) ? response.data : [];
      repositories.push(...entries);
      if (entries.length < 100) {
        return {
          readable: true,
          result: response,
          repositories,
        };
      }
    }
    return {
      readable: false,
      result: {
        ok: false,
        reason: "pagination-limit",
      },
      repositories: [],
    };
  }

  return {
    githubApi,
    readCodeowners,
    readRulesets,
    readBranchNames,
    readOrganizationRepositories,
    resolvedAbsence,
  };
}

function command(token, commandName, commandArgs, label) {
  const result = spawnSync(commandName, commandArgs, {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      GH_TOKEN: token || "",
      GITHUB_TOKEN: token || "",
    },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const statusMatch = output.match(/\b(?:HTTP|status:?)\s*(\d{3})\b/i);
  const status = Number(statusMatch?.[1] || (result.status === 0 ? 200 : 0));
  if (result.status !== 0) {
    return {
      ok: false,
      status,
      reason: /401|unauthorized/i.test(output)
        ? "unauthorized"
        : /403|forbidden/i.test(output)
          ? "forbidden"
          : /404|not found/i.test(output)
            ? "not-found"
            : "unavailable",
      label,
      data: null,
    };
  }
  try {
    return {
      ok: true,
      status,
      reason: "read",
      label,
      data: JSON.parse(result.stdout),
    };
  } catch {
    return {
      ok: false,
      status,
      reason: "invalid-json",
      label,
      data: null,
    };
  }
}

function resolvedAbsence(result) {
  return result.ok || result.reason === "not-found";
}

function decodeContent(result) {
  if (!result.ok) return "";
  return Buffer.from(String(result.data?.content || ""), "base64").toString(
    "utf8",
  );
}
