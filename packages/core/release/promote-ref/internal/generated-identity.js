export const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};
export const COMMIT_SIGN_OFF = `Signed-off-by: ${COMMIT_IDENTITY.name} <${COMMIT_IDENTITY.email}>`;
export function signedGeneratedCommitMessage(message) {
  const normalized = String(message || "").trimEnd();
  if (normalized.split("\n").some((line) => line.trim() === COMMIT_SIGN_OFF)) {
    return normalized;
  }
  return `${normalized}\n\n${COMMIT_SIGN_OFF}`;
}
