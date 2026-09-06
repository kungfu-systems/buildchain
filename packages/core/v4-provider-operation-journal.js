import { V4ContractFault } from "./v4-canonical-contracts.js";
import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_PROVIDER_OPERATION_IDENTITY_CONTRACT =
  "buildchain-v4-provider-operation-identity/v1";
export const V4_PROVIDER_OPERATION_INTENT_CONTRACT =
  "buildchain-v4-provider-operation-intent/v1";
export const V4_PROVIDER_OPERATION_ATTEMPT_CONTRACT =
  "buildchain-v4-provider-operation-attempt/v1";
export const V4_PROVIDER_OPERATION_OBSERVATION_CONTRACT =
  "buildchain-v4-provider-operation-observation/v1";
export const V4_PROVIDER_OPERATION_CONFIRMATION_CONTRACT =
  "buildchain-v4-provider-operation-confirmation/v1";
export const V4_PROVIDER_OPERATION_RECONCILIATION_CONTRACT =
  "buildchain-v4-provider-operation-reconciliation/v1";
export const V4_PROVIDER_OPERATION_JOURNAL_STATE_CONTRACT =
  "buildchain-v4-provider-operation-journal-state/v1";

function invoke(operation, payload) {
  try {
    return invokeV4DomainWasm(operation, payload);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      throw new V4ContractFault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function validateV4ProviderOperationIdentity(value) {
  invoke("provider-operation-identity-validate", value);
  return value;
}

export function v4ProviderOperationRoot(identity) {
  return invoke("provider-operation-identity-root", identity).root;
}

export function v4ProviderOperationEntryRoot(entry) {
  return invoke("provider-operation-entry-root", entry).root;
}

export function validateV4ProviderOperationEntry(entry) {
  invoke("provider-operation-entry-validate", entry);
  return entry;
}

export function foldV4ProviderOperationJournal(entries) {
  return invoke("provider-operation-journal", entries).state;
}

export function v4ProviderOperationJournalRoot(entries) {
  return invoke("provider-operation-journal", entries).journalRoot;
}

export function v4ProviderOperationJournalStateRoot(entries) {
  return invoke("provider-operation-journal", entries).stateRoot;
}

export function projectV4ProviderOperationFixtures(fixtures) {
  return invoke("provider-operation-fixtures", fixtures);
}
