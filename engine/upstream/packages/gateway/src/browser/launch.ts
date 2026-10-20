/**
 * Local Chromium launcher for development mode.
 *
 * Invariants:
 * - puppeteer-core as launcher/CDP transport ONLY (never its Page API for input/eval);
 *   `--remote-debugging-pipe`, `--no-first-run`, dedicated --user-data-dir, headful under Xvfb.
 * - Target.setAutoAttach({autoAttach:true, flatten:true, waitForDebuggerOnStart:true,
 *   filter:[{type:"page"},{type:"iframe"}]}).
 * - Workers/service-workers: resume immediately, never inject.
 * - Expose the raw flat session BEFORE resume — injection (P0-INJECT) must run its sequence
 *   first, or every new target hangs paused.
 *
 * P3-SESSIONS keeps this pipe launcher as the default local BrowserHost and reuses the same
 * BrowserHandle adapter for Docker's private-network websocket transport.
 */
import {
  connect,
  defaultArgs as puppeteerDefaultArgs,
  launch,
  type Browser,
  type CDPSession,
  type Protocol,
} from "puppeteer-core";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CdpSend, TargetEvents, TargetRef } from "../types";
import { TargetRegistry } from "./targets";

export interface LaunchOpts {
  userDataDir: string;
  executablePath?: string;
  headful?: boolean;
  /** Additional Chromium flags for development fixtures and diagnostics. */
  args?: readonly string[];
}

interface ChromiumLaunchArgOptions {
  headful?: boolean;
  userDataDir?: string;
}

const DISABLE_FEATURES_PREFIX = "--disable-features=";
const REQUIRED_DISABLED_FEATURE = "BackForwardCache";
const DISABLE_BLINK_FEATURES_PREFIX = "--disable-blink-features=";
const REQUIRED_DISABLED_BLINK_FEATURE = "AutomationControlled";
const SOFTWARE_GPU_ARG = "--enable-unsafe-swiftshader";

export interface BrowserTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerTabId?: string;
}

/** Typed CDP notifications emitted by an attached flat session. Extend this browser-owned
 * surface as browser features need more events; the stable gateway contracts stay unchanged. */
export interface FlatSessionEventMap {
  "Runtime.bindingCalled": Protocol.Runtime.BindingCalledEvent;
  "Page.frameNavigated": Protocol.Page.FrameNavigatedEvent;
  "Page.navigatedWithinDocument": Protocol.Page.NavigatedWithinDocumentEvent;
  "Page.lifecycleEvent": Protocol.Page.LifecycleEventEvent;
  "Page.screencastFrame": Protocol.Page.ScreencastFrameEvent;
  "Page.fileChooserOpened": Protocol.Page.FileChooserOpenedEvent;
}

/** Browser-domain notifications are deliberately separate from flat target-session events.
 * In particular, OOPIF-initiated downloads are reported only by the browser/root session. */
export interface BrowserSessionEventMap {
  "Browser.downloadWillBegin": Protocol.Browser.DownloadWillBeginEvent;
  "Browser.downloadProgress": Protocol.Browser.DownloadProgressEvent;
}

export interface BrowserHandle extends TargetEvents {
  send: CdpSend;
  /** Send a command on the browser/root CDP session (Target.* lifecycle commands). */
  sendBrowser?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Subscribe to a protocol event together with the flat session that emitted it. */
  onSessionEvent<K extends keyof FlatSessionEventMap>(
    method: K,
    cb: (sessionId: string, event: FlatSessionEventMap[K]) => void,
  ): () => void;
  /** Subscribe on the browser/root CDP session, never on a page or OOPIF session. */
  onBrowserEvent?<K extends keyof BrowserSessionEventMap>(
    method: K,
    cb: (event: BrowserSessionEventMap[K]) => void,
  ): () => void;
  /** Metadata changes used by navigation chrome and tab lifecycle. */
  onTargetInfoChanged(cb: (info: BrowserTargetInfo) => void): void;
  /** Host lifecycle hooks. BrowserHost implementations use these; ordinary consumers do not. */
  isAlive?(): boolean;
  kill?(): Promise<void>;
  close(): Promise<void>;
}

export type BrowserProfile = { mode: "ephemeral" } | { mode: "persistent"; name: string };

export interface BrowserHostLaunchOptions {
  sessionId: string;
  /** Ephemeral is the safe default for direct host callers and ordinary sessions. */
  profile?: BrowserProfile;
}

/** A browser process/container and the host resources that belong exclusively to it. */
export interface BrowserHostSession {
  readonly id: string;
  readonly browser: BrowserHandle;
  isRunning(): Promise<boolean>;
  /** Ask Chromium to exit cleanly. This is allowed to hang; SessionManager owns the deadline. */
  close(): Promise<void>;
  /** Hard-stop the Chromium process tree (SIGKILL for Docker). */
  kill(): Promise<void>;
  /** Remove per-session host resources. Named persistent profiles deliberately survive. */
  remove(): Promise<void>;
}

export interface BrowserHost {
  readonly kind: "local" | "docker";
  launch(options: BrowserHostLaunchOptions): Promise<BrowserHostSession>;
}

export interface LocalBrowserHostOptions extends Omit<LaunchOpts, "userDataDir"> {
  /** Parent for ephemeral dev/test profiles. Defaults to the operating-system temp directory. */
  profileRoot?: string;
}

type TargetCallback = (target: TargetRef) => void;
type TargetInfoCallback = (info: BrowserTargetInfo) => void;
type BindingCalledCallback = (
  sessionId: string,
  event: Protocol.Runtime.BindingCalledEvent,
) => void;
type FrameNavigatedCallback = (sessionId: string, event: Protocol.Page.FrameNavigatedEvent) => void;
type NavigatedWithinDocumentCallback = (
  sessionId: string,
  event: Protocol.Page.NavigatedWithinDocumentEvent,
) => void;
type LifecycleEventCallback = (sessionId: string, event: Protocol.Page.LifecycleEventEvent) => void;
type ScreencastFrameCallback = (
  sessionId: string,
  event: Protocol.Page.ScreencastFrameEvent,
) => void;
type FileChooserOpenedCallback = (
  sessionId: string,
  event: Protocol.Page.FileChooserOpenedEvent,
) => void;

/** Adapt Puppeteer's strongly keyed CDP session to the frozen gateway command boundary. */
async function sendOnSession(
  rootSession: CDPSession,
  sessionId: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const session = rootSession.connection()?.session(sessionId);
  if (!session) {
    throw new Error(`CDP session ${sessionId} is not attached`);
  }

  // CdpSend deliberately accepts protocol methods used by higher-level browser features.
  const dynamicSession = session as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  return dynamicSession.send(method, params);
}

function toTargetInfo(targetInfo: Protocol.Target.TargetInfo): BrowserTargetInfo {
  return {
    targetId: targetInfo.targetId,
    type: targetInfo.type,
    url: targetInfo.url,
    title: targetInfo.title,
    ...(targetInfo.openerId === undefined ? {} : { openerTabId: targetInfo.openerId }),
  };
}

function toTargetRef(
  sessionId: string,
  targetInfo: Protocol.Target.TargetInfo,
): TargetRef | undefined {
  if (targetInfo.type !== "page" && targetInfo.type !== "iframe") {
    return undefined;
  }

  return {
    targetId: targetInfo.targetId,
    sessionId,
    type: targetInfo.type,
    ...(targetInfo.openerId === undefined ? {} : { openerTabId: targetInfo.openerId }),
  };
}

async function resumeIgnoredTarget(parentSession: CDPSession, sessionId: string): Promise<void> {
  const session = parentSession.connection()?.session(sessionId);
  if (!session) return;

  try {
    await session.send("Runtime.runIfWaitingForDebugger");
  } finally {
    await parentSession.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

async function browserHandle(browser: Browser): Promise<BrowserHandle> {
  try {
    const rootSession = await browser.target().createCDPSession();
    const registry = new TargetRegistry();
    const sessionTargets = new Map<string, string>();
    const targetInfos = new Map<string, BrowserTargetInfo>();
    const attachedCallbacks = new Set<TargetCallback>();
    const detachedCallbacks = new Set<TargetCallback>();
    const infoCallbacks = new Set<TargetInfoCallback>();
    const bindingCalledCallbacks = new Set<BindingCalledCallback>();
    const frameNavigatedCallbacks = new Set<FrameNavigatedCallback>();
    const navigatedWithinDocumentCallbacks = new Set<NavigatedWithinDocumentCallback>();
    const lifecycleEventCallbacks = new Set<LifecycleEventCallback>();
    const screencastFrameCallbacks = new Set<ScreencastFrameCallback>();
    const fileChooserOpenedCallbacks = new Set<FileChooserOpenedCallback>();
    const browserEventCallbacks = new Map<
      keyof BrowserSessionEventMap,
      Set<(event: BrowserSessionEventMap[keyof BrowserSessionEventMap]) => void>
    >();
    const watchedSessions = new WeakSet<CDPSession>();
    const autoAttachParams = {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
      filter: [{ type: "page" }, { type: "iframe" }],
    } satisfies Protocol.Target.SetAutoAttachRequest;

    const handleAttached = (
      parentSession: CDPSession,
      event: Protocol.Target.AttachedToTargetEvent,
    ): void => {
      const childSession = parentSession.connection()?.session(event.sessionId);
      if (childSession) {
        watchSession(childSession);
        // Auto-attach is scoped to a target's related-target tree. Queue this before invoking
        // the injector callback so OOPIFs created during initial execution cannot race us.
        void childSession.send("Target.setAutoAttach", autoAttachParams).catch(() => undefined);
      }

      const target = toTargetRef(event.sessionId, event.targetInfo);
      if (!target) {
        void resumeIgnoredTarget(parentSession, event.sessionId).catch(() => undefined);
        return;
      }

      const previous = registry.targets.get(target.targetId);
      if (previous?.sessionId === target.sessionId) return;

      registry.add(target);
      sessionTargets.set(target.sessionId, target.targetId);
      targetInfos.set(target.targetId, toTargetInfo(event.targetInfo));
      for (const callback of attachedCallbacks) callback(target);
    };

    const handleDetached = (event: Protocol.Target.DetachedFromTargetEvent): void => {
      const targetId = sessionTargets.get(event.sessionId) ?? event.targetId;
      if (targetId === undefined) return;

      const target = registry.targets.get(targetId);
      sessionTargets.delete(event.sessionId);
      if (target?.sessionId !== event.sessionId) return;

      targetInfos.delete(targetId);
      registry.remove(targetId);
      if (target) {
        for (const callback of detachedCallbacks) callback(target);
      }
    };

    const handleTargetInfoChanged = (event: Protocol.Target.TargetInfoChangedEvent): void => {
      const info = toTargetInfo(event.targetInfo);
      targetInfos.set(info.targetId, info);
      for (const callback of infoCallbacks) callback(info);
    };

    function watchSession(session: CDPSession): void {
      if (watchedSessions.has(session)) return;
      watchedSessions.add(session);
      session.on("Target.attachedToTarget", (event) => handleAttached(session, event));
      session.on("Target.detachedFromTarget", handleDetached);
      session.on("Target.targetInfoChanged", handleTargetInfoChanged);
      session.on("Runtime.bindingCalled", (event) => {
        for (const callback of bindingCalledCallbacks) callback(session.id(), event);
      });
      session.on("Page.frameNavigated", (event) => {
        for (const callback of frameNavigatedCallbacks) callback(session.id(), event);
      });
      session.on("Page.navigatedWithinDocument", (event) => {
        for (const callback of navigatedWithinDocumentCallbacks) callback(session.id(), event);
      });
      session.on("Page.lifecycleEvent", (event) => {
        for (const callback of lifecycleEventCallbacks) callback(session.id(), event);
      });
      session.on("Page.screencastFrame", (event) => {
        for (const callback of screencastFrameCallbacks) callback(session.id(), event);
      });
      session.on("Page.fileChooserOpened", (event) => {
        for (const callback of fileChooserOpenedCallbacks) callback(session.id(), event);
      });
    }

    watchSession(rootSession);

    const dynamicRootEvents = rootSession as unknown as {
      on(method: string, callback: (event: unknown) => void): void;
    };
    for (const method of [
      "Browser.downloadWillBegin",
      "Browser.downloadProgress",
    ] as const satisfies readonly (keyof BrowserSessionEventMap)[]) {
      dynamicRootEvents.on(method, (event) => {
        const callbacks = browserEventCallbacks.get(method);
        if (callbacks === undefined) return;
        for (const callback of callbacks) {
          callback(event as BrowserSessionEventMap[typeof method]);
        }
      });
    }

    await rootSession.send("Target.setDiscoverTargets", {
      discover: true,
      filter: [{ type: "page" }, { type: "iframe" }],
    });
    await rootSession.send("Target.setAutoAttach", autoAttachParams);

    const launchedBrowser = browser;
    let closePromise: Promise<void> | undefined;
    return {
      send: (sessionId, method, params) => sendOnSession(rootSession, sessionId, method, params),
      sendBrowser: (method, params) => {
        const dynamicRoot = rootSession as unknown as {
          send(method: string, params?: Record<string, unknown>): Promise<unknown>;
        };
        return dynamicRoot.send(method, params);
      },
      onSessionEvent(method, callback) {
        switch (method) {
          case "Runtime.bindingCalled": {
            const bindingCallback = callback as BindingCalledCallback;
            bindingCalledCallbacks.add(bindingCallback);
            return () => bindingCalledCallbacks.delete(bindingCallback);
          }
          case "Page.frameNavigated": {
            const frameCallback = callback as FrameNavigatedCallback;
            frameNavigatedCallbacks.add(frameCallback);
            return () => frameNavigatedCallbacks.delete(frameCallback);
          }
          case "Page.navigatedWithinDocument": {
            const withinDocumentCallback = callback as NavigatedWithinDocumentCallback;
            navigatedWithinDocumentCallbacks.add(withinDocumentCallback);
            return () => navigatedWithinDocumentCallbacks.delete(withinDocumentCallback);
          }
          case "Page.lifecycleEvent": {
            const lifecycleCallback = callback as LifecycleEventCallback;
            lifecycleEventCallbacks.add(lifecycleCallback);
            return () => lifecycleEventCallbacks.delete(lifecycleCallback);
          }
          case "Page.screencastFrame": {
            const screencastCallback = callback as ScreencastFrameCallback;
            screencastFrameCallbacks.add(screencastCallback);
            return () => screencastFrameCallbacks.delete(screencastCallback);
          }
          case "Page.fileChooserOpened": {
            const chooserCallback = callback as FileChooserOpenedCallback;
            fileChooserOpenedCallbacks.add(chooserCallback);
            return () => fileChooserOpenedCallbacks.delete(chooserCallback);
          }
        }
      },
      onBrowserEvent(method, callback) {
        let callbacks = browserEventCallbacks.get(method);
        if (callbacks === undefined) {
          callbacks = new Set();
          browserEventCallbacks.set(method, callbacks);
        }
        const rootCallback = callback as (
          event: BrowserSessionEventMap[keyof BrowserSessionEventMap],
        ) => void;
        callbacks.add(rootCallback);
        return () => callbacks?.delete(rootCallback);
      },
      onAttached(callback) {
        attachedCallbacks.add(callback);
        // setAutoAttach can synchronously report the initial page before launchBrowser returns.
        // Replay current refs so an injector always gets a chance to resume every target.
        for (const target of registry.targets.values()) callback(target);
      },
      onDetached(callback) {
        detachedCallbacks.add(callback);
      },
      onTargetInfoChanged(callback) {
        infoCallbacks.add(callback);
        for (const info of targetInfos.values()) callback(info);
      },
      isAlive() {
        if (!launchedBrowser.connected) return false;
        const child = launchedBrowser.process();
        return child === null || (child.exitCode === null && child.signalCode === null);
      },
      async kill() {
        launchedBrowser.process()?.kill("SIGKILL");
        await launchedBrowser.disconnect();
      },
      close() {
        closePromise ??= launchedBrowser.close();
        return closePromise;
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/**
 * The compatibility entry point used by every Phase 0–2 dev/acceptance harness. It deliberately
 * remains a direct local launch over `--remote-debugging-pipe`.
 */
export async function launchBrowser(opts: LaunchOpts): Promise<BrowserHandle> {
  if (opts.userDataDir.trim() === "") {
    throw new Error("launchBrowser requires a dedicated userDataDir");
  }

  const headful = opts.headful ?? true;
  const args = await chromiumLaunchArgs(opts.args, { headful, userDataDir: opts.userDataDir });
  // Local development in this repository can run as root; production runs unprivileged in
  // the P3-SESSIONS browser container.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("LibreBrowser Chromium must run unprivileged with its sandbox enabled");
  }

  const browser = await launch({
    ...(opts.executablePath === undefined ? {} : { executablePath: opts.executablePath }),
    args,
    headless: !headful,
    // chromiumLaunchArgs starts from this Puppeteer version's complete default argument set.
    // Re-applying defaults here would produce another --disable-features switch.
    ignoreDefaultArgs: true,
    pipe: true,
    dumpio: process.env.CHROME_DIAGNOSTICS === "1",
    // main.ts owns graceful shutdown and must await Browser.close/profile flush.
    handleSIGTERM: false,
    handleSIGINT: false,
    handleSIGHUP: false,
    userDataDir: opts.userDataDir,
  });
  browser.process()?.once("exit", (code, signal) => console.error(JSON.stringify({event:"chromium_exit",code,signal})));
  return browserHandle(browser);
}

/**
 * Compose the complete Chromium argv once so FeatureList sees one merged --disable-features.
 * Puppeteer's public API supplies its version-specific defaults; passing BackForwardCache as a
 * caller feature asks that API to merge it with those defaults instead of replacing them.
 */
export async function chromiumLaunchArgs(
  additional: readonly string[] = [],
  options: ChromiumLaunchArgOptions = {},
): Promise<string[]> {
  const callerArgs = [...additional, `${DISABLE_FEATURES_PREFIX}${REQUIRED_DISABLED_FEATURE}`];
  const args = await puppeteerDefaultArgs({
    args: callerArgs,
    headless: !(options.headful ?? true),
    ...(options.userDataDir === undefined ? {} : { userDataDir: options.userDataDir }),
  });

  // Keep these launcher invariants even if a future Puppeteer release changes its defaults.
  if (!args.includes(SOFTWARE_GPU_ARG)) args.unshift(SOFTWARE_GPU_ARG);
  if (!args.includes("--password-store=basic")) args.unshift("--password-store=basic");
  if (!args.includes("--no-first-run")) args.unshift("--no-first-run");

  // Puppeteer's automation switch is a launcher convenience, not a requirement for our raw CDP
  // transport. The browser is driven by a person and must not opt Blink into webdriver automation
  // semantics merely because the mirror uses a debugging pipe.
  const ordinaryChromeArgs = args.filter(
    (arg) => arg !== "--enable-automation" && !arg.startsWith("--enable-automation=") && arg !== "--disable-dev-shm-usage",
  );
  return mergeCommaSeparatedSwitch(
    mergeCommaSeparatedSwitch(ordinaryChromeArgs, DISABLE_FEATURES_PREFIX, [
      REQUIRED_DISABLED_FEATURE,
    ]),
    DISABLE_BLINK_FEATURES_PREFIX,
    [REQUIRED_DISABLED_BLINK_FEATURE],
  );
}

function mergeCommaSeparatedSwitch(
  args: readonly string[],
  prefix: string,
  requiredValues: readonly string[],
): string[] {
  const mergedValues = new Set<string>();
  const result: string[] = [];
  let switchIndex: number | undefined;

  for (const arg of args) {
    if (!arg.startsWith(prefix)) {
      result.push(arg);
      continue;
    }
    switchIndex ??= result.length;
    for (const value of arg.slice(prefix.length).split(",")) {
      if (value !== "") mergedValues.add(value);
    }
  }

  for (const value of requiredValues) mergedValues.add(value);
  result.splice(switchIndex ?? result.length, 0, `${prefix}${[...mergedValues].join(",")}`);
  return result;
}

/** Connect the same raw-CDP BrowserHandle to a remote endpoint (used only by DockerBrowserHost). */
export async function connectBrowser(browserWSEndpoint: string): Promise<BrowserHandle> {
  const browser = await connect({ browserWSEndpoint, defaultViewport: null });
  return browserHandle(browser);
}

/**
 * Default BrowserHost for development and tests. Each managed session still gets an isolated
 * temporary profile, but Chromium keeps the P0 pipe transport and launch behavior unchanged.
 */
export function createLocalBrowserHost(options: LocalBrowserHostOptions = {}): BrowserHost {
  return {
    kind: "local",
    async launch({ sessionId, profile = { mode: "ephemeral" } }) {
      if (sessionId.trim() === "") throw new Error("sessionId must not be empty");
      const profileRoot = options.profileRoot ?? tmpdir();
      await mkdir(profileRoot, { recursive: true });
      const persistent = profile.mode === "persistent";
      const userDataDir = persistent
        ? join(profileRoot, `mirror-browser-profile-${profileName(profile.name)}`)
        : await mkdtemp(join(profileRoot, "mirror-browser-"));
      if (persistent) await mkdir(userDataDir, { recursive: true });
      let browser: BrowserHandle | undefined;
      try {
        browser = await launchBrowser({
          userDataDir,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.headful === undefined ? {} : { headful: options.headful }),
          ...(options.args === undefined ? {} : { args: options.args }),
        });
      } catch (error) {
        if (!persistent) await rm(userDataDir, { recursive: true, force: true });
        throw error;
      }

      const launched = browser;
      let removed = false;
      return {
        id: sessionId,
        browser: launched,
        isRunning: async () => launched.isAlive?.() ?? true,
        close: () => launched.close(),
        kill: async () => {
          if (launched.kill !== undefined) await launched.kill();
          else await launched.close();
        },
        remove: async () => {
          if (removed) return;
          if (!persistent) await rm(userDataDir, { recursive: true, force: true });
          removed = true;
        },
      };
    },
  };
}

function profileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name)) {
    throw new Error("persistent profile name must be 1-80 URL-safe characters");
  }
  return name;
}
