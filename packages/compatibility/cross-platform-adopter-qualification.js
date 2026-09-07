// Published names forward to the canonical implementation.
export * from "../core/cross-platform-adopter-qualification.js";
export {
  CROSS_PLATFORM_ADOPTER_PLATFORMS as V4_CROSS_PLATFORM_ADOPTER_PLATFORMS,
  CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT as V4_CROSS_PLATFORM_ADOPTER_QUALIFICATION_CONTRACT,
  CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT as V4_CROSS_PLATFORM_ADOPTER_REPORT_CONTRACT,
  CROSS_PLATFORM_NEUTRAL_DRIVER as V4_CROSS_PLATFORM_NEUTRAL_DRIVER,
  createCrossPlatformAdopterReport as createV4CrossPlatformAdopterReport,
  qualifyCrossPlatformAdopters as qualifyV4CrossPlatformAdopters,
  summarizeBaselineCapabilityInventory as summarizeV3V4CapabilityInventory,
  validateCrossPlatformAdopterReport as validateV4CrossPlatformAdopterReport,
} from "../core/cross-platform-adopter-qualification.js";
