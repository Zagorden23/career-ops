import { test } from "node:test";
import assert from "node:assert/strict";
import { readGatewayAccount } from "../../src/lib/gateway-account.mjs";

const headers = (map) => ({ get: (name) => map[name] ?? null });
const GATEWAY = { CAREER_OPS_GATEWAY: "1" };

test("a local run shows no account, whatever headers a caller sends", () => {
  const forged = headers({ "x-career-ops-account": "admin", "x-career-ops-account-kind": "owner" });
  assert.equal(readGatewayAccount(forged, {}), null);
  assert.equal(readGatewayAccount(forged, { CAREER_OPS_GATEWAY: "0" }), null);
  assert.equal(readGatewayAccount(forged, undefined), null);
});

test("behind the gateway the forwarded account is decoded for display", () => {
  assert.deepEqual(
    readGatewayAccount(headers({ "x-career-ops-account": "jane%40example.com", "x-career-ops-account-kind": "user" }), GATEWAY),
    { label: "jane@example.com", kind: "user" },
  );
  assert.deepEqual(
    readGatewayAccount(headers({ "x-career-ops-account": "admin", "x-career-ops-account-kind": "owner" }), GATEWAY),
    { label: "admin", kind: "owner" },
  );
  // A non-ASCII name survives the header as percent-encoding.
  assert.equal(
    readGatewayAccount(headers({ "x-career-ops-account": encodeURIComponent("Zoë Müller") }), GATEWAY).label,
    "Zoë Müller",
  );
  // Anything but "owner" is a regular account: the label never upgrades itself.
  assert.equal(
    readGatewayAccount(headers({ "x-career-ops-account": "x", "x-career-ops-account-kind": "admin" }), GATEWAY).kind,
    "user",
  );
});

test("a missing or malformed header shows nothing rather than garbage", () => {
  assert.equal(readGatewayAccount(headers({}), GATEWAY), null);
  assert.equal(readGatewayAccount(headers({ "x-career-ops-account": "" }), GATEWAY), null);
  assert.equal(readGatewayAccount(headers({ "x-career-ops-account": "%E0%A4%A" }), GATEWAY), null);
  assert.equal(readGatewayAccount(headers({ "x-career-ops-account": "%00%1F%20" }), GATEWAY), null);
  assert.equal(readGatewayAccount(headers({ "x-career-ops-account": "a".repeat(600) }), GATEWAY).label.length, 254);
});
