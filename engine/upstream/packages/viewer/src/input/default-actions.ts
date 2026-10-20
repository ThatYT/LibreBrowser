/**
 * Keep the interactive rrweb document inert as a navigation surface.
 *
 * Pointer/key relay is attached separately: cancelling these browser defaults must never cancel
 * the semantic input message sent to the authoritative remote browser.
 */
import { isElement } from "./pointer";

export interface DefaultActionContainmentOptions {
  doc: Document;
}

/** Install capture-phase guards for browser defaults that can replace or escape the mirror. */
export function attachDefaultActionContainment(
  options: DefaultActionContainmentOptions,
): () => void {
  const onLinkActivation = (event: MouseEvent) => {
    if (closestNavigationLink(event.target) !== null) event.preventDefault();
  };
  const onSubmit = (event: SubmitEvent) => event.preventDefault();
  const onDrop = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    if (types !== undefined && (types.includes("text/uri-list") || types.includes("Files"))) {
      event.preventDefault();
    }
  };

  options.doc.addEventListener("click", onLinkActivation, true);
  options.doc.addEventListener("auxclick", onLinkActivation, true);
  options.doc.addEventListener("submit", onSubmit, true);
  options.doc.addEventListener("drop", onDrop, true);
  return () => {
    options.doc.removeEventListener("click", onLinkActivation, true);
    options.doc.removeEventListener("auxclick", onLinkActivation, true);
    options.doc.removeEventListener("submit", onSubmit, true);
    options.doc.removeEventListener("drop", onDrop, true);
  };
}

/** Includes image-map areas; anchor descendants are the ordinary rrweb replay case. */
export function closestNavigationLink(target: EventTarget | null): Element | null {
  return isElement(target) ? target.closest("a[href],area[href]") : null;
}
