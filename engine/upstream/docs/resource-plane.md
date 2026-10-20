# The remote browser's resource plane

The authoritative browser executes the site. The viewer renders a projection.
That distinction must hold for resources as well as DOM and input events.

```text
Authoritative tab ── DOM events ── tab-owned URL rewriter ── viewer
       ▲                                                    │
       └── browser-context fetch ◀── authenticated asset route┘
                 │                         │
          object URL reader          stylesheet resolver
                 └────────── bounded storage ───────────────┘
```

## Implemented boundary corrections

- Tab construction always installs resource rewriting. It is not an optional
  entrypoint integration; omitting an argument cannot silently expose raw URLs.
- Each tab owns its rewriter and bounded resource-URL memoization. Duplicate
  image nodes and resnapshots reuse gateway URLs rather than generating a fresh
  HTTP cache identity for every reference.
- HTTP resources use the browser network context first. Object URLs are read
  from their browser context in bounded slices, with a held object released on
  completion/error. They never enter an unrelated direct HTTP fallback.
- Fetched CSS is a resource graph: imports, fonts and images are resolved against
  the stylesheet URL and routed through the same gateway. Compression and changed
  representation headers are handled together; parser input is bounded.
- Upstream cookies and origin-control headers must not control the gateway
  origin. Authenticated font caching is private to the client.
- Lifecycle integration tests complement component tests. The browser acceptance
  check blocks direct external viewer traffic; an unrestricted test browser can
  otherwise conceal missing proxy wiring by fetching the images itself.

## Evidence and limits

The entrypoint omitted the existing rewriter, so the default identity stage
forwarded raw image URLs. Component tests could pass while the deployed composition
was wrong. This was reproduced in the basic view and corrected at tab construction.
Live-site staging checks covered a public image-reader homepage and reader, plus a
synthetic browser-local image. These checks do not prove every site works.

## Next architectural boundaries to improve

1. Resource lifetime: bind cache freshness to document/runtime generation and
   upstream validators; the current disk cache's in-memory index does not survive
   restart and is not a durable storage index. Preserve existing profiles while
   designing explicit cache ownership and cleanup.
2. Frame ownership: extend asset references with the originating frame/context
   for cross-origin iframe object URLs. The current object reader uses the tab's
   main frame; do not claim arbitrary iframe object support.
3. HTTP fidelity: account explicitly for redirect-final URLs, referrer policy and
   range behavior. Current direct range fallback is not the full browser network
   context. A successful image test is not a video-streaming certification.
4. Recovery: model the DOM epoch, document, input readiness and media lifetime as
   one session-owned projection contract. Preserve the existing snapshot/delta
   recovery mechanism rather than replacing working boundaries wholesale.
5. Runtime supervision: choose the deployed single-session or managed-session
   composition explicitly; test the actual entrypoint and dependency graph.
   Optional integration seams must not erase required production capabilities.

Do not start with a language rewrite, more services, or a new framework. Fix
ownership and contracts at their constructors, and test the assembled system.
