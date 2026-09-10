import crypto from "node:crypto";
import { required } from "../../build/signing/files.js";
export function decodeDetachedPrivateKey(value) {
  const compact = required(value, "detached signing private key").replace(
    /\s+/gu,
    "",
  );
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)) {
    throw new Error("detached signing private key must be canonical base64");
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length < 32 || decoded.length > 16 * 1024) {
    throw new Error("detached signing private key has an invalid size");
  }
  return crypto.createPrivateKey({
    key: decoded,
    format: "der",
    type: "pkcs8",
  });
}
