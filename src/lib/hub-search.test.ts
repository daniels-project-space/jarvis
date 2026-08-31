import { describe, expect, it } from "vitest";
import { searchHubSnapshot } from "./hub-search";

describe("searchHubSnapshot", () => {
  it("finds bounded live Hub todos and events without returning unrelated rows", () => {
    const snapshot = {
      todos: [
        { _id: "todo-1", text: "Prepare Shopify profitability report", tags: ["snuffelo"], projectSlug: "dropship-ai" },
        { _id: "todo-2", text: "Book dentist" },
      ],
      events: [
        { _id: "event-1", title: "Shopify review", location: "Project Hub", start: Date.UTC(2026, 8, 2) },
      ],
    };

    expect(searchHubSnapshot("shopify", snapshot)).toEqual([
      expect.objectContaining({ id: "hub:event:event-1", kind: "event", target: "calendar" }),
      expect.objectContaining({ id: "hub:todo:todo-1", kind: "todo", target: "todo" }),
    ]);
    expect(searchHubSnapshot("dentist", snapshot)).toEqual([
      expect.objectContaining({ id: "hub:todo:todo-2" }),
    ]);
    expect(searchHubSnapshot("x", snapshot)).toEqual([]);
  });
});
