import type { Replayer } from "@rrweb/replay";
import type { TabId } from "@mirror/protocol";
import { attachChangeCapture } from "./change";
import { attachDefaultActionContainment } from "./default-actions";
import { attachFileCapture } from "./files";
import { createForwardedInputClock } from "./forwarded";
import { attachCompositionUnderline } from "./ime";
import { attachKeyCapture, type EditableFocus } from "./keys";
import { attachPointerCapture, type SendInput } from "./pointer";
import { attachTouchCapture } from "./touch";
import { attachWheelCapture } from "./wheel";
import { attachScrollSync, type ScrollFilter } from "../pipeline/scroll";

export interface MirrorInputOptions {
  replayer: Replayer;
  tab: TabId;
  send: SendInput;
  /** Block native editing until its viewport acknowledgement precedes input on the socket. */
  inputEnabled?(): boolean;
  onEditableFocus?(focus: EditableFocus | null): void;
  onEditableInput?(focus: EditableFocus): void;
  onKeyDown?(event: KeyboardEvent, focus: EditableFocus | null): void;
  onFileSelection?(tab: TabId, input: HTMLInputElement): void;
  scrollFilter?: ScrollFilter;
}

/** Install every capture listener in the rrweb document set, never above the replay iframe. */
export function attachMirrorInput(options: MirrorInputOptions): () => void {
  const rootDoc = options.replayer.iframe.contentDocument;
  if (rootDoc === null) return () => {};
  const getNodeId = (node: Node) => options.replayer.getMirror().getId(node);
  const forwardedClock = createForwardedInputClock();
  const documents = new Map<Document, () => void>();
  const watchedFrames = new Map<HTMLIFrameElement, () => void>();
  const frameDocuments = new Map<HTMLIFrameElement, Document>();
  let active = true;

  const attachDocument = (doc: Document): void => {
    if (!active || documents.has(doc)) return;

    const cleanups: Array<() => void> = [];
    const gate = (event: Event) => {
      if (options.inputEnabled?.() !== false) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
    };
    for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown", "keyup", "beforeinput", "compositionstart", "wheel", "touchstart"]) {
      doc.addEventListener(name, gate, { capture: true, passive: false });
      cleanups.push(() => doc.removeEventListener(name, gate, true));
    }
    // Set the map entry before recursively walking frames so malformed frame trees cannot loop.
    documents.set(doc, () => {
      for (const cleanup of cleanups) cleanup();
    });
    cleanups.push(
      attachDefaultActionContainment({ doc }),
      ...(options.onFileSelection === undefined
        ? []
        : [attachFileCapture({ doc, tab: options.tab, select: options.onFileSelection })]),
      attachPointerCapture({ doc, rootDoc, tab: options.tab, getNodeId, send: options.send }),
      attachWheelCapture({ doc, rootDoc, tab: options.tab, getNodeId, send: options.send }),
      attachTouchCapture({ doc, rootDoc, tab: options.tab, getNodeId, send: options.send }),
    );
    const change = attachChangeCapture({
      doc,
      tab: options.tab,
      getNodeId,
      send: options.send,
      forwardedClock,
      onEditableInput: options.onEditableInput,
    });
    cleanups.push(
      change.dispose,
      attachCompositionUnderline({ doc }),
      attachKeyCapture({
        doc,
        focusRoot: rootDoc,
        tab: options.tab,
        getNodeId,
        send: options.send,
        forwardedClock,
        flushComposing: change.flush,
        onEditableFocus: options.onEditableFocus,
        onKeyDown: options.onKeyDown,
      }),
    );

    if (options.scrollFilter !== undefined) {
      cleanups.push(
        attachScrollSync({
          doc,
          rootDoc,
          tab: options.tab,
          getNodeId,
          filter: options.scrollFilter,
        }),
      );
    }

    const Observer = doc.defaultView?.MutationObserver;
    if (Observer !== undefined) {
      const observer = new Observer((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) discoverFrames(node);
        }
      });
      observer.observe(doc, { childList: true, subtree: true });
      cleanups.push(() => observer.disconnect());
    }

    for (const frame of doc.querySelectorAll("iframe")) watchFrame(frame);
  };

  const refreshFrameSoon = (frame: HTMLIFrameElement): void => {
    // rrweb can rebuild the serialized child with document.open(): the Document identity remains
    // stable while its listeners are cleared. Renew through the initial replay window because a
    // concurrent load event does not reliably distinguish that rebuild from transient about:blank.
    let attempts = 60;
    const refresh = () => {
      if (!active) return;
      attachFrameDocument(frame, true);
      attempts -= 1;
      if (attempts <= 0) return;
      frame.ownerDocument.defaultView?.requestAnimationFrame(refresh);
    };
    frame.ownerDocument.defaultView?.requestAnimationFrame(refresh);
  };

  const watchFrame = (frame: HTMLIFrameElement): void => {
    if (!active || watchedFrames.has(frame)) return;
    const onLoad = () => {
      attachFrameDocument(frame, true);
      refreshFrameSoon(frame);
    };
    frame.addEventListener("load", onLoad);
    watchedFrames.set(frame, () => frame.removeEventListener("load", onLoad));
    attachFrameDocument(frame);
    refreshFrameSoon(frame);
  };

  const attachFrameDocument = (frame: HTMLIFrameElement, renew = false): boolean => {
    try {
      const child = frame.contentDocument;
      if (child === null) return false;
      const previous = frameDocuments.get(frame);
      if (previous === child && !renew) return true;
      if (previous !== undefined) {
        documents.get(previous)?.();
        documents.delete(previous);
      }
      frameDocuments.set(frame, child);
      attachDocument(child);
      return true;
    } catch {
      // A transient non-same-origin document is outside this same-origin document set.
      return false;
    }
  };

  const discoverFrames = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName.toLowerCase() === "iframe") watchFrame(element as HTMLIFrameElement);
    for (const frame of element.querySelectorAll("iframe")) watchFrame(frame);
  };

  attachDocument(rootDoc);
  return () => {
    active = false;
    for (const cleanup of watchedFrames.values()) cleanup();
    watchedFrames.clear();
    frameDocuments.clear();
    for (const cleanup of documents.values()) cleanup();
    documents.clear();
    forwardedClock.clear();
  };
}
