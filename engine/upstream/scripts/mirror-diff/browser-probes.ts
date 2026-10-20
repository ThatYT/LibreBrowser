import type { DomSnapshot } from "./types";

export interface QuiescenceProbe {
  ready: boolean;
  mutations: number;
  lastMutationAt: number;
  resources: number;
  lastResourceAt: number;
  now: number;
}

/** Serialize a browser-side collector so the same code runs via gateway CDP and in the viewer. */
export const SNAPSHOT_FUNCTION_SOURCE = collectSnapshot.toString();
export const QUIESCENCE_FUNCTION_SOURCE = probeQuiescence.toString();

function collectSnapshot(rootDocument: Document): DomSnapshot {
  const text: string[] = [];
  const tagCounts: Record<string, number> = {};
  const controls: DomSnapshot["controls"] = {};
  const scroll: DomSnapshot["scroll"] = {};
  let elementCount = 0;
  let imageCount = 0;
  const visitedDocuments = new Set<Document>();
  const visitedRoots = new Set<Document | ShadowRoot | Element>();

  const elementKey = (element: Element, documentPath: string): string => {
    if (element.id) return `${documentPath}#${element.id}`;
    const pieces: string[] = [];
    let current: Element | null = element;
    while (current && pieces.length < 6) {
      const parent: Element | null = current.parentElement;
      const siblings = parent
        ? [...parent.children].filter((candidate) => candidate.tagName === current!.tagName)
        : [];
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      pieces.unshift(`${current.tagName.toLowerCase()}${suffix}`);
      if (current.hasAttribute("data-diff-root")) break;
      current = parent;
    }
    return `${documentPath}:${pieces.join(">")}`;
  };

  const visitTree = (
    root: Document | ShadowRoot | Element,
    documentPath: string,
    includeText: boolean,
  ): void => {
    if (visitedRoots.has(root)) return;
    visitedRoots.add(root);
    // nodeType is realm-safe for elements originating in a child iframe.
    const rootElement = root.nodeType === 1 ? (root as Element) : null;
    const elements = [
      ...(rootElement ? [rootElement] : []),
      ...root.querySelectorAll<Element>("*"),
    ].filter((element) => !element.closest("[data-diff-ignore]"));
    if (includeText) {
      const visibleText = rootElement
        ? (rootElement as HTMLElement).innerText
        : [...root.childNodes]
            .filter(
              (node) =>
                node.nodeType !== 1 ||
                !["script", "style", "template"].includes((node as Element).tagName.toLowerCase()),
            )
            .map((node) =>
              node.nodeType === 1
                ? ((node as HTMLElement).innerText ?? node.textContent ?? "")
                : (node.textContent ?? ""),
            )
            .join("\n");
      text.push(`[${documentPath}] ${visibleText ?? ""}`);
    }
    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      elementCount += 1;
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      if (tag === "img") imageCount += 1;
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const key = elementKey(element, documentPath);
        const value = {
          kind: `${tag}${tag === "input" ? `:${(control as HTMLInputElement).type}` : ""}`,
          value: control.value,
        } as DomSnapshot["controls"][string];
        if (tag === "input") value.checked = (control as HTMLInputElement).checked;
        if (tag === "select") {
          value.selected = [...(control as HTMLSelectElement).selectedOptions].map(
            (option) => option.value,
          );
        }
        controls[key] = value;
      }
      if (element.hasAttribute("data-diff-scroll")) {
        const html = element as HTMLElement;
        scroll[`${elementKey(element, documentPath)}::scroll`] = {
          x: Math.round(html.scrollLeft),
          y: Math.round(html.scrollTop),
        };
      }
      if (element.shadowRoot) {
        visitTree(element.shadowRoot, `${documentPath}/shadow${elementKey(element, "")}`, true);
      }
    }
  };

  const visitDocument = (document: Document, documentPath: string): void => {
    if (visitedDocuments.has(document)) return;
    visitedDocuments.add(document);
    const stableRoots = [...document.querySelectorAll<Element>("[data-diff-root]")];
    const roots = stableRoots.length > 0 ? stableRoots : document.body ? [document.body] : [];
    for (const root of roots) visitTree(root, documentPath, true);
    const view = document.defaultView;
    scroll[`${documentPath}::window`] = {
      x: Math.round(view?.scrollX ?? 0),
      y: Math.round(view?.scrollY ?? 0),
    };
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
      try {
        if (frame.contentDocument) {
          visitDocument(frame.contentDocument, `${documentPath}/frame${elementKey(frame, "")}`);
        }
      } catch {
        // True cross-origin/OOPIF documents are scored by their own future P2-OOPIF fixture lane.
      }
    }
  };

  const describeActive = (): string | null => {
    let document = rootDocument;
    let documentPath = "top";
    let active = document.activeElement;
    const visited = new Set<Element>();
    while (active && !visited.has(active)) {
      visited.add(active);
      if (active.tagName.toLowerCase() === "iframe") {
        try {
          const child = (active as HTMLIFrameElement).contentDocument;
          if (child) {
            documentPath += `/frame${elementKey(active, "")}`;
            document = child;
            active = document.activeElement;
            continue;
          }
        } catch {
          // Stop at the cross-origin iframe boundary.
        }
      }
      const shadowActive = active.shadowRoot?.activeElement;
      if (shadowActive) {
        documentPath += `/shadow${elementKey(active, "")}`;
        active = shadowActive;
        continue;
      }
      const tag = active.tagName.toLowerCase();
      const type = tag === "input" ? `:${(active as HTMLInputElement).type}` : "";
      return `${elementKey(active, documentPath)}|${tag}${type}`;
    }
    return null;
  };

  visitDocument(rootDocument, "top");
  return {
    text: text.join("\n"),
    elementCount,
    tagCounts,
    imageCount,
    controls,
    activeElement: describeActive(),
    scroll,
  };
}

function probeQuiescence(rootDocument: Document): QuiescenceProbe {
  type ProbeState = {
    mutations: number;
    lastMutationAt: number;
    resources: number;
    lastResourceAt: number;
    observed: WeakSet<Node>;
    observers: MutationObserver[];
  };
  const owner = rootDocument.defaultView as (Window & { __p2DiffQuiet?: ProbeState }) | null;
  if (!owner) {
    return {
      ready: false,
      mutations: 0,
      lastMutationAt: Date.now(),
      resources: 0,
      lastResourceAt: Date.now(),
      now: Date.now(),
    };
  }
  const now = Date.now();
  const state =
    owner.__p2DiffQuiet ??
    (owner.__p2DiffQuiet = {
      mutations: 0,
      lastMutationAt: now,
      resources: -1,
      lastResourceAt: now,
      observed: new WeakSet<Node>(),
      observers: [],
    });
  const documents: Document[] = [];
  const visitDocument = (document: Document): void => {
    if (documents.includes(document)) return;
    documents.push(document);
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
      try {
        if (frame.contentDocument) visitDocument(frame.contentDocument);
      } catch {
        // Cross-origin frames cannot participate in this same-origin probe.
      }
    }
  };
  visitDocument(rootDocument);
  const observe = (node: Node): void => {
    if (state.observed.has(node)) return;
    state.observed.add(node);
    const observer = new MutationObserver((records) => {
      state.mutations += records.length;
      state.lastMutationAt = Date.now();
    });
    observer.observe(node, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    state.observers.push(observer);
  };
  for (const document of documents) {
    observe(document);
    for (const element of document.querySelectorAll<Element>("*")) {
      if (element.shadowRoot) observe(element.shadowRoot);
    }
  }
  const resources = documents.reduce(
    (total, document) =>
      total + (document.defaultView?.performance.getEntriesByType("resource").length ?? 0),
    0,
  );
  if (resources !== state.resources) {
    state.resources = resources;
    state.lastResourceAt = now;
  }
  return {
    // rrweb-created replay documents can intentionally remain readyState="loading" because
    // scripts are inert and the synthetic document stream is not closed like a navigation.
    ready: documents.every(
      (document) => document.readyState === "complete" || document.body !== null,
    ),
    mutations: state.mutations,
    lastMutationAt: state.lastMutationAt,
    resources,
    lastResourceAt: state.lastResourceAt,
    now,
  };
}
