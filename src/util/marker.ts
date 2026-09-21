export interface CommentMarker {
  v: 1;
  /** Which bot comment this is, e.g. "triage" or "needs-info". */
  kind: string;
  /** Content hash of the triaged item; lets a re-run update its own comment. */
  runKey: string;
}

const MARKER_RE = /<!--\s*jev-triage:(\{[\s\S]*?\})\s*-->/g;

export function buildMarker(marker: CommentMarker): string {
  return `<!-- jev-triage:${JSON.stringify(marker)} -->`;
}

export function parseMarkers(body: string | null | undefined): CommentMarker[] {
  if (!body) return [];
  const found: CommentMarker[] = [];
  for (const match of body.matchAll(MARKER_RE)) {
    const payload = match[1];
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as CommentMarker;
      if (parsed && typeof parsed.runKey === "string" && typeof parsed.kind === "string") {
        found.push(parsed);
      }
    } catch {
      // Ignore malformed markers rather than failing the whole run.
    }
  }
  return found;
}

export function parseMarker(body: string | null | undefined, kind?: string): CommentMarker | null {
  const markers = parseMarkers(body);
  if (kind) return markers.find((m) => m.kind === kind) ?? null;
  return markers[0] ?? null;
}

export function hasMarker(body: string | null | undefined, kind?: string): boolean {
  return parseMarker(body, kind) !== null;
}

/** Strips every jev-triage marker so the visible comment text can be rebuilt. */
export function stripMarkers(body: string): string {
  return body.replace(MARKER_RE, "").trim();
}
