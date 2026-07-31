import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTED_RUNNER_FALLBACKS,
  resolveOfflineRunnerFallback,
  routeOfflineRunners,
} from "../scripts/route-offline-runners.mjs";
import { resolveRunnerMatrix } from "../scripts/build-contract-core.mjs";

const labelObjects = (labels) => labels.map((name) => ({ name }));

test("every offline Kungfu self-hosted lane routes independently to GitHub-hosted", () => {
  const base = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  const routed = routeOfflineRunners({
    platforms: base.platforms,
    runners: [],
  });
  assert.equal(routed.fallbackCount, 3);
  assert.deepEqual(
    routed.platforms.map((platform) => [platform.id, platform.runner]),
    [
      ["linux-x64", HOSTED_RUNNER_FALLBACKS["linux-x64"]],
      ["linux-arm64", '["ubuntu-24.04-arm"]'],
      ["macos-arm64", HOSTED_RUNNER_FALLBACKS["macos-arm64"]],
      ["windows-x64", HOSTED_RUNNER_FALLBACKS["windows-x64"]],
    ],
  );
});

test("online busy is not offline and only the unavailable lane falls back", () => {
  const base = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  const linux = JSON.parse(base.platforms[0].runner);
  const windows = JSON.parse(base.platforms[3].runner);
  const routed = routeOfflineRunners({
    platforms: base.platforms,
    runners: [
      { status: "online", busy: true, labels: labelObjects(linux) },
      { status: "online", busy: false, labels: labelObjects(windows) },
    ],
  });
  assert.equal(routed.fallbackCount, 1);
  assert.equal(routed.platforms[0].runner, base.platforms[0].runner);
  assert.equal(
    routed.platforms[2].runner,
    HOSTED_RUNNER_FALLBACKS["macos-arm64"],
  );
  assert.equal(routed.platforms[3].runner, base.platforms[3].runner);
});

test("missing permission fails closed to the declared self-hosted matrix", async () => {
  const base = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  const resolved = await resolveOfflineRunnerFallback({
    runnerPreset: "kungfu-v4-native",
    repository: "kungfu-systems/kungfu",
    token: "fixture-token",
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.equal(resolved.fallbackCount, 0);
  assert.equal(resolved.platformsJson, base.platformsJson);
  assert.equal(resolved.routing.status, "unavailable");
  assert.equal(resolved.routing.reason, "runner-inventory-unavailable");
});

test("runner inventory pagination preserves exact-label observations", async () => {
  const base = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  const macos = JSON.parse(base.platforms[2].runner);
  let requests = 0;
  const requestedUrls = [];
  const resolved = await resolveOfflineRunnerFallback({
    runnerPreset: "kungfu-v4-native",
    repository: "kungfu-systems/kungfu",
    token: "fixture-token",
    fetchImpl: async (url) => {
      requests += 1;
      requestedUrls.push(url);
      return {
        ok: true,
        async json() {
          if (requests === 1) {
            return {
              owner: { login: "kungfu-systems", type: "Organization" },
            };
          }
          return {
            runners:
              requests === 2
                ? Array.from({ length: 100 }, () => ({
                    status: "offline",
                    busy: false,
                    labels: [],
                  }))
                : [
                    {
                      status: "online",
                      busy: false,
                      labels: labelObjects(macos),
                    },
                  ],
          };
        },
      };
    },
  });
  assert.equal(requests, 3);
  assert.match(requestedUrls[0], /\/repos\/kungfu-systems\/kungfu$/);
  assert.match(requestedUrls[1], /\/orgs\/kungfu-systems\/actions\/runners\?/);
  assert.equal(resolved.fallbackCount, 2);
  assert.equal(resolved.routing.inventoryScope, "organization");
  assert.equal(
    JSON.parse(resolved.platformsJson)[2].runner,
    base.platforms[2].runner,
  );
});

test("organization runner inventory prevents false offline fallback", async () => {
  const base = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-native" });
  const windows = JSON.parse(base.platforms[3].runner);
  const requestedUrls = [];
  const resolved = await resolveOfflineRunnerFallback({
    runnerPreset: "kungfu-v4-native",
    repository: "kungfu-systems/kungfu",
    token: "fixture-token",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        async json() {
          if (requestedUrls.length === 1) {
            return {
              owner: { login: "kungfu-systems", type: "Organization" },
            };
          }
          return {
            runners: [
              {
                status: "online",
                busy: false,
                labels: labelObjects(windows),
              },
            ],
          };
        },
      };
    },
  });
  assert.equal(resolved.fallbackCount, 2);
  assert.equal(resolved.routing.inventoryScope, "organization");
  assert.equal(
    JSON.parse(resolved.platformsJson)[3].runner,
    base.platforms[3].runner,
  );
  assert.ok(
    requestedUrls.every(
      (url) => !url.includes("/repos/kungfu-systems/kungfu/actions/runners"),
    ),
  );
});
