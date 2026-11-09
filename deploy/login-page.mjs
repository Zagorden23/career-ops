/**
 * deploy/login-page.mjs
 * Professional, self-contained login page HTML for Career Ops on Render.
 * Zero external asset dependencies (inline CSS, inline SVG).
 * Styled to seamlessly match Career Ops modern dark-mode aesthetics.
 */

export function renderLoginPage({ csrfToken, error = null, notice = null } = {}) {
  const safeError = error ? escapeHtml(error) : null;
  const safeNotice = notice ? escapeHtml(notice) : null;
  const safeCsrfToken = csrfToken ? escapeHtml(csrfToken) : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Career Ops &mdash; Private Access</title>
  <meta name="robots" content="noindex, nofollow, noarchive">
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12141c;
      --card-border: #232738;
      --text-main: #f1f3f9;
      --text-muted: #8b92a8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-glow: rgba(59, 130, 246, 0.25);
      --error-bg: #2d1519;
      --error-border: #601c24;
      --error-text: #f87171;
      --input-bg: #0d0f17;
      --input-border: #2b3044;
      --input-focus: #3b82f6;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      background-image: 
        radial-gradient(ellipse at 50% 20%, rgba(59, 130, 246, 0.12) 0%, transparent 60%),
        radial-gradient(ellipse at 80% 80%, rgba(139, 92, 246, 0.08) 0%, transparent 50%);
    }
    .container {
      width: 100%;
      max-width: 420px;
    }
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .logo-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 54px;
      height: 54px;
      border-radius: 14px;
      background: linear-gradient(135deg, #1e2538 0%, #101422 100%);
      border: 1px solid var(--card-border);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 16px var(--accent-glow);
      margin-bottom: 1rem;
    }
    .title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: var(--text-main);
      margin-bottom: 0.35rem;
    }
    .subtitle {
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 2rem;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
    }
    .alert {
      padding: 0.75rem 1rem;
      border-radius: 10px;
      font-size: 0.85rem;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      line-height: 1.4;
    }
    .alert-error {
      background-color: var(--error-bg);
      border: 1px solid var(--error-border);
      color: var(--error-text);
    }
    .alert-notice {
      background-color: #11251e;
      border: 1px solid #1c4b37;
      color: #34d399;
    }
    .field {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 0.75rem 0.875rem;
      background-color: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 8px;
      color: var(--text-main);
      font-size: 0.9375rem;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input[type="text"]:focus,
    input[type="password"]:focus {
      border-color: var(--input-focus);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .btn-submit {
      width: 100%;
      padding: 0.8125rem;
      background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%);
      border: 1px solid #1d4ed8;
      border-radius: 8px;
      color: #ffffff;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s ease, filter 0.15s ease;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
      margin-top: 0.5rem;
    }
    .btn-submit:hover {
      filter: brightness(1.1);
    }
    .btn-submit:active {
      transform: scale(0.99);
    }
    .footer {
      text-align: center;
      margin-top: 1.75rem;
      font-size: 0.75rem;
      color: #555b72;
    }
    .lock-icon {
      vertical-align: middle;
      margin-right: 0.25rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo-badge" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
      </div>
      <h1 class="title">Career Ops</h1>
      <p class="subtitle">Private Pipeline &amp; Career Operations</p>
    </div>

    <div class="card">
      ${safeError ? `<div class="alert alert-error" role="alert"><span>&#9888;</span><span>${safeError}</span></div>` : ""}
      ${safeNotice ? `<div class="alert alert-notice"><span>&#10003;</span><span>${safeNotice}</span></div>` : ""}

      <form method="POST" action="/login" autocomplete="on">
        <input type="hidden" name="csrf_token" value="${safeCsrfToken}">
        
        <div class="field">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username" placeholder="Owner username">
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" placeholder="Enter owner password">
        </div>

        <button type="submit" class="btn-submit">Sign In</button>
      </form>
    </div>

    <div class="footer">
      <svg class="lock-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
      </svg>
      Protected single-owner deployment &bull; Render Persistent Disk
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
