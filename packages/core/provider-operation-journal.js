import { ContractFault } from "./canonical-contracts.js";
import { DomainWasmFault, invokeDomainWasm } from "./domain-wasm.js";

export const PROVIDER_OPERATION_IDENTITY_CONTRACT =
  "buildchain-v4-provider-operation-identity/v1";
export const PROVIDER_OPERATION_INTENT_CONTRACT =
  "buildchain-v4-provider-operation-intent/v1";
export const PROVIDER_OPERATION_ATTEMPT_CONTRACT =
  "buildchain-v4-provider-operation-attempt/v1";
export const PROVIDER_OPERATION_OBSERVATION_CONTRACT =
  "buildchain-v4-provider-operation-observation/v1";
export const PROVIDER_OPERATION_CONFIRMATION_CONTRACT =
  "buildchain-v4-provider-operation-confirmation/v1";
export const PROVIDER_OPERATION_RECONCILIATION_CONTRACT =
  "buildchain-v4-provider-operation-reconciliation/v1";
export const PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT =
  "buildchain-v4-provider-operation-journal-state/v1";

function invoke(operation, payload) {
  try {
    return invokeDomainWasm(operation, payload);
  } catch (error) {
    if (error instanceof DomainWasmFault) {
      throw new ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function validateProviderOperationIdentity(value) {
  invoke("provider-operation-identity-validate", value);
  return value;
}

export function providerOperationRoot(identity) {
  return invoke("provider-operation-identity-root", identity).root;
}

export function providerOperationEntryRoot(entry) {
  return invoke("provider-operation-entry-root", entry).root;
}

export function validateProviderOperationEntry(entry) {
  invoke("provider-operation-entry-validate", entry);
  return entry;
}

export function foldProviderOperationJournal(entries) {
  return invoke("provider-operation-journal", entries).state;
}

export function providerOperationJournalRoot(entries) {
  return invoke("provider-operation-journal", entries).journalRoot;
}

export function providerOperationJournalStateRoot(entries) {
  return invoke("provider-operation-journal", entries).stateRoot;
}

export function projectProviderOperationFixtures(fixtures) {
  return invoke("provider-operation-fixtures", fixtures);
}
