import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("macOS credential-island fixture requires macOS");
}

const appName = "Buildchain Credential Island.app";
const appRoot = path.join(process.cwd(), "dist", appName);
const contents = path.join(appRoot, "Contents");
const executableDirectory = path.join(contents, "MacOS");
const executable = path.join(executableDirectory, "BuildchainCredentialIsland");
fs.mkdirSync(executableDirectory, { recursive: true });

const compile = spawnSync(
  "/usr/bin/clang",
  [
    "-mmacosx-version-min=11.0",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    path.join(process.cwd(), "src", "main.c"),
    "-o",
    executable,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (compile.error || compile.status !== 0) {
  throw (
    compile.error ||
    new Error(
      `clang failed with status ${compile.status}: ${(compile.stderr || compile.stdout || "").trim()}`,
    )
  );
}

fs.writeFileSync(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>BuildchainCredentialIsland</string>
  <key>CFBundleIdentifier</key>
  <string>dev.libkungfu.buildchain.credential-island</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Buildchain Credential Island</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
`,
);
