export const RUNNER_PRESETS = Object.freeze({
  "github-hosted": [
    {
      id: "linux-x64",
      name: "Linux x64",
      platform: "linux",
      runner: '["ubuntu-24.04"]',
      capabilities: ["node"],
    },
    {
      id: "macos",
      name: "macOS",
      platform: "macos",
      runner: '["macos-latest"]',
      capabilities: ["node"],
    },
    {
      id: "windows-x64",
      name: "Windows x64",
      platform: "windows",
      runner: '["windows-2022"]',
      capabilities: ["node"],
    },
  ],
  "kungfu-v4-self-hosted": [
    {
      id: "linux-x64",
      name: "Linux x64",
      platform: "linux",
      runner: '["self-hosted","Linux","X64","kungfu-build-v4-linux-x64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
    {
      id: "macos-arm64",
      name: "macOS ARM64",
      platform: "macos",
      runner: '["self-hosted","macOS","ARM64","kungfu-build-v4-macos-arm64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
    {
      id: "windows-x64",
      name: "Windows x64",
      platform: "windows",
      runner: '["self-hosted","Windows","X64","kungfu-build-v4-windows-x64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
  ],
  "kungfu-v4-native": [
    {
      id: "linux-x64",
      name: "Linux x64",
      platform: "linux",
      runner: '["self-hosted","Linux","X64","kungfu-build-v4-linux-x64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
    {
      id: "linux-arm64",
      name: "Linux ARM64",
      platform: "linux",
      runner: '["ubuntu-24.04-arm"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
    {
      id: "macos-arm64",
      name: "macOS ARM64",
      platform: "macos",
      runner: '["self-hosted","macOS","ARM64","kungfu-build-v4-macos-arm64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
    {
      id: "windows-x64",
      name: "Windows x64",
      platform: "windows",
      runner: '["self-hosted","Windows","X64","kungfu-build-v4-windows-x64"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
  ],
  "aws-us-codebuild-linux": [
    {
      id: "linux-x64",
      name: "Linux x64 (AWS CodeBuild burst)",
      platform: "linux",
      provider: "aws-codebuild",
      runner: '["aws-codebuild-dynamic"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
  ],
  "aws-us-ec2-windows-jit": [
    {
      id: "windows-x64",
      name: "Windows x64 (AWS EC2 one-job JIT)",
      platform: "windows",
      provider: "aws-ec2-windows-jit",
      runner: '["self-hosted","Windows","X64","aws-ec2-jit-dynamic"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
  ],
  "aws-us-ec2-macos-jit": [
    {
      id: "macos-arm64",
      name: "macOS ARM64 (AWS EC2 Dedicated Host one-job JIT)",
      platform: "macos",
      provider: "aws-ec2-macos-jit",
      runner: '["self-hosted","macOS","ARM64","aws-ec2-jit-dynamic"]',
      capabilities: ["node", "native-toolchain", "product-artifacts", "rust"],
    },
  ],
});

export const LINUX_CONTAINER_PRESETS = Object.freeze({
  "kungfu-verify": {
    image:
      "ghcr.io/kungfu-systems/build-images/kungfu-verify@sha256:11f0ba64267ce88174a4f73a9bf833ff4e9c59cd16ec3d08a6432a06c2be6fb1",
  },
});
