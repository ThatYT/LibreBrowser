# Viewer fixtures

P0-VIEWER develops against a recorded fixture stream so it can run before the gateway exists
(parallel-safety).

`wikipedia.agentmsgs.json` is the deterministic P0 fixture: an `AgentMsg` arrival stream with a
hello, Meta, FullSnapshot, and a mutation. It captures a compact Wikipedia-style semantic article
without third-party assets, so acceptance is repeatable before the gateway and asset proxy exist.

After `pnpm -F @mirror/viewer build`, run the real-browser gate with:

```sh
node packages/viewer/accept/p0-viewer.mjs
```

The harness serves the production bundle, streams the fixture over a real WebSocket, verifies the
inert sandbox and readable mirror, kills the socket, and verifies reconnect creates a new iframe.
