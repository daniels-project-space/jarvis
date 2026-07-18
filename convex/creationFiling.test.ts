import { describe, expect, it } from "vitest";
import { inferCreationFiling } from "./creationFiling";

describe("creation filing", () => {
  it("files project work under the project before its media type", () => {
    expect(inferCreationFiling({ kind: "board", title: "Clue map", project: "summer-campaign" })).toMatchObject({
      category: "boards",
      folder: "Projects / Summer Campaign",
      project: "Summer Campaign",
    });
  });

  it("recognises scavenger-hunt inquiry work without model metadata", () => {
    expect(inferCreationFiling({ kind: "scene", title: "London scavenger hunt choices" })).toMatchObject({
      folder: "Inquiries / Scavenger Hunts",
      inquiry: "Scavenger Hunts",
    });
  });

  it("separates emails and notes", () => {
    expect(inferCreationFiling({ kind: "doc", title: "Email to venue", data: "Hi Alex," }).category).toBe("emails");
    expect(inferCreationFiling({ kind: "doc", title: "Planning notes" }).category).toBe("notes");
  });
});
