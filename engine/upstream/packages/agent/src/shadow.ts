/** Closed shadow roots are otherwise deliberately hidden by Element#shadowRoot. */
const closedRoots = new WeakMap<Element, ShadowRoot>();
const coercedRoots = new WeakSet<ShadowRoot>();

/**
 * Make closed roots reachable to rrweb without changing how open roots are returned.
 *
 * rrweb 2.1.1 deliberately reads Element#shadowRoot through an untainted native accessor, so a
 * page-world getter backed only by a WeakMap is not sufficient. Closed requests are created as
 * browser-reachable roots, while the page-visible shadowRoot and ShadowRoot#mode accessors retain
 * closed-root semantics. rrweb's clean accessor can then reach and serialize the underlying root.
 *
 * This must run before record() and before page scripts. `runImmediately` injection into an
 * ALREADY-LOADED page cannot retro-shim existing closed roots; session attach therefore has
 * degraded fidelity until the first navigation. There is intentionally no retrofit attempt.
 */
export function installClosedShadowShim(): void {
  const prototype = Element.prototype;
  const nativeAttachShadow = prototype.attachShadow;
  const shadowRootDescriptor = Object.getOwnPropertyDescriptor(prototype, "shadowRoot");
  const nativeShadowRootGetter = shadowRootDescriptor?.get;
  const modeDescriptor = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode");
  const nativeModeGetter = modeDescriptor?.get;

  if (
    typeof nativeAttachShadow !== "function" ||
    nativeShadowRootGetter === undefined ||
    nativeModeGetter === undefined
  )
    return;
  const getNativeShadowRoot = nativeShadowRootGetter;
  const getNativeMode = nativeModeGetter;

  function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    const requestedClosed = init.mode === "closed";
    const root = nativeAttachShadow.call(this, requestedClosed ? { ...init, mode: "open" } : init);
    if (requestedClosed) {
      closedRoots.set(this, root);
      coercedRoots.add(root);
    }
    return root;
  }

  function shadowRoot(this: Element): ShadowRoot | null {
    if (closedRoots.has(this)) return null;
    return getNativeShadowRoot.call(this);
  }

  function mode(this: ShadowRoot): ShadowRootMode {
    return coercedRoots.has(this) ? "closed" : getNativeMode.call(this);
  }

  Object.defineProperty(prototype, "attachShadow", {
    configurable: true,
    writable: true,
    value: attachShadow,
  });
  Object.defineProperty(prototype, "shadowRoot", {
    ...shadowRootDescriptor,
    get: shadowRoot,
  });
  Object.defineProperty(ShadowRoot.prototype, "mode", {
    ...modeDescriptor,
    get: mode,
  });
}
