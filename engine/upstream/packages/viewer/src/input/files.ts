/** Capture the native local picker result without suppressing the real user gesture. */
import type { TabId } from "@mirror/protocol";
import { isElement } from "./pointer";

export interface FileCaptureOptions {
  doc: Document;
  tab: TabId;
  select(tab: TabId, input: HTMLInputElement): void;
}

export function attachFileCapture(options: FileCaptureOptions): () => void {
  const onChange = (event: Event) => {
    if (!event.isTrusted || !isElement(event.target)) return;
    if (event.target.tagName.toLowerCase() !== "input") return;
    const input = event.target as HTMLInputElement;
    if (input.type.toLowerCase() !== "file") return;
    options.select(options.tab, input);
  };

  options.doc.addEventListener("change", onChange, true);
  return () => options.doc.removeEventListener("change", onChange, true);
}
