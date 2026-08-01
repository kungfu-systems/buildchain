function executePaperNpmBootstrap(options = {}, runtime) {
  const {
    DEFAULT_BOOTSTRAP_VERSION,
    NPM_REGISTRY,
    PAPER_NPM_BOOTSTRAP_CONTRACT,
    PAPER_PATHS,
    bootstrapPackageShape,
    commandResult,
    expectedPaperTrustedPublisher,
    extractUrls,
    fs,
    jsonText,
    liveNpmAuthObservation,
    liveNpmPackageObservation,
    liveNpmTrustObservation,
    normalizePackageName,
    normalizeRepository,
    os,
    paperConfig,
    path,
    resolvePaperRepository,
    safeParseJson,
    toPosix,
    validatePaperProvisioningAuthority,
    writePaperReceipt,
  } = runtime;
  const {
    cwd = process.cwd(),
    packageName = "",
    bootstrapVersion = DEFAULT_BOOTSTRAP_VERSION,
    registry = NPM_REGISTRY,
    repository = "",
    workflow = "paper-release.yml",
    environment = "",
    execute = false,
    confirmedPackage = "",
    userconfig = "",
    offline = false,
  } = options;
  const resolvedCwd = path.resolve(cwd);
  if (registry !== NPM_REGISTRY) {
    throw new Error(
      `paper npm bootstrap requires the official registry ${NPM_REGISTRY}`,
    );
  }
  if (bootstrapVersion !== DEFAULT_BOOTSTRAP_VERSION) {
    throw new Error(
      `paper npm bootstrap version is fixed at ${DEFAULT_BOOTSTRAP_VERSION}`,
    );
  }
  const configResult = paperConfig(resolvedCwd);
  if (configResult.error) throw new Error(configResult.error);
  const name = normalizePackageName(
    packageName ||
      configResult.loaded.config.publish?.package ||
      configResult.loaded.config.publish?.mainPackage,
  );
  const repo = normalizeRepository(
    repository || resolvePaperRepository(resolvedCwd),
  );
  const provisioning = validatePaperProvisioningAuthority(resolvedCwd);
  if (!provisioning.valid) {
    throw new Error(
      `paper npm bootstrap requires a valid provisioning authority: ${provisioning.errors.join("; ")}`,
    );
  }
  const expectedPublisher = expectedPaperTrustedPublisher(provisioning.value);
  if (
    provisioning.value.package?.name !== name ||
    expectedPublisher.repository !== repo ||
    expectedPublisher.workflow !== toPosix(workflow).replace(/^\/+/, "") ||
    expectedPublisher.environment !== String(environment || "")
  ) {
    throw new Error(
      "paper npm bootstrap coordinates differ from the exact provisioning authority",
    );
  }
  if (execute && confirmedPackage !== name) {
    throw new Error(
      `real npm bootstrap requires --confirm-public-package ${name}`,
    );
  }
  if (execute && offline) {
    throw new Error("real npm bootstrap cannot run with --offline");
  }
  if (execute && (!repo || !workflow)) {
    throw new Error(
      "real npm bootstrap requires GitHub repository and workflow coordinates",
    );
  }
  const packageObservation = offline
    ? {
        status: "unknown",
        exists: null,
        version: "",
        registry,
        errorCode: "offline",
      }
    : liveNpmPackageObservation(name, registry, resolvedCwd);
  const auth = offline
    ? {
        status: "unknown",
        authenticated: null,
        identity: "",
        errorCode: "offline",
      }
    : liveNpmAuthObservation(registry, resolvedCwd);
  const plan = {
    schemaVersion: 1,
    contract: PAPER_NPM_BOOTSTRAP_CONTRACT,
    ok: true,
    dryRun: !execute,
    externalMutation: execute,
    package: {
      name,
      bootstrapVersion,
      registry,
      existsBefore: packageObservation.exists,
      observedVersion: packageObservation.version,
    },
    repository: {
      github: repo,
      workflow,
      environment,
    },
    authority: {
      digest: provisioning.value.authorityDigest,
      policyDigest: provisioning.value.policy.policyDigest,
    },
    auth: {
      authenticated: auth.authenticated,
      identity: auth.identity,
      errorCode: auth.errorCode,
    },
    publish: {
      status: packageObservation.exists === true ? "existing" : "planned",
      distTag: "bootstrap",
      access: "public",
    },
    trust: {
      status: "planned",
      urls: [],
    },
    receipts: [],
    nextActions: execute
      ? []
      : [
          {
            id: "confirm-public-bootstrap",
            command: `buildchain paper bootstrap npm --execute --confirm-public-package ${name} --json`,
            description:
              "After reviewing this dry-run, bootstrap the exact public package and configure GitHub Trusted Publishing.",
          },
        ],
  };
  if (!execute) {
    const dryRunRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "buildchain-paper-bootstrap-dry-run-"),
    );
    try {
      fs.writeFileSync(
        path.join(dryRunRoot, "package.json"),
        jsonText(
          bootstrapPackageShape({
            packageName: name,
            version: bootstrapVersion,
          }),
        ),
      );
      const configArgs = userconfig ? ["--userconfig", userconfig] : [];
      const pack = commandResult(
        "npm",
        [
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: dryRunRoot },
      );
      const publish = commandResult(
        "npm",
        [
          "publish",
          "--dry-run",
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "bootstrap",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: dryRunRoot },
      );
      return {
        ...plan,
        ok: pack.ok && publish.ok,
        errorCode: !pack.ok
          ? "npm-pack-dry-run-failed"
          : !publish.ok
            ? "npm-publish-dry-run-failed"
            : "",
        dryRunChecks: {
          minimalPackageOnly: true,
          pack: {
            status: pack.ok ? "pass" : "fail",
            entryCount: (() => {
              const parsed = safeParseJson(pack.stdout);
              const value = Array.isArray(parsed) ? parsed[0] : parsed;
              return Array.isArray(value?.files) ? value.files.length : 0;
            })(),
          },
          publish: {
            status: publish.ok ? "pass" : "fail",
            registry,
            access: "public",
            distTag: "bootstrap",
          },
        },
      };
    } finally {
      fs.rmSync(dryRunRoot, { recursive: true, force: true });
    }
  }
  if (packageObservation.exists === null) {
    return {
      ...plan,
      ok: false,
      errorCode: "npm-package-status-unknown",
      publish: {
        ...plan.publish,
        status: "blocked",
      },
      trust: {
        status: "blocked",
        urls: [],
      },
      nextActions: [
        {
          id: "verify-npm-package",
          command: `npm view ${name} version --json --registry=${registry}`,
          description:
            "Resolve whether the exact public package exists before any publish mutation.",
        },
      ],
    };
  }
  if (auth.authenticated !== true) {
    return {
      ...plan,
      ok: false,
      errorCode: "npm-auth-required",
      publish: {
        ...plan.publish,
        status: "blocked",
      },
      trust: {
        status: "blocked",
        urls: [],
      },
      nextActions: [
        {
          id: "authenticate-npm",
          command: `npm whoami --registry=${registry}`,
          description:
            "Authenticate npm without sharing token contents, then rerun the exact bootstrap command.",
        },
      ],
    };
  }
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-paper-bootstrap-"),
  );
  try {
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      jsonText(
        bootstrapPackageShape({ packageName: name, version: bootstrapVersion }),
      ),
    );
    const configArgs = userconfig ? ["--userconfig", userconfig] : [];
    const pack = commandResult(
      "npm",
      [
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        `--registry=${registry}`,
        ...configArgs,
      ],
      { cwd: tempRoot },
    );
    if (!pack.ok) {
      return {
        ...plan,
        ok: false,
        errorCode: "npm-pack-dry-run-failed",
        publish: { ...plan.publish, status: "blocked" },
        trust: { status: "blocked", urls: [] },
      };
    }
    const publishDryRun = commandResult(
      "npm",
      [
        "publish",
        "--dry-run",
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        "bootstrap",
        `--registry=${registry}`,
        ...configArgs,
      ],
      { cwd: tempRoot },
    );
    if (!publishDryRun.ok) {
      return {
        ...plan,
        ok: false,
        errorCode: "npm-publish-dry-run-failed",
        publish: { ...plan.publish, status: "blocked" },
        trust: { status: "blocked", urls: [] },
      };
    }
    let publishStatus =
      packageObservation.exists === true ? "existing" : "published";
    if (packageObservation.exists !== true) {
      const published = commandResult(
        "npm",
        [
          "publish",
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "bootstrap",
          `--registry=${registry}`,
          ...configArgs,
        ],
        { cwd: tempRoot, timeout: 60000 },
      );
      if (!published.ok) {
        const failure = {
          ...plan,
          ok: false,
          errorCode: "npm-publish-failed",
          publish: { ...plan.publish, status: "failed" },
          trust: { status: "blocked", urls: [] },
        };
        failure.receipts = [
          writePaperReceipt(resolvedCwd, PAPER_PATHS.npmBootstrap, failure),
        ];
        return failure;
      }
    }
    const trustArgs = [
      "trust",
      "github",
      name,
      "--repo",
      repo,
      "--file",
      workflow,
      ...(environment ? ["--env", environment] : []),
      "--allow-publish",
      "--yes",
      "--json",
      `--registry=${registry}`,
      ...configArgs,
    ];
    const trustCommand = commandResult("npm", trustArgs, {
      cwd: resolvedCwd,
      timeout: 60000,
    });
    const parsedTrust = safeParseJson(trustCommand.stdout);
    const urls = [
      ...extractUrls(
        parsedTrust || `${trustCommand.stdout}\n${trustCommand.stderr}`,
      ),
    ];
    const trustList =
      trustCommand.ok && urls.length === 0
        ? liveNpmTrustObservation(
            name,
            registry,
            resolvedCwd,
            expectedPublisher,
          )
        : {
            status: "unknown",
            configured: null,
            publishers: [],
            errorCode:
              urls.length > 0 ? "web-action-required" : "npm-trust-failed",
          };
    const trustStatus =
      trustCommand.ok && trustList.configured === true
        ? "configured"
        : urls.length > 0
          ? "action-required"
          : "failed";
    const packageAfter = liveNpmPackageObservation(name, registry, resolvedCwd);
    const packageVerified = packageAfter.exists === true;
    const receipt = {
      ...plan,
      ok: trustStatus !== "failed" && packageVerified,
      dryRun: false,
      externalMutation: true,
      errorCode:
        trustStatus === "failed"
          ? "npm-trust-failed"
          : packageVerified
            ? ""
            : "npm-package-readback-failed",
      package: {
        ...plan.package,
        existsAfter: packageAfter.exists,
        observedVersionAfter: packageAfter.version,
        readbackStatus: packageAfter.status,
      },
      publish: {
        ...plan.publish,
        status: publishStatus,
      },
      trust: {
        status: trustStatus,
        urls,
        expectedPublisher,
        exactBinding: trustList.exactBinding === true,
        publishers: trustList.publishers,
      },
      nextActions:
        trustStatus === "configured" && packageVerified
          ? [
              {
                id: "paper-preflight",
                command: "buildchain paper preflight --json",
                description:
                  "Verify package existence and Trusted Publisher binding from live read-only sources.",
              },
            ]
          : trustStatus === "action-required" && packageVerified
            ? [
                {
                  id: "complete-npm-web-action",
                  command: "",
                  description:
                    "Open the exact npm URL returned below, complete the web step, then rerun preflight.",
                  urls,
                },
              ]
            : !packageVerified
              ? [
                  {
                    id: "verify-npm-package-readback",
                    command: `npm view ${name} version --json --registry=${registry}`,
                    description:
                      "The mutation returned but the official registry did not prove package existence; do not infer success.",
                  },
                ]
              : [
                  {
                    id: "retry-npm-trust",
                    command: `buildchain paper bootstrap npm --execute --confirm-public-package ${name} --json`,
                    description:
                      "The package exists; retry only the idempotent Trusted Publisher configuration path.",
                  },
                ],
    };
    receipt.receipts = [
      writePaperReceipt(resolvedCwd, PAPER_PATHS.npmBootstrap, receipt),
    ];
    if (
      packageVerified &&
      (trustStatus === "configured" || trustStatus === "action-required")
    ) {
      receipt.receipts.push(
        writePaperReceipt(resolvedCwd, PAPER_PATHS.npmTrust, receipt),
      );
    }
    return receipt;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export { executePaperNpmBootstrap };
