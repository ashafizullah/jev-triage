import { getDb } from "./db/client";
import { createJevClient } from "./pipeline/jev/client";
import type { JevClient } from "./pipeline/jev/types";
import type { TriageDeps } from "./pipeline/runTriage";
import type { Logger } from "./util/logger";

let jevClient: JevClient | null = null;

export function getJevClient(): JevClient {
  if (!jevClient) {
    jevClient = createJevClient({ apiKey: process.env.TYPESAFE_API_KEY });
  }
  return jevClient;
}

/** Test seam: swap in a fake client without touching the network. */
export function setJevClient(client: JevClient | null): void {
  jevClient = client;
}

export function createTriageDeps(log: Logger): TriageDeps {
  return { jev: getJevClient(), db: getDb().db, log };
}
