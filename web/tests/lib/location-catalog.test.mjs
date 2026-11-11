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


test("India filter rejects foreign and region-restricted postings (no leaks)", () => {
  const india = { country: "India", state: "", city: "", includeRemote: true };
  const reject = [
    "Remote - US", "Remote (USA)", "Remote, EMEA", "Remote - Europe", "Remote - Canada",
    "Remote - California", "Remote - Romania", "Remote (EST)", "Indianapolis, IN",
    "Jakarta, Indonesia", "Cambridge, MA, USA", "London, UK", "Singapore", "Americas",
    "North America - Remote", "",
  ];
  for (const loc of reject) assert.equal(matchesLocationHierarchy(loc, india), false, loc);
  const accept = [
    "Bengaluru, Karnataka, India", "Pune", "Hyderabad, IN, India", "Remote", "Remote - India",
    "Remote - APAC", "Anywhere", "Worldwide", "San Francisco, USA; Bengaluru, India",
  ];
  for (const loc of accept) assert.equal(matchesLocationHierarchy(loc, india), true, loc);
});

test("includeRemote=false drops plain Remote; State/City selections require that State/City", () => {
  const noRemote = { country: "India", state: "", city: "", includeRemote: false };
  assert.equal(matchesLocationHierarchy("Remote", noRemote), false);
  assert.equal(matchesLocationHierarchy("Remote - India", noRemote), true);
  const pune = { country: "India", state: "Maharashtra", city: "Pune", includeRemote: false };
  assert.equal(matchesLocationHierarchy("Pune, India", pune), true);
  assert.equal(matchesLocationHierarchy("India", pune), false);
  assert.equal(matchesLocationHierarchy("Bengaluru, India", pune), false);
  assert.equal(matchesLocationHierarchy("Pune, Oregon, USA", pune), false);
});


test("picker lists have no duplicate entries (duplicate React keys left stale options)", () => {
  for (const c of WORLD_LOCATION_CATALOG) {
    const states = getStatesForCountry(c.country).map((s) => s.state);
    assert.equal(new Set(states).size, states.length, `${c.country} states`);
    const all = getCitiesForState(c.country, "").map((x) => x.name);
    assert.equal(new Set(all).size, all.length, `${c.country} all cities`);
    for (const s of c.states) {
      const names = getCitiesForState(c.country, s.state).map((x) => x.name);
      assert.equal(new Set(names).size, names.length, `${c.country}/${s.state}`);
    }
  }
  // Shared NCR cities are still reachable from the country-wide list.
  const india = getCitiesForState("India", "").map((x) => x.name);
  for (const n of ["Gurugram", "Noida", "Faridabad", "Bengaluru"]) assert.ok(india.includes(n), n);
});
