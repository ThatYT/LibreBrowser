/** Local composition underline anchored to the mirrored caret. */
import { isTextEditable } from "./keys";
import { isElement } from "./pointer";

const UNDERLINE_CLASS = "mirror-ime-composition-underline";

export interface CompositionUnderlineOptions {
  doc: Document;
}

interface CaretAnchor {
  left: number;
  bottom: number;
}

export function attachCompositionUnderline({ doc }: CompositionUnderlineOptions): () => void {
  let target: Element | null = null;
  let text = "";
  let underline: HTMLElement | null = null;

  const clear = () => {
    underline?.remove();
    underline = null;
    target = null;
    text = "";
  };

  const render = () => {
    if (target === null) return;
    if (underline === null) {
      underline = doc.createElement("span");
      underline.className = UNDERLINE_CLASS;
      underline.setAttribute("aria-hidden", "true");
      Object.assign(underline.style, {
        position: "fixed",
        zIndex: "2147483647",
        height: "0",
        borderBottom: "2px solid #2563eb",
        borderRadius: "1px",
        boxShadow: "0 1px 0 rgb(255 255 255 / 75%)",
        pointerEvents: "none",
      });
      doc.body?.append(underline);
    }
    const width = Math.max(12, measureText(doc, target, text || " "));
    const anchor = caretAnchor(doc, target, text);
    underline.dataset.composition = text;
    underline.style.width = `${Math.ceil(width)}px`;
    underline.style.left = `${Math.round(anchor.left)}px`;
    underline.style.top = `${Math.round(anchor.bottom + 1)}px`;
  };

  const onCompositionStart = (event: CompositionEvent) => {
    if (!event.isTrusted || !isElement(event.target) || !isTextEditable(event.target)) return;
    clear();
    target = event.target;
    text = event.data;
    render();
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    if (!event.isTrusted || event.target !== target) return;
    text = event.data;
    render();
  };
  const onComposingInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (!inputEvent.isTrusted || !inputEvent.isComposing || inputEvent.target !== target) return;
    if (inputEvent.data !== null) text = inputEvent.data;
    render();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (event.isTrusted && event.target === target) clear();
  };
  const onBlur = (event: FocusEvent) => {
    if (event.target === target) clear();
  };
  const refresh = () => render();

  doc.addEventListener("compositionstart", onCompositionStart, true);
  doc.addEventListener("compositionupdate", onCompositionUpdate, true);
  doc.addEventListener("compositionend", onCompositionEnd, true);
  doc.addEventListener("input", onComposingInput, true);
  doc.addEventListener("selectionchange", refresh, true);
  doc.addEventListener("scroll", refresh, true);
  doc.addEventListener("blur", onBlur, true);
  doc.defaultView?.addEventListener?.("resize", refresh);
  return () => {
    doc.removeEventListener("compositionstart", onCompositionStart, true);
    doc.removeEventListener("compositionupdate", onCompositionUpdate, true);
    doc.removeEventListener("compositionend", onCompositionEnd, true);
    doc.removeEventListener("input", onComposingInput, true);
    doc.removeEventListener("selectionchange", refresh, true);
    doc.removeEventListener("scroll", refresh, true);
    doc.removeEventListener("blur", onBlur, true);
    doc.defaultView?.removeEventListener?.("resize", refresh);
    clear();
  };
}

function caretAnchor(doc: Document, target: Element, compositionText: string): CaretAnchor {
  if ((target as HTMLElement).isContentEditable) {
    const rangeAnchor = selectionAnchor(doc, target, compositionText);
    if (rangeAnchor !== null) return rangeAnchor;
  }
  if (target.tagName.toLowerCase() === "input" || target.tagName.toLowerCase() === "textarea") {
    return textControlAnchor(
      doc,
      target as HTMLInputElement | HTMLTextAreaElement,
      compositionText,
    );
  }
  const rect = target.getBoundingClientRect();
  return { left: rect.left, bottom: rect.bottom };
}

function selectionAnchor(
  doc: Document,
  target: Element,
  compositionText: string,
): CaretAnchor | null {
  try {
    const selection = doc.getSelection();
    if (selection === null || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!target.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    const left = range.collapsed
      ? rect.left - measureText(doc, target, compositionText)
      : rect.left;
    return { left: Math.max(target.getBoundingClientRect().left, left), bottom: rect.bottom };
  } catch {
    return null;
  }
}

function textControlAnchor(
  doc: Document,
  control: HTMLInputElement | HTMLTextAreaElement,
  compositionText: string,
): CaretAnchor {
  const rect = control.getBoundingClientRect();
  const style = doc.defaultView?.getComputedStyle(control);
  const borderLeft = cssPixels(style?.borderLeftWidth);
  const borderTop = cssPixels(style?.borderTopWidth);
  const paddingLeft = cssPixels(style?.paddingLeft);
  const paddingTop = cssPixels(style?.paddingTop);
  const fontSize = cssPixels(style?.fontSize) || 16;
  const lineHeight = cssPixels(style?.lineHeight) || fontSize * 1.2;
  const selection = control.selectionStart ?? control.value.length;
  const start = Math.max(
    0,
    selection - (control.selectionStart === control.selectionEnd ? compositionText.length : 0),
  );
  const prefix = control.value.slice(0, start);
  const lines = prefix.split("\n");
  const currentLine = lines.at(-1) ?? "";
  const left =
    rect.left +
    borderLeft +
    paddingLeft +
    measureText(doc, control, currentLine) -
    control.scrollLeft;
  const bottom = rect.top + borderTop + paddingTop + lines.length * lineHeight - control.scrollTop;
  return {
    left: Math.max(rect.left + borderLeft, Math.min(left, rect.right - borderLeft)),
    bottom: Math.max(rect.top + borderTop, Math.min(bottom, rect.bottom - borderTop)),
  };
}

function measureText(doc: Document, target: Element, text: string): number {
  const canvas = doc.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) return [...text].length * 8;
  const style = doc.defaultView?.getComputedStyle(target);
  if (style?.font) context.font = style.font;
  return context.measureText(text).width;
}

function cssPixels(value: string | undefined): number {
  if (value === undefined || value === "normal") return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
