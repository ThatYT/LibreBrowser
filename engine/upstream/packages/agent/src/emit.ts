/**
 * Chunked emission through the CDP binding.
 *
 * The binding is installed via Runtime.addBinding BEFORE this script runs (D1 attach order),
 * so in production the queue never fills. The retry queue exists so the bundle can also run in
 * a plain browser page with a stubbed/late `__mirror_emit` (the P0-AGENT acceptance test).
 */
import { BINDING_NAME, encodeChunks, type AgentMsg } from "@mirror/protocol";

export interface Emitter {
  emit(msg: AgentMsg): void;
  /** Private agent-binding lane; converted to the frozen `clip` Down shape inside AgentLink. */
  emitClipboard(text: string): void;
}

export type BindingFn = (payload: string) => void;

export interface RuntimeBindingHandle {
  get(): BindingFn | undefined;
}

export function createEmitter(
  docId: number,
  bindingHandle?: RuntimeBindingHandle,
  bindingName = BINDING_NAME,
): Emitter {
  let msgId = 0;
  let queue: string[] | null = null;

  const binding = (): BindingFn | null => {
    const retained = bindingHandle?.get();
    if (retained !== undefined) return retained;
    const scope = window as unknown as Record<string, unknown>;
    const fn = scope[bindingName];
    if (typeof fn !== "function") return null;
    const descriptor = Object.getOwnPropertyDescriptor(scope, bindingName);
    if (descriptor?.enumerable === true) {
      try {
        Object.defineProperty(scope, bindingName, { ...descriptor, enumerable: false });
      } catch {
        // Gateway acquisition repeats the same best-effort descriptor normalization.
      }
    }
    return fn as BindingFn;
  };

  const flushLater = () => {
    const timer = setInterval(() => {
      const fn = binding();
      if (fn === null) return;
      clearInterval(timer);
      const pending = queue ?? [];
      queue = null;
      for (const chunk of pending) fn(chunk);
    }, 200);
  };

  const send = (msg: unknown): void => {
    const chunks = encodeChunks(docId, msgId++, JSON.stringify(msg));
    const fn = binding();
    if (fn !== null && queue === null) {
      for (const chunk of chunks) fn(chunk);
      return;
    }
    if (queue === null) {
      queue = [];
      flushLater();
    }
    queue.push(...chunks);
  };

  return {
    emit(msg: AgentMsg): void {
      send(msg);
    },
    emitClipboard(text: string): void {
      // AgentMsg is frozen, so this private binding message deliberately remains local to the
      // agent/browser bridge instead of widening the shared protocol package.
      send({ kind: "clip", docId, text });
    },
  };
}
