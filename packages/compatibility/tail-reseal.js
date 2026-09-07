// Published names forward to the canonical implementation.
export * from "../core/tail-reseal.js";
export {
  TailResealFault as V4TailResealFault,
  TAIL_RESEAL_PLAN_CONTRACT as V4_TAIL_RESEAL_PLAN_CONTRACT,
  TAIL_RESEAL_PLATFORMS as V4_TAIL_RESEAL_PLATFORMS,
  TAIL_RESEAL_REQUEST_CONTRACT as V4_TAIL_RESEAL_REQUEST_CONTRACT,
  TAIL_RESEAL_REUSED_STAGE_KEYS as V4_TAIL_RESEAL_REUSED_STAGE_KEYS,
  normalizeTailResealRequest as normalizeV4TailResealRequest,
  planTailReseal as planV4TailReseal,
} from "../core/tail-reseal.js";
