#!/usr/bin/env node
import { lockedSourceCheckout } from "../source-checkout/transaction.js";
const env = (name, fallback = "") => process.env[name] || fallback;
try {
  const evidence = lockedSourceCheckout({ workspace: process.cwd(), checkoutPath: env("BUILDCHAIN_SOURCE_CHECKOUT_PATH", "."), repository: env("BUILDCHAIN_SOURCE_REPOSITORY", env("GITHUB_REPOSITORY")), sourceSha: env("BUILDCHAIN_SOURCE_SHA"), sourceTreeSha: env("BUILDCHAIN_SOURCE_TREE_SHA"), fetchRef: env("BUILDCHAIN_SOURCE_REF", env("GITHUB_REF")), mode: env("BUILDCHAIN_CHECKOUT_CACHE_MODE", "off"), mirrorUrlTemplate: env("BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE"), referenceRepositoryTemplate: env("BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE"), fallback: env("BUILDCHAIN_CHECKOUT_CACHE_FALLBACK", "github"), timeoutSeconds: Number(env("BUILDCHAIN_CHECKOUT_CACHE_TIMEOUT_SECONDS", "60")), githubTimeoutSeconds: Number(env("BUILDCHAIN_CHECKOUT_CACHE_GITHUB_TIMEOUT_SECONDS", "600")), fetchAttempts: Number(env("BUILDCHAIN_CHECKOUT_CACHE_FETCH_ATTEMPTS", "3")), diagnosticsPath: env("BUILDCHAIN_SOURCE_CHECKOUT_DIAGNOSTICS_PATH", ".buildchain/diagnostics/source-checkout.json"), githubToken: env("GITHUB_TOKEN"), githubServerUrl: env("GITHUB_SERVER_URL", "https://github.com"), historyMode: env("BUILDCHAIN_CHECKOUT_HISTORY_MODE", "shallow"), environment: process.env });
  console.log(`locked-source-checkout=${evidence.cache.hit ? "cache-hit" : evidence.cache.fallbackUsed ? "fallback" : "github"}`);
  console.log(`locked-source-checkout-sha=${evidence.verification.head}`);
  console.log(`locked-source-checkout-tree=${evidence.verification.tree}`);
} catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
