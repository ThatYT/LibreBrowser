import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VIEWER_DIST_ROOT =
  process.env.VIEWER_DIST_ROOT ?? fileURLToPath(new URL("../../viewer/dist", import.meta.url));

export function gatewayHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.GATEWAY_HOST ?? "127.0.0.1";
}

export async function registerViewerStatic(
  app: FastifyInstance,
  root = VIEWER_DIST_ROOT,
): Promise<boolean> {
  if (!existsSync(root)) return false;
  await app.register(fastifyStatic, { root });
  return true;
}
