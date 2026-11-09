/**
 * deploy/security-headers.mjs
 * Security headers for Career Ops on Render.
 *
 * Implements CSP, HSTS, frame-ancestors / X-Frame-Options, nosniff,
 * Referrer-Policy, and Permissions-Policy.
 */

export const CSP_HEADER_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const PERMISSIONS_POLICY_VALUE = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "browsing-topics=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * Return security headers to apply to HTTP responses.
 * @param {object} options
 * @param {boolean} [options.isHttps=false] - Whether the incoming request was HTTPS
 * @returns {Record<string, string>}
 */
export function getSecurityHeaders({ isHttps = false } = {}) {
  const headers = {
    "Content-Security-Policy": CSP_HEADER_VALUE,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY_VALUE,
    "X-XSS-Protection": "0",
  };

  if (isHttps) {
    // 2 years HSTS with subdomains and preload recommendation
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }

  return headers;
}
