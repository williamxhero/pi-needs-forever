/**
 * Pi package entry point. The command is deliberately a thin adapter over the
 * NeedsForever module; Pi-specific concerns stop at argument parsing and notify.
 */
export { default, createNeedsForeverExtension } from "./needs-forever.js";
export type { PiExtensionApi, PiExtensionContext } from "./needs-forever.js";
