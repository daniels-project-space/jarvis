import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type IndexDefinition = { name: string; fields: string[] };

function indexesForTable(schema: string, table: string, nextTable: string): IndexDefinition[] {
  const tableSource = schema.slice(schema.indexOf(`${table}: defineTable`), schema.indexOf(`${nextTable}: defineTable`));
  return [...tableSource.matchAll(/\.index\("([^"]+)", \[([^\]]+)\]\)/g)].map((match) => ({
    name: match[1],
    fields: [...match[2].matchAll(/"([^"]+)"/g)].map((field) => field[1]),
  }));
}

function assertUniqueFieldTuples(indexes: IndexDefinition[]) {
  const namesByTuple = new Map<string, string>();
  for (const index of indexes) {
    const tuple = index.fields.join("\u0000");
    const existing = namesByTuple.get(tuple);
    if (existing) throw new Error(`index ${index.name} duplicates ${existing}: [${index.fields.join(", ")}]`);
    namesByTuple.set(tuple, index.name);
  }
}

describe("goalPlanNodes schema index contract", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const indexes = indexesForTable(schema, "goalPlanNodes", "goalPlanEdges");

  it("keeps the canonical parent-generation index as the sole tuple owner", () => {
    expect(indexes).toContainEqual({
      name: "by_parent_generation",
      fields: ["parentMissionId", "planGeneration", "nodeId"],
    });
    expect(() => assertUniqueFieldTuples(indexes)).not.toThrow();
  });

  it("rejects duplicate field tuples even when their index names differ", () => {
    const canonical = indexes.find((index) => index.name === "by_parent_generation");
    expect(canonical).toBeDefined();
    expect(() => assertUniqueFieldTuples([
      canonical!,
      { name: "by_parent_generation_node", fields: [...canonical!.fields] },
    ])).toThrow(/duplicates by_parent_generation/);
  });
});

describe("mission supervisor schema index contract", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");

  it("keeps one compact current-state lookup and two bounded due-lease cursors", () => {
    const indexes = indexesForTable(
      schema,
      "missionSupervisorState",
      "missionSupervisorDecisions",
    );
    expect(indexes).toEqual([
      { name: "by_mission", fields: ["missionId"] },
      { name: "by_request", fields: ["requestKey"] },
      { name: "by_state_due", fields: ["state", "nextTickAt"] },
      { name: "by_state_lease", fields: ["state", "leaseUntil"] },
    ]);
    expect(() => assertUniqueFieldTuples(indexes)).not.toThrow();
  });

  it("keeps decision replay and ordered mission history on distinct tuples", () => {
    const indexes = indexesForTable(
      schema,
      "missionSupervisorDecisions",
      "controlPlaneMigrations",
    );
    expect(indexes).toEqual([
      { name: "by_key", fields: ["decisionKey"] },
      {
        name: "by_mission_epoch_sequence",
        fields: ["missionId", "epoch", "sequence"],
      },
    ]);
    expect(() => assertUniqueFieldTuples(indexes)).not.toThrow();
  });
});
