import { describe, expect, it } from "vitest";
import { resolveModel } from "../src/config/model";
import { DEFAULT_MODEL } from "../src/config/schema";

describe("resolveModel", () => {
  it("prefers the repository config over everything else", () => {
    expect(resolveModel({ model: "jev-1.13.0" }, { JEV_MODEL: "jev-1.12.0" })).toBe("jev-1.13.0");
  });

  it("falls back to JEV_MODEL when the repository sets nothing", () => {
    expect(resolveModel({}, { JEV_MODEL: "jev-1.12.0" })).toBe("jev-1.12.0");
  });

  it("falls back to the built-in default", () => {
    expect(resolveModel({}, {})).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("jev-latest");
  });

  it("treats an empty or whitespace JEV_MODEL as unset", () => {
    // An empty line in .env is far more common than a deliberate empty model name, and
    // sending "" to the API would fail.
    expect(resolveModel({}, { JEV_MODEL: "" })).toBe(DEFAULT_MODEL);
    expect(resolveModel({}, { JEV_MODEL: "   " })).toBe(DEFAULT_MODEL);
  });

  it("trims a padded value", () => {
    expect(resolveModel({}, { JEV_MODEL: " jev-1.13.0 " })).toBe("jev-1.13.0");
  });
});
