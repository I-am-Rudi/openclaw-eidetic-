// Narrow plugin-sdk surface for the bundled eidetic plugin.
// Keep this list additive and scoped to symbols used under extensions/eidetic.
export { definePluginEntry } from "./plugin-entry.js";
export { jsonResult } from "./memory-core-host-runtime-core.js";
export type { AnyAgentTool } from "./plugin-entry.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
