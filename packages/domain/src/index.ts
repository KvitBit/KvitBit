/**
 * @kvitbit/domain: the Phase 1 home of the `@kvitbit/core/contract` vocabulary
 * (docs/design/core-ports.md). Names and shapes follow the spec so a later core package can
 * re-export them unchanged.
 */
export * from "./action";
export * from "./caller";
export * from "./contact";
export * from "./errors";
export * from "./ids";
export * from "./modules/audit";
export * from "./modules/contacts";
export * from "./modules/documents";
export * from "./modules/expenses";
export * from "./modules/payments";
export * from "./modules/reports";
export * from "./modules/workspaces";
export * as MoneyMath from "./money";
export { CurrencyMismatch } from "./money";
export * from "./ports";
export * from "./scope";
export * from "./shared";
export * from "./theme";
export * from "./vat";
export * from "./vocabulary";
