/**
 * Server-page clipboard observation for P3-CLIP-G.
 *
 * This observes successful Clipboard.writeText calls and native copy events. It never cancels a
 * copy event or writes clipboard data, so the browser's native copy behavior remains authoritative.
 */
import type { Emitter } from "./emit";

interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

interface NavigatorLike {
  readonly clipboard?: ClipboardLike;
}

interface SelectionLike {
  toString(): string;
}

interface CopyEventLike {
  readonly clipboardData?: { getData(format: string): string } | null;
  readonly target?: EventTarget | null;
}

interface WindowLike {
  addEventListener(type: "copy", listener: (event: CopyEventLike) => void): void;
  removeEventListener(type: "copy", listener: (event: CopyEventLike) => void): void;
  getSelection(): SelectionLike | null;
}

export interface CapturedClipboardWrite {
  readonly clipboard: ClipboardLike;
  readonly writeText: ClipboardLike["writeText"];
}

export interface ClipboardHookOptions {
  readonly capturedWrite: CapturedClipboardWrite | null;
  readonly emitter: Pick<Emitter, "emitClipboard">;
  readonly window?: WindowLike;
}

/** Capture both the receiver and method before page code can replace either reference. */
export function captureClipboardWrite(navigatorLike: NavigatorLike): CapturedClipboardWrite | null {
  const clipboard = navigatorLike.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return null;
  return { clipboard, writeText: clipboard.writeText };
}

/** Installs the observation hooks and returns a test/dev cleanup function. */
export function installClipboardHooks(options: ClipboardHookOptions): () => void {
  const view = options.window ?? (window as unknown as WindowLike);
  const previousDescriptor =
    options.capturedWrite === null
      ? undefined
      : Object.getOwnPropertyDescriptor(options.capturedWrite.clipboard, "writeText");
  let writeHookInstalled = false;

  if (options.capturedWrite !== null) {
    const { clipboard, writeText } = options.capturedWrite;
    const wrappedWriteText = (text: string): Promise<void> => {
      const result = writeText.call(clipboard, text);
      // Preserve the native promise and outcome. Clipboard notification is an independent lane.
      void result.then(
        () => options.emitter.emitClipboard(String(text)),
        () => undefined,
      );
      return result;
    };
    try {
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        writable: true,
        value: wrappedWriteText,
      });
      writeHookInstalled = true;
    } catch {
      // Some embeddings expose a non-configurable Clipboard object. Native copy observation below
      // is still useful, and clipboard capability failures must not prevent recorder startup.
    }
  }

  const onCopy = (event: CopyEventLike): void => {
    options.emitter.emitClipboard(copiedText(event, view));
  };
  view.addEventListener("copy", onCopy);

  return () => {
    view.removeEventListener("copy", onCopy);
    if (!writeHookInstalled || options.capturedWrite === null) return;
    if (previousDescriptor === undefined) {
      delete (options.capturedWrite.clipboard as Partial<ClipboardLike>).writeText;
    } else {
      Object.defineProperty(options.capturedWrite.clipboard, "writeText", previousDescriptor);
    }
  };
}

function copiedText(event: CopyEventLike, view: WindowLike): string {
  const clipboardText = event.clipboardData?.getData("text/plain");
  if (clipboardText !== undefined && clipboardText !== "") return clipboardText;

  const target = event.target;
  if (isTextControl(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? start;
    return target.value.slice(Math.min(start, end), Math.max(start, end));
  }
  return view.getSelection()?.toString() ?? "";
}

function isTextControl(value: EventTarget | null | undefined): value is EventTarget & {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const control = value as unknown as Record<string, unknown>;
  return (
    typeof control.value === "string" &&
    (typeof control.selectionStart === "number" || control.selectionStart === null) &&
    (typeof control.selectionEnd === "number" || control.selectionEnd === null)
  );
}
