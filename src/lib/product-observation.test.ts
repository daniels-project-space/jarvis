import { describe, expect, it } from "vitest";
import {
  isAccessoryOnlyMismatch,
  parseDeliveryPrice,
  productConditionMatches,
  productTitleSimilarity,
} from "./product-observation";

describe("product observation identity and landed-price truth", () => {
  it("distinguishes free, priced and unknown delivery", () => {
    expect(parseDeliveryPrice("Free delivery")).toEqual({ pence: 0, known: true });
    expect(parseDeliveryPrice("£12.99 delivery")).toEqual({ pence: 1299, known: true });
    expect(parseDeliveryPrice(undefined)).toEqual({ pence: 0, known: false });
  });

  it("rejects weakly related listings while retaining model-name identity", () => {
    expect(productTitleSimilarity("DJI RS 3 Pro Combo Gimbal", "DJI RS 3 Pro")).toBeGreaterThan(0.5);
    expect(productTitleSimilarity("DJI Mini 4 Pro Drone", "DJI RS 3 Pro")).toBeLessThan(0.5);
    expect(productTitleSimilarity("Sony FX30 Cinema Camera", "Sony FX3 camera")).toBeLessThan(0.45);
  });

  it("rejects accessory-only results unless the accessory is what was requested", () => {
    expect(isAccessoryOnlyMismatch("Hard Case for DJI RS 3 Pro", "DJI RS 3 Pro")).toBe(true);
    expect(isAccessoryOnlyMismatch("DJI RS 3 Pro Combo with Carry Case", "DJI RS 3 Pro")).toBe(false);
    expect(isAccessoryOnlyMismatch("Hard Case for DJI RS 3 Pro", "case for DJI RS 3 Pro")).toBe(false);
  });

  it("enforces requested listing condition and rejects unverifiable condition", () => {
    expect(productConditionMatches("Pre-owned", "used")).toBe(true);
    expect(productConditionMatches("Seller refurbished", "used")).toBe(true);
    expect(productConditionMatches("Brand New", "new")).toBe(true);
    expect(productConditionMatches("New", "used")).toBe(false);
    expect(productConditionMatches("unknown", "new")).toBe(false);
    expect(productConditionMatches("unknown", "any")).toBe(true);
  });
});
