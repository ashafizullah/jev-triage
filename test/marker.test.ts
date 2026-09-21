import { describe, expect, it } from "vitest";
import {
  buildMarker,
  hasMarker,
  parseMarker,
  parseMarkers,
  stripMarkers,
} from "../src/util/marker";

describe("comment markers", () => {
  it("round-trips through build and parse", () => {
    const marker = buildMarker({ v: 1, kind: "triage", runKey: "abc123" });
    expect(parseMarker(marker)).toEqual({ v: 1, kind: "triage", runKey: "abc123" });
  });

  it("finds a marker by kind inside surrounding prose", () => {
    const body = `Some **markdown**\n\n${buildMarker({ v: 1, kind: "spam", runKey: "run-1" })}`;
    expect(parseMarker(body, "spam")?.runKey).toBe("run-1");
    expect(parseMarker(body, "triage")).toBeNull();
    expect(hasMarker(body, "spam")).toBe(true);
  });

  it("parses multiple markers", () => {
    const body = `${buildMarker({ v: 1, kind: "a", runKey: "1" })}${buildMarker({ v: 1, kind: "b", runKey: "2" })}`;
    expect(parseMarkers(body).map((marker) => marker.kind)).toEqual(["a", "b"]);
  });

  it("ignores malformed markers instead of throwing", () => {
    expect(parseMarker("<!-- jev-triage:{not json} -->")).toBeNull();
    expect(parseMarker("<!-- jev-triage:{} -->")).toBeNull();
    expect(parseMarker(null)).toBeNull();
  });

  it("strips every marker from the visible body", () => {
    const body = `Visible text\n${buildMarker({ v: 1, kind: "triage", runKey: "x" })}`;
    expect(stripMarkers(body)).toBe("Visible text");
  });
});
