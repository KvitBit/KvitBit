/**
 * Browser and React Native safe surface (`@kvitbit/core/contract`): the domain contract plus the
 * pure policy. Nothing here reaches the store, modules or ports.
 */
export * from "@kvitbit/domain/contract";
export { actionScope, can } from "./policy/can";
