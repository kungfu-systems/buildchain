// Published names forward to the canonical implementation.
export * from "../core/runtime-ref-resume-authority.js";
export {
  RUNTIME_AUTHORIZATION_CONTRACT as V4_RUNTIME_AUTHORIZATION_CONTRACT,
  RUNTIME_PERSISTENCE_SCAN_CONTRACT as V4_RUNTIME_PERSISTENCE_SCAN_CONTRACT,
  RUNTIME_RESUME_LINEAGE_CONTRACT as V4_RUNTIME_RESUME_LINEAGE_CONTRACT,
  authorizeRuntimeSelection as authorizeV4RuntimeSelection,
  createRuntimeResumeLineage as createV4RuntimeResumeLineage,
  scanRuntimeSelectorPersistence as scanV4RuntimeSelectorPersistence,
  runtimeResumeDocumentRoot as v4RuntimeResumeDocumentRoot,
  verifyRuntimeAuthorizationReceipt as verifyV4RuntimeAuthorizationReceipt,
  verifyRuntimeResumeLineage as verifyV4RuntimeResumeLineage,
} from "../core/runtime-ref-resume-authority.js";
