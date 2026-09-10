#!/usr/bin/env node
import { sealMacosCredentialInput } from "../credential/seal-input.js";
try { const result = sealMacosCredentialInput({ workspace: process.cwd(), app: process.env.BUILDCHAIN_CREDENTIAL_ISLAND_APP_PATH, repository: process.env.BUILDCHAIN_SOURCE_REPOSITORY, sourceSha: process.env.BUILDCHAIN_SOURCE_SHA, sourceTreeSha: process.env.BUILDCHAIN_SOURCE_TREE_SHA, platformId: process.env.BUILDCHAIN_PLATFORM_ID, outputRoot: process.env.BUILDCHAIN_CREDENTIAL_ISLAND_OUTPUT }); console.log(JSON.stringify(result)); }
catch (error) { console.error(`::error::${String(error.message).replaceAll("\n", "%0A")}`); process.exitCode = error.status || 1; }
