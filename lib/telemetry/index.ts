/**
 * Telemetry barrel — consume from `@/lib/telemetry`, not from the internal
 * files. Everything here writes to the local log only (see ./events.ts); the
 * terminal sends nothing to a telemetry service.
 */

export { journeyTracker, JourneyTracker } from "./journey-tracker";
export type { AppJourneyType } from "./journey-tracker";
export { withSpan, breadcrumb, captureError, captureWarning, isExpectedError } from "./events";
export {
  recordCoinagePaymentPhase,
  recordPaymentOutcome,
  recordFinalizationLatency,
} from "./payment-metrics";
export type {
  CoinagePaymentPhase,
  CoinagePaymentPhaseParams,
  PaymentMethodKind,
  PaymentOutcomeParams,
  FinalizationLatencyParams,
} from "./payment-metrics";
