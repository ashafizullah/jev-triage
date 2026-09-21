import type { IncomingMessage, ServerResponse } from "node:http";

const HEALTH_PATH = "/healthz";

/**
 * Liveness probe for container platforms. Probot dispatches handlers in order and
 * stops at the first one that returns true, so we only claim our own path.
 */
export function healthHandler(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== HEALTH_PATH) return false;

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? "0.1.0",
    }),
  );
  return true;
}
