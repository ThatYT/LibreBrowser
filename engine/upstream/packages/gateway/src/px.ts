/**
 * Gateway side of the pixel fallback.
 * (Viewer half P2-PX-V = viewer/src/pxview.tsx, viewer domain.)
 *
 * Per-tab mode toggle: Page.startScreencast (jpeg q60, viewport-sized) -> `px` Down msgs.
 * ALWAYS ack frames (Page.screencastFrameAck) or the screencast stalls. Keep the recorder
 * running in px mode (cheap; makes flip-back instant via fresh snapshot). Backpressure: drop
 * frames for stalled viewers, never queue (D4 rule applies to px too).
 */
import type { Down, Up } from "@mirror/protocol";

import type { BrowserHandle } from "./browser/launch";
import type { TabHub } from "./hub/tabhub";
import type { TargetRef } from "./types";

type ModeMsg = Extract<Up, { t: "mode" }>;
type ScreencastBrowser = Pick<
  BrowserHandle,
  "send" | "onAttached" | "onDetached" | "onSessionEvent"
>;

export interface ScreencastOpts {
  browser: ScreencastBrowser;
  hubFor(tabId: string): TabHub | undefined;
  publish(msg: Down): void;
  onError?: (error: unknown) => void;
}

export interface ScreencastController {
  handle(msg: ModeMsg): Promise<void>;
  modeFor(tabId: string): "dom" | "px" | undefined;
  dispose(): void;
}

interface TabState {
  target: TargetRef;
  hub: TabHub;
  screencasting: boolean;
  lastFrame?: Extract<Down, { t: "px" }>;
  queue: Promise<void>;
}

/**
 * Owns only CDP's screencast lane. It deliberately never pauses or replaces AgentLink/TabHub:
 * rrweb keeps recording into the same hub while JPEG frames are shown.
 */
export function createScreencast(opts: ScreencastOpts): ScreencastController {
  const tabs = new Map<string, TabState>();
  const sessions = new Map<string, TabState>();
  let disposed = false;

  const report = (error: unknown): void => opts.onError?.(error);

  const unsubscribeFrame = opts.browser.onSessionEvent(
    "Page.screencastFrame",
    (sessionId, event) => {
      const state = sessions.get(sessionId);
      if (disposed || state === undefined) return;

      // Ack independently of fan-out and mode state. A final frame can race stopScreencast;
      // failing to ack it is enough to wedge a later restart on some Chromium versions.
      void opts.browser
        .send(sessionId, "Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(report);

      if (!state.screencasting || state.hub.mode !== "px") return;
      const viewport = state.hub.viewport;
      const w = frameDimension(viewport?.w, event.metadata.deviceWidth);
      const h = frameDimension(viewport?.h, event.metadata.deviceHeight);
      state.lastFrame = { t: "px", tab: state.target.targetId, data: event.data, w, h };
      opts.publish(state.lastFrame);
      // Retain one bounded latest frame for repeated mode requests on static pages.
      // ViewerConn still drops delivery to stalled viewers rather than queueing frames.
    },
  );

  const unsubscribeNavigation = opts.browser.onSessionEvent(
    "Page.frameNavigated",
    (sessionId, event) => {
      if (!event.frame.parentId) {
        const state = sessions.get(sessionId);
        if (state) delete state.lastFrame;
      }
    },
  );

  const applyMode = async (state: TabState, mode: "dom" | "px"): Promise<void> => {
    if (mode === "px") {
      if (state.screencasting && state.hub.mode === "px") {
        opts.publish({ t: "mode", tab: state.target.targetId, mode: "px" });
        if (state.lastFrame) opts.publish(state.lastFrame);
        return;
      }
      const viewport = state.hub.viewport;
      state.screencasting = true;
      state.hub.mode = "px";
      try {
        await opts.browser.send(state.target.sessionId, "Page.startScreencast", {
          format: "jpeg",
          quality: 60,
          everyNthFrame: 1,
          ...(viewport === null
            ? {}
            : {
                maxWidth: frameDimension(viewport.w, viewport.w),
                maxHeight: frameDimension(viewport.h, viewport.h),
              }),
        });
      } catch (error) {
        state.screencasting = false;
        state.hub.mode = "dom";
        delete state.lastFrame;
        throw error;
      }
      if (disposed || sessions.get(state.target.sessionId) !== state) {
        await opts.browser
          .send(state.target.sessionId, "Page.stopScreencast")
          .catch(() => undefined);
        return;
      }
      state.screencasting = true;
      state.hub.mode = "px";
      opts.publish({ t: "mode", tab: state.target.targetId, mode: "px" });
      // A frame can precede CDP's start acknowledgement; the viewer ignores it until mode.
      if (state.lastFrame) opts.publish(state.lastFrame);
      return;
    }

    if (!state.screencasting && state.hub.mode === "dom") return;
    if (state.screencasting) {
      await opts.browser.send(state.target.sessionId, "Page.stopScreencast");
    }
    if (disposed || sessions.get(state.target.sessionId) !== state) return;
    state.screencasting = false;
    delete state.lastFrame;
    state.hub.mode = "dom";
    opts.publish({ t: "mode", tab: state.target.targetId, mode: "dom" });
    for (const down of state.hub.joinPayload()) opts.publish(down);
  };

  opts.browser.onDetached((target) => {
    if (target.type !== "page") return;
    const state = tabs.get(target.targetId);
    if (state?.target.sessionId !== target.sessionId) return;
    tabs.delete(target.targetId);
    sessions.delete(target.sessionId);
    if (state.screencasting) {
      void opts.browser.send(target.sessionId, "Page.stopScreencast").catch(() => undefined);
    }
  });

  opts.browser.onAttached((target) => {
    if (disposed || target.type !== "page") return;
    const hub = opts.hubFor(target.targetId);
    if (hub === undefined) return;
    const previous = tabs.get(target.targetId);
    if (previous?.target.sessionId === target.sessionId) return;
    if (previous !== undefined) sessions.delete(previous.target.sessionId);
    const state: TabState = {
      target,
      hub,
      screencasting: false,
      queue: Promise.resolve(),
    };
    tabs.set(target.targetId, state);
    sessions.set(target.sessionId, state);
  });

  return {
    handle(msg) {
      const state = tabs.get(msg.tab);
      if (state === undefined)
        return Promise.reject(new Error(`unknown screencast tab ${msg.tab}`));
      const operation = state.queue.then(() => applyMode(state, msg.mode));
      // Preserve serialization after a failed CDP command without hiding that failure from the
      // caller that requested this particular transition.
      state.queue = operation.catch(() => undefined);
      return operation;
    },
    modeFor(tabId) {
      return tabs.get(tabId)?.hub.mode;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFrame();
      unsubscribeNavigation();
      for (const state of tabs.values()) {
        if (state.screencasting) {
          void opts.browser
            .send(state.target.sessionId, "Page.stopScreencast")
            .catch(() => undefined);
        }
      }
      tabs.clear();
      sessions.clear();
    },
  };
}

function frameDimension(preferred: number | undefined, fallback: number): number {
  const value = preferred !== undefined && Number.isFinite(preferred) ? preferred : fallback;
  return Math.max(1, Math.round(value));
}
