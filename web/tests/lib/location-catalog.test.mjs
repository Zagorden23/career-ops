import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORLD_LOCATION_CATALOG,
  getCountryEntry,
  getStatesForCountry,
  getCitiesForState,
  buildLocationFilterTokens,
  matchesLocationHierarchy,
  inferLocationHierarchyFromText,
  inferHierarchyFromAllowChips,
} from "../../src/lib/location-catalog.mjs";

test("WORLD_LOCATION_CATALOG covers India states/cities and global tech hubs", () => {
  assert.ok(WORLD_LOCATION_CATALOG.length >= 15);
  const india = getCountryEntry("India");
  assert.ok(india);
  assert.equal(india.code, "IN");

  const states = getStatesForCountry("India");
  assert.ok(states.some((s) => s.state === "Karnataka"));
  assert.ok(states.some((s) => s.state === "Maharashtra"));
  assert.ok(states.some((s) => s.state === "Telangana"));
  assert.ok(states.some((s) => s.state === "Delhi NCR"));
  assert.ok(states.some((s) => s.state === "Tamil Nadu"));
  assert.ok(states.some((s) => s.state === "West Bengal"));

  const kaCities = getCitiesForState("India", "Karnataka");
  assert.ok(kaCities.some((c) => c.name === "Bengaluru" && c.aliases.includes("Bangalore")));
});

test("buildLocationFilterTokens and matchesLocationHierarchy filter Country -> State -> City accurately", () => {
  // 1. Country + State + City (India -> Karnataka -> Bengaluru)
  const blrTokens = buildLocationFilterTokens({
    country: "India",
    state: "Karnataka",
    city: "Bengaluru",
    includeRemote: false,
  });
  assert.ok(blrTokens.allow.includes("Bengaluru"));
  assert.ok(blrTokens.allow.includes("Bangalore"));
  assert.equal(
    matchesLocationHierarchy("Bangalore, KA, India", {
      country: "India",
      state: "Karnataka",
      city: "Bengaluru",
      includeRemote: false,
    }),
    true,
  );
  assert.equal(
    matchesLocationHierarchy("San Francisco, CA, USA", {
      country: "India",
      state: "Karnataka",
      city: "Bengaluru",
      includeRemote: false,
    }),
    false,
  );

  // 2. Country-level filter (India) matches Indian office cities and rejects non-Indian cities
  assert.equal(
    matchesLocationHierarchy("Hyderabad, India", {
      country: "India",
      state: "",
      city: "",
      includeRemote: true,
    }),
    true,
  );
  assert.equal(
    matchesLocationHierarchy("Remote - United States", {
      country: "India",
      state: "",
      city: "",
      includeRemote: true,
    }),
    false,
  );
  assert.equal(
    matchesLocationHierarchy("Remote (India)", {
      country: "India",
      state: "",
      city: "",
      includeRemote: true,
    }),
    true,
  );
});

test("inferLocationHierarchyFromText and inferHierarchyFromAllowChips detect India and cities", () => {
  const fromCv = inferLocationHierarchyFromText(
    "# CV -- Priya Sharma\n**Location:** Bengaluru, India\nSenior Engineer",
  );
  assert.equal(fromCv.country, "India");

  const fromChips = inferHierarchyFromAllowChips(["Bengaluru", "Bangalore", "Remote"]);
  assert.equal(fromChips.country, "India");
  assert.equal(fromChips.state, "Karnataka");
  assert.equal(fromChips.city, "Bengaluru");
  assert.equal(fromChips.includeRemote, true);
});
