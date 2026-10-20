/**
 * rrweb's cursor is useful replay chrome, but it must never become an input surface. The
 * insertStyleRules copy is installed in every rebuilt replay document; the inline enforcement
 * covers rrweb 2.1.1's cursor element, which is a sibling layered over the replay iframe.
 */
export const REPLAY_CURSOR_OVERLAY_SELECTOR =
  '.replayer-mouse, .replayer-mouse-tail, [class^="replayer-mouse-"], [class*=" replayer-mouse-"]';

export const REPLAY_CURSOR_PASSTHROUGH_RULE = `html ${REPLAY_CURSOR_OVERLAY_SELECTOR.replaceAll(", ", ", html ")} { pointer-events: none !important; }`;

export function enforceReplayCursorPassthrough(iframe: HTMLIFrameElement): void {
  const wrapper = iframe.parentElement;
  if (wrapper === null) return;
  for (const overlay of wrapper.querySelectorAll<HTMLElement>(REPLAY_CURSOR_OVERLAY_SELECTOR)) {
    overlay.style.setProperty("pointer-events", "none", "important");
  }
}
