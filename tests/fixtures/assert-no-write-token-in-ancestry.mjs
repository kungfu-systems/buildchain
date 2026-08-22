#!/usr/bin/env node
import { assertCredentiallessProcessAncestry } from "../../packages/core/dev-delivery-process-boundary.js";

assertCredentiallessProcessAncestry();
process.stdout.write("write-token-ancestry=clear\n");
