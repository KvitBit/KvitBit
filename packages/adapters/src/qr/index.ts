/**
 * Payment QR payloads (core-ports 5.3): Czech QR Platba (SPAYD) for CZK, EPC QR for EUR, the
 * rule D12 picker, and deterministic SVG output.
 */
export type { PaymentQrPayload, QrSource } from "./document";
export { forDocument } from "./document";
export type { EpcInput } from "./epc";
export { EPC_LIMITS, epc } from "./epc";
export { isValidBic, isValidIban, normalizeIban } from "./fields";
export type { SpaydInput } from "./spayd";
export { SPAYD_LIMITS, spayd } from "./spayd";
export type { QrSvgOptions } from "./svg";
export { toSvg } from "./svg";
