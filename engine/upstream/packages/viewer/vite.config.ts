import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const gateway = process.env.VITE_GATEWAY_URL ?? "http://127.0.0.1:3000";
const port = Number(process.env.VIEWER_PORT ?? 5173);

export default defineConfig({
  plugins: [preact()],
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {
      "/ws": { target: gateway, ws: true },
      "/s/": { target: gateway },
      // Present only when MIRROR_E2E=1; keeps the harness on the viewer's origin too.
      "/__e2e": { target: gateway },
    },
  },
});
