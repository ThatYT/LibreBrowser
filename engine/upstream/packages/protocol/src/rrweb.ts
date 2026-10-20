/**
 * Single source for rrweb types.
 *
 * Nothing else in the workspace may import `@rrweb/types` directly — everyone re-imports
 * from `@mirror/protocol` so the exact-version pin (2.1.1, see scripts/check-rrweb-versions.mjs)
 * has one source. `@rrweb/record`, `@rrweb/replay` and both canvas-webrtc plugins MUST resolve
 * to the same version; skew produces a *silent blank replay*.
 */
export type { eventWithTime } from "@rrweb/types";
export { EventType, IncrementalSource } from "@rrweb/types";
