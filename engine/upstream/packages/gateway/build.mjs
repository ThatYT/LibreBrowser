import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/main.mjs",
  sourcemap: false,
  external: ["@fastify/static", "dockerode", "fastify", "puppeteer-core", "undici", "ws"],
  logLevel: "warning",
});

console.log("@mirror/gateway: built dist/main.mjs");
