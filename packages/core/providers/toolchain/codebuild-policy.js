export const AWS_CODEBUILD_TOOLCHAIN = Object.freeze({
  schema: "buildchain.aws-codebuild-native-toolchain/v1",
  gccPackages: ["gcc14", "gcc14-c++"],
  gcc: "gcc14-gcc",
  gxx: "gcc14-g++",
  compilerProfiles: Object.freeze({
    amazonLinux2023: Object.freeze({
      packageManager: "dnf",
      packages: ["gcc14", "gcc14-c++"],
      gcc: "gcc14-gcc",
      gxx: "gcc14-g++",
    }),
    ubuntu2404: Object.freeze({
      packageManager: "apt-get",
      packages: ["gcc-14", "g++-14"],
      gcc: "gcc-14",
      gxx: "g++-14",
    }),
  }),
  cmakeVersion: "3.31.6",
  cmakeArchive: "cmake-3.31.6-linux-x86_64.tar.gz",
  cmakeSha256:
    "5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf",
  cmakeBaseUrl: "https://github.com/Kitware/CMake/releases/download/v3.31.6",
});

export function selectAwsCodeBuildCompiler({
  hasDnf = false,
  hasAptGet = false,
} = {}) {
  if (hasDnf) return AWS_CODEBUILD_TOOLCHAIN.compilerProfiles.amazonLinux2023;
  if (hasAptGet) return AWS_CODEBUILD_TOOLCHAIN.compilerProfiles.ubuntu2404;
  throw new Error(
    "AWS CodeBuild toolchain requires a supported package manager (dnf or apt-get)",
  );
}
