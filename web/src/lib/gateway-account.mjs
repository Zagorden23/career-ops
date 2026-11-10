// Plain .mjs so tests/lib/gateway-account.test.mjs can import it under Node with
// no build step. Import it with the .mjs extension included.

/**
 * The signed-in account, when the app runs behind the hosted sign-in gateway
 * (deploy/gateway.mjs).
 *
 * The gateway authenticates every request and forwards who it is in two
 * headers. This app never authenticates anyone itself, so it reads them only
 * to SHOW the account and offer a sign-out; nothing is authorized from them.
 *
 * They are honoured only when the supervisor that started this process says a
 * gateway is in front of it (CAREER_OPS_GATEWAY=1). On a local run there is no
 * gateway, the headers would be whatever a caller typed, and the sidebar must
 * not show an account that does not exist.
 *
 * @param {{ get(name: string): string | null }} headers Request headers
 * @param {Record<string, string | undefined>} env
 * @returns {{ label: string, kind: "owner" | "user" } | null}
 */
export function readGatewayAccount(headers, env) {
  if (env?.CAREER_OPS_GATEWAY !== "1") return null;
  const raw = headers?.get?.("x-career-ops-account");
  if (!raw) return null;

  let label;
  try {
    // Percent-encoded by the gateway: a label may hold characters a header cannot.
    label = decodeURIComponent(raw);
  } catch {
    return null; // malformed encoding: show nothing rather than garbage
  }
  label = label.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 254);
  if (!label) return null;

  return { label, kind: headers.get("x-career-ops-account-kind") === "owner" ? "owner" : "user" };
}
