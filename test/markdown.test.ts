import { describe, expect, it } from "vitest";
import { cleanText, excerpt, truncate } from "../src/util/markdown";

describe("cleanText", () => {
  it("removes html comments, badges and images", () => {
    const raw = [
      "<!-- This is a template comment -->",
      "[![Build](https://img.shields.io/badge.svg)](https://ci.example)",
      "![screenshot](https://example.com/shot.png)",
      "The app crashes on save.",
    ].join("\n");

    const cleaned = cleanText(raw);
    expect(cleaned).toBe("The app crashes on save.");
  });

  it("keeps link text and strips html tags", () => {
    const cleaned = cleanText("See [the docs](https://example.com/docs) <b>now</b>");
    expect(cleaned).toBe("See the docs now");
  });

  it("drops checkbox markers and placeholder lines", () => {
    const raw = ["- [x] I searched existing issues", "Steps:", "No response"].join("\n");
    const cleaned = cleanText(raw);
    expect(cleaned).not.toContain("[x]");
    expect(cleaned).not.toContain("No response");
    expect(cleaned).toContain("Steps:");
  });

  it("removes template boilerplate headings", () => {
    const raw = ["### Is there an existing issue for this?", "Yes", "Real problem here"].join("\n");
    expect(cleanText(raw)).toBe("Yes\nReal problem here");
  });

  it("collapses excessive blank lines", () => {
    expect(cleanText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("handles null and undefined", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    expect(truncate("short", 20)).toBe("short");
  });

  it("caps long text and marks the cut", () => {
    const result = truncate("word ".repeat(50), 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result.endsWith("…")).toBe(true);
  });

  it("breaks on a word boundary when one is close to the limit", () => {
    const result = truncate("alpha beta gamma delta epsilon", 20);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("epsilon");
  });
});

describe("excerpt", () => {
  it("collapses whitespace into a single line", () => {
    expect(excerpt("line one\n\nline   two", 100)).toBe("line one line two");
  });

  it("respects the character cap", () => {
    expect(excerpt("x".repeat(500), 120).length).toBeLessThanOrEqual(120);
  });
});
