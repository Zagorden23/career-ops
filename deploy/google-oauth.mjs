/**
 * deploy/google-oauth.mjs
 * "Continue with Google": the OpenID Connect authorization-code flow with PKCE.
 *
 * The browser is sent to Google with a `state`, a `nonce` and a PKCE challenge.
 * Google sends it back with a one-time `code`, which this server exchanges
 * directly with Google for an ID token.
 *
 * The ID token's signature is not re-verified here, deliberately. It arrives
 * over TLS straight from Google's token endpoint in answer to a request
 * authenticated with the client secret, which is the case OpenID Connect Core
 * §3.1.3.7 says may rely on TLS server validation in place of checking the
 * token signature. The claims are still checked in full: issuer, audience,
 * expiry, the nonce this server issued, and that Google has verified the email.
 */

import crypto from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const HTTP_TIMEOUT_MS = 15_000;

/** @returns {{ verifier: string, challenge: string }} */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * @param {object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 */
export function createGoogleOAuth({ clientId, clientSecret, fetchImpl = fetch, now = Date.now }) {
  if (!clientId || !clientSecret) throw new Error("Google OAuth needs a client id and a client secret");

  return {
    clientId,

    /** The URL the browser is redirected to. */
    buildAuthUrl({ redirectUri, state, nonce, codeChallenge }) {
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.toString();
    },

    /**
     * Trade the authorization code for verified identity claims.
     * @returns {Promise<{ sub: string, email: string, name: string | null }>}
     */
    async exchangeCode({ code, redirectUri, codeVerifier, nonce }) {
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        // handled below: no usable body
      }
      if (!res.ok || !data?.id_token) {
        // Google's error code ("invalid_grant", "redirect_uri_mismatch") is what
        // an operator needs; the rest of the body is not logged.
        const reason = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
        throw new Error(`Google token exchange failed: ${reason}`);
      }

      const claims = decodeJwtPayload(data.id_token);
      validateIdTokenClaims(claims, { clientId, nonce, now: now() });
      return {
        sub: String(claims.sub),
        email: String(claims.email).trim().toLowerCase(),
        name: typeof claims.name === "string" ? claims.name : null,
      };
    },
  };
}

/** @param {string} jwt */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new Error("Google returned a malformed ID token");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Google returned an unreadable ID token");
  }
}

/**
 * @param {Record<string, unknown>} claims
 * @param {{ clientId: string, nonce: string, now: number }} expected
 */
export function validateIdTokenClaims(claims, { clientId, nonce, now }) {
  if (!claims || typeof claims !== "object") throw new Error("ID token has no claims");
  if (!ISSUERS.has(String(claims.iss))) throw new Error("ID token was not issued by Google");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error("ID token was issued for a different application");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - 60_000) {
    throw new Error("ID token has expired");
  }
  if (!nonce || claims.nonce !== nonce) throw new Error("ID token does not match this sign-in attempt");
  if (!claims.sub) throw new Error("ID token has no subject");
  if (typeof claims.email !== "string" || !claims.email) throw new Error("Google account has no email address");
  if (claims.email_verified !== true && claims.email_verified !== "true") {
    throw new Error("Google has not verified this email address");
  }
}
