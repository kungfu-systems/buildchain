import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageManager = require("./package-manager.cjs");

export const assertPackageManager = packageManager.assertPackageManager;
export const commandForKungfuUpgrade = packageManager.commandForKungfuUpgrade;
export const commandForRunScript = packageManager.commandForRunScript;
export const commandForVersion = packageManager.commandForVersion;
export const detectLockfile = packageManager.detectLockfile;
export const detectPackageManager = packageManager.detectPackageManager;
export const getCurrentLockInfo = packageManager.getCurrentLockInfo;
export const getNpmLockInfo = packageManager.getNpmLockInfo;
export const getPnpmLockInfo = packageManager.getPnpmLockInfo;
export const getWorkspaceInfo = packageManager.getWorkspaceInfo;
export const getYarnLockInfo = packageManager.getYarnLockInfo;
export const shellJoin = packageManager.shellJoin;

export default packageManager;
