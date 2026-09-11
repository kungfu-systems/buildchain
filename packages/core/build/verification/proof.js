import { invokeDomainWasm } from "../../runtime/domain-wasm.js";
export function planVerification(input) {
  return invokeDomainWasm("source-verification-plan", input);
}

export function sealVerification(input) {
  return invokeDomainWasm("source-verification-seal", input);
}
