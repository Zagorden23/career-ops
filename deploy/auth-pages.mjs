/**
 * deploy/auth-pages.mjs
 * Server-rendered sign-in, sign-up, code-entry, password-reset and account
 * pages for the Career Ops gateway.
 *
 * Plain HTML forms with no script: every step is a form post answered by a
 * redirect or a re-rendered page, so the flow works with JavaScript off and
 * under the gateway's strict Content-Security-Policy. Zero external assets
 * (inline CSS, inline SVG).
 *
 * Every value that did not come from this file is escaped at the point it is
 * written into the page.
 */

const STYLE = `
:root {
  --bg: #090a0f; --card-bg: #12141c; --card-border: #232738;
  --text-main: #f1f3f9; --text-muted: #8b92a8; --text-faint: #555b72;
  --accent: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.25);
  --error-bg: #2d1519; --error-border: #601c24; --error-text: #f87171;
  --ok-bg: #11251e; --ok-border: #1c4b37; --ok-text: #34d399;
  --input-bg: #0d0f17; --input-border: #2b3044;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background-color: var(--bg); color: var(--text-main);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem;
  background-image:
    radial-gradient(ellipse at 50% 20%, rgba(59, 130, 246, 0.12) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 80%, rgba(139, 92, 246, 0.08) 0%, transparent 50%);
}
.container { width: 100%; max-width: 440px; }
.header { text-align: center; margin-bottom: 1.75rem; }
.logo-badge {
  display: inline-flex; align-items: center; justify-content: center; width: 54px; height: 54px;
  border-radius: 14px; background: linear-gradient(135deg, #1e2538 0%, #101422 100%);
  border: 1px solid var(--card-border); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 16px var(--accent-glow);
  margin-bottom: 1rem;
}
.title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; margin-bottom: 0.35rem; }
.subtitle { font-size: 0.875rem; color: var(--text-muted); }
.card {
  background-color: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px;
  padding: 1.75rem; box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5);
}
.card + .card { margin-top: 1rem; }
.card h2 { font-size: 1.05rem; font-weight: 650; margin-bottom: 0.35rem; }
.card p.lead { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 1.25rem; line-height: 1.5; }
.alert {
  padding: 0.75rem 1rem; border-radius: 10px; font-size: 0.85rem; margin-bottom: 1.25rem;
  display: flex; align-items: flex-start; gap: 0.5rem; line-height: 1.4;
}
.alert-error { background-color: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text); }
.alert-notice { background-color: var(--ok-bg); border: 1px solid var(--ok-border); color: var(--ok-text); }
.tabs {
  display: flex; gap: 0.25rem; padding: 0.25rem; margin-bottom: 1.25rem;
  background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 10px;
}
.tab {
  flex: 1; text-align: center; padding: 0.5rem 0.25rem; border-radius: 7px; font-size: 0.8125rem;
  font-weight: 600; color: var(--text-muted); text-decoration: none;
}
.tab:hover { color: var(--text-main); }
.tab[aria-current="page"] { background: #1c2233; color: var(--text-main); }
.field { margin-bottom: 1.1rem; }
label {
  display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-muted);
  margin-bottom: 0.45rem; text-transform: uppercase; letter-spacing: 0.05em;
}
.hint { font-size: 0.75rem; color: var(--text-faint); margin-top: 0.4rem; line-height: 1.4; }
input[type="text"], input[type="password"], input[type="email"], input[type="tel"] {
  width: 100%; padding: 0.75rem 0.875rem; background-color: var(--input-bg);
  border: 1px solid var(--input-border); border-radius: 8px; color: var(--text-main);
  font-size: 0.9375rem; outline: none; transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
input.code { font-size: 1.5rem; letter-spacing: 0.45em; text-align: center; font-variant-numeric: tabular-nums; }
.btn {
  display: flex; align-items: center; justify-content: center; gap: 0.6rem; width: 100%;
  padding: 0.8125rem; border-radius: 8px; font-size: 0.9375rem; font-weight: 600; cursor: pointer;
  text-decoration: none; transition: transform 0.1s ease, filter 0.15s ease;
}
.btn:hover { filter: brightness(1.1); }
.btn:active { transform: scale(0.99); }
.btn:focus-visible, .tab:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn-submit {
  background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%); border: 1px solid #1d4ed8;
  color: #fff; box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35); margin-top: 0.25rem;
}
.btn-secondary { background: var(--input-bg); border: 1px solid var(--input-border); color: var(--text-main); }
.btn-danger { background: #3a1217; border: 1px solid #7f1d1d; color: #fca5a5; }
.btn-link {
  background: none; border: 0; color: #93b4f8; font-size: 0.8125rem; cursor: pointer;
  padding: 0; font-weight: 500; font-family: inherit;
}
.btn-link:hover { text-decoration: underline; }
.divider {
  display: flex; align-items: center; gap: 0.75rem; margin: 1.25rem 0;
  font-size: 0.75rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.08em;
}
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--card-border); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-top: 1rem; font-size: 0.8125rem; }
.row a, .switch a, .footer a { color: #93b4f8; text-decoration: none; }
.row a:hover, .switch a:hover, .footer a:hover { text-decoration: underline; }
.switch { text-align: center; margin-top: 1.25rem; font-size: 0.875rem; color: var(--text-muted); }
.footer { text-align: center; margin-top: 1.5rem; font-size: 0.75rem; color: var(--text-faint); line-height: 1.6; }
dl.facts { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; font-size: 0.875rem; }
dl.facts dt { color: var(--text-muted); }
dl.facts dd { word-break: break-word; }
.stack > * + * { margin-top: 0.75rem; }
`;

const LOGO = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>`;

const GOOGLE_MARK = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function shell({ title, subtitle = "Your private job search workspace", body, footer = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} &middot; Career Ops</title>
  <meta name="robots" content="noindex, nofollow, noarchive">
  <style>${STYLE}</style>
</head>
<body>
  <main class="container">
    <div class="header">
      <div class="logo-badge">${LOGO}</div>
      <h1 class="title">Career Ops</h1>
      <p class="subtitle">${escapeHtml(subtitle)}</p>
    </div>
    ${body}
    ${footer ? `<div class="footer">${footer}</div>` : ""}
  </main>
</body>
</html>`;
}

function alerts({ error, notice }) {
  return `${error ? `<div class="alert alert-error" role="alert"><span aria-hidden="true">&#9888;</span><span>${escapeHtml(error)}</span></div>` : ""}${
    notice ? `<div class="alert alert-notice" role="status"><span aria-hidden="true">&#10003;</span><span>${escapeHtml(notice)}</span></div>` : ""
  }`;
}

function csrfField(csrfToken) {
  return `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken || "")}">`;
}

/**
 * The sign-in / create-account page.
 *
 * @param {object} options
 * @param {"login" | "signup"} [options.mode]
 * @param {"password" | "email" | "phone"} [options.method]
 * @param {{ email?: boolean, phone?: boolean, google?: boolean, signup?: boolean, reset?: boolean }} [options.methods]
 *   Which options this deployment offers. Password sign-in is always available.
 * @param {string} options.csrfToken
 * @param {string | null} [options.error]
 * @param {string | null} [options.notice]
 * @param {{ identifier?: string, email?: string, phone?: string, name?: string }} [options.values]
 */
export function renderAuthPage({
  mode = "login",
  method = "password",
  methods = {},
  csrfToken,
  error = null,
  notice = null,
  values = {},
} = {}) {
  const isSignup = mode === "signup";
  const base = isSignup ? "/signup" : "/login";
  const hasAccounts = Boolean(methods.accounts || methods.signup || methods.email || methods.phone || methods.google);
  const available = hasAccounts ? ["password", "email", "phone"] : ["password"];
  const current = available.includes(method) ? method : "password";
  const labels = { password: "Password", email: "Email code", phone: "Phone code" };

  const tabs =
    available.length > 1
      ? `<nav class="tabs" aria-label="Sign-in method">${available
          .map(
            (m) =>
              `<a class="tab" href="${base}?method=${m}"${m === current ? ' aria-current="page"' : ""}>${labels[m]}</a>`,
          )
          .join("")}</nav>`
      : "";

  const google = hasAccounts
    ? `<a class="btn btn-secondary" href="/auth/google">${GOOGLE_MARK}<span>${isSignup ? "Sign up with Google" : "Continue with Google"}</span></a>
       <div class="divider">or</div>`
    : "";

  let form;
  if (isSignup && !methods.signup) {
    form = `<p class="lead">New accounts are not being accepted on this deployment right now. If you already have an account, sign in.</p>
      <a class="btn btn-secondary" href="/login">Go to sign in</a>`;
  } else if (current === "email") {
    form = `<form method="POST" action="/auth/otp/start" autocomplete="on">
        ${csrfField(csrfToken)}
        <input type="hidden" name="channel" value="email">
        <input type="hidden" name="intent" value="${isSignup ? "signup" : "login"}">
        <div class="field">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autofocus autocomplete="email" inputmode="email" placeholder="you@example.com" value="${escapeHtml(values.email || "")}">
          <p class="hint">We will email you a 6-digit code. No password needed.</p>
        </div>
        <button type="submit" class="btn btn-submit">Email me a code</button>
      </form>`;
  } else if (current === "phone") {
    form = `<form method="POST" action="/auth/otp/start" autocomplete="on">
        ${csrfField(csrfToken)}
        <input type="hidden" name="channel" value="phone">
        <input type="hidden" name="intent" value="${isSignup ? "signup" : "login"}">
        <div class="field">
          <label for="phone">Mobile number</label>
          <input type="tel" id="phone" name="phone" required autofocus autocomplete="tel" inputmode="tel" placeholder="+91 98765 43210" value="${escapeHtml(values.phone || "")}">
          <p class="hint">Include your country code. We will text you a 6-digit code; carrier charges may apply.</p>
        </div>
        <button type="submit" class="btn btn-submit">Text me a code</button>
      </form>`;
  } else if (isSignup) {
    form = `<form method="POST" action="/signup" autocomplete="on">
        ${csrfField(csrfToken)}
        <div class="field">
          <label for="name">Name <span style="text-transform:none;letter-spacing:0;font-weight:400">(optional)</span></label>
          <input type="text" id="name" name="name" autocomplete="name" maxlength="80" value="${escapeHtml(values.name || "")}">
        </div>
        <div class="field">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autofocus autocomplete="email" inputmode="email" placeholder="you@example.com" value="${escapeHtml(values.email || "")}">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required minlength="8" maxlength="128" autocomplete="new-password">
          <p class="hint">At least 8 characters.</p>
        </div>
        <button type="submit" class="btn btn-submit">Create account</button>
      </form>`;
  } else {
    form = `<form method="POST" action="/login" autocomplete="on">
        ${csrfField(csrfToken)}
        <div class="field">
          <label for="username">Email or username</label>
          <input type="text" id="username" name="username" required autofocus autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(values.identifier || "")}">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-submit">Sign in</button>
        ${methods.reset ? `<div class="row"><span></span><a href="/auth/forgot">Forgot password?</a></div>` : ""}
      </form>`;
  }

  const showMethods = !(isSignup && !methods.signup);
  const switchLine = isSignup
    ? `<p class="switch">Already have an account? <a href="/login">Sign in</a></p>`
    : methods.signup
      ? `<p class="switch">New here? <a href="/signup">Create an account</a></p>`
      : "";

  return shell({
    title: isSignup ? "Create account" : "Sign in",
    body: `<div class="card">
      <h2>${isSignup ? "Create your account" : "Sign in"}</h2>
      <p class="lead">${
        isSignup
          ? "Each account gets its own private workspace. Nothing in it is visible to other accounts."
          : "Welcome back. Choose how you want to sign in."
      }</p>
      ${alerts({ error, notice })}
      ${showMethods ? google : ""}
      ${showMethods ? tabs : ""}
      ${form}
      ${switchLine}
    </div>`,
    footer: `Sessions are private to this browser. <a href="/login">Sign in</a>${methods.signup ? ` &middot; <a href="/signup">Create account</a>` : ""}`,
  });
}

/** Kept for callers that only ever render the sign-in view. */
export function renderLoginPage(options = {}) {
  return renderAuthPage({ ...options, mode: "login" });
}

/**
 * The page where a 6-digit code is entered.
 * @param {object} options
 * @param {string} options.csrfToken
 * @param {string} options.challengeId
 * @param {"email" | "phone"} options.channel
 * @param {string} options.destinationMasked
 * @param {"login" | "signup" | "reset"} options.purpose
 */
export function renderVerifyPage({ csrfToken, challengeId, channel, destinationMasked, purpose, error = null, notice = null }) {
  const isReset = purpose === "reset";
  const where = channel === "phone" ? "by text message to" : "by email to";
  return shell({
    title: "Enter your code",
    body: `<div class="card">
      <h2>${isReset ? "Reset your password" : "Enter your code"}</h2>
      <p class="lead">If <strong>${escapeHtml(destinationMasked)}</strong> can be used here, a 6-digit code was sent ${where} it. The code expires in 10 minutes.</p>
      ${alerts({ error, notice })}
      <form method="POST" action="/auth/verify" autocomplete="off">
        ${csrfField(csrfToken)}
        <input type="hidden" name="c" value="${escapeHtml(challengeId)}">
        <div class="field">
          <label for="code">6-digit code</label>
          <input class="code" type="text" id="code" name="code" required autofocus inputmode="numeric" pattern="[0-9 ]{6,8}" maxlength="8" autocomplete="one-time-code">
        </div>
        ${
          isReset
            ? `<div class="field">
          <label for="new_password">New password</label>
          <input type="password" id="new_password" name="new_password" required minlength="8" maxlength="128" autocomplete="new-password">
          <p class="hint">At least 8 characters. You will be signed out on your other devices.</p>
        </div>`
            : ""
        }
        <button type="submit" class="btn btn-submit">${isReset ? "Set new password" : "Verify and continue"}</button>
      </form>
      <div class="row">
        <form method="POST" action="/auth/otp/resend">
          ${csrfField(csrfToken)}
          <input type="hidden" name="c" value="${escapeHtml(challengeId)}">
          <button type="submit" class="btn-link">Send a new code</button>
        </form>
        <a href="/login">Use a different method</a>
      </div>
    </div>`,
  });
}

export function renderForgotPage({ csrfToken, error = null, notice = null, values = {} }) {
  return shell({
    title: "Reset password",
    body: `<div class="card">
      <h2>Reset your password</h2>
      <p class="lead">Enter the email address on your account. We will send a code you can use to choose a new password.</p>
      ${alerts({ error, notice })}
      <form method="POST" action="/auth/forgot" autocomplete="on">
        ${csrfField(csrfToken)}
        <div class="field">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" required autofocus autocomplete="email" inputmode="email" value="${escapeHtml(values.email || "")}">
        </div>
        <button type="submit" class="btn btn-submit">Send reset code</button>
      </form>
      <p class="switch"><a href="/login">Back to sign in</a></p>
    </div>`,
  });
}

/**
 * The signed-in account page.
 * @param {object} options
 * @param {string} options.csrfToken The session's CSRF token
 * @param {{ kind: "owner" | "user", label: string, name?: string | null, email?: string | null, phone?: string | null, googleLinked?: boolean, hasPassword?: boolean }} options.account
 */
export function renderAccountPage({ csrfToken, account, error = null, notice = null }) {
  const isOwner = account.kind === "owner";
  const facts = [
    account.name ? ["Name", account.name] : null,
    isOwner ? ["Signed in as", `${account.label} (deployment owner)`] : null,
    account.email ? ["Email", account.email] : null,
    account.phone ? ["Phone", account.phone] : null,
    !isOwner ? ["Google", account.googleLinked ? "Connected" : "Not connected"] : null,
    !isOwner ? ["Password", account.hasPassword ? "Set" : "Not set"] : null,
  ].filter(Boolean);

  const passwordCard = isOwner
    ? `<div class="card">
        <h2>Password</h2>
        <p class="lead" style="margin-bottom:0">The owner password is set by the deployment's environment (CAREER_OPS_AUTH_PASSWORD_HASH). Change it there and redeploy.</p>
      </div>`
    : `<div class="card">
        <h2>${account.hasPassword ? "Change password" : "Set a password"}</h2>
        <p class="lead">${
          account.hasPassword
            ? "Your other devices will be signed out."
            : "Add a password so you can also sign in without a code."
        }</p>
        <form method="POST" action="/account/password" autocomplete="off">
          ${csrfField(csrfToken)}
          ${
            account.hasPassword
              ? `<div class="field">
            <label for="current_password">Current password</label>
            <input type="password" id="current_password" name="current_password" required autocomplete="current-password">
          </div>`
              : ""
          }
          <div class="field">
            <label for="new_password">New password</label>
            <input type="password" id="new_password" name="new_password" required minlength="8" maxlength="128" autocomplete="new-password">
            <p class="hint">At least 8 characters.</p>
          </div>
          <button type="submit" class="btn btn-secondary">${account.hasPassword ? "Change password" : "Set password"}</button>
        </form>
      </div>`;

  const deleteCard = isOwner
    ? ""
    : `<div class="card">
        <h2>Delete account</h2>
        <p class="lead">This permanently deletes your account and everything in your workspace: CV, tracker, reports and generated files. It cannot be undone.</p>
        <form method="POST" action="/account/delete" autocomplete="off">
          ${csrfField(csrfToken)}
          <div class="field">
            <label for="confirm">Type DELETE to confirm</label>
            <input type="text" id="confirm" name="confirm" required autocomplete="off" autocapitalize="characters" spellcheck="false">
          </div>
          <button type="submit" class="btn btn-danger">Delete my account and data</button>
        </form>
      </div>`;

  return shell({
    title: "Account",
    subtitle: "Account and sign-in settings",
    body: `<div class="card">
        <h2>Your account</h2>
        ${alerts({ error, notice })}
        <dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
        <div class="stack" style="margin-top:1.25rem">
          <a class="btn btn-submit" href="/">Back to Career Ops</a>
          <form method="POST" action="/logout">
            ${csrfField(csrfToken)}
            <button type="submit" class="btn btn-secondary">Sign out</button>
          </form>
          <form method="POST" action="/account/logout-all">
            ${csrfField(csrfToken)}
            <button type="submit" class="btn btn-secondary">Sign out on all devices</button>
          </form>
        </div>
      </div>
      ${passwordCard}
      ${deleteCard}`,
  });
}

/** A one-message page: an error with a way back, or a "try again shortly". */
export function renderMessagePage({ title, message, linkHref = "/login", linkLabel = "Back to sign in", form = null }) {
  return shell({
    title,
    body: `<div class="card">
      <h2>${escapeHtml(title)}</h2>
      <p class="lead">${escapeHtml(message)}</p>
      ${
        form
          ? `<form method="POST" action="${escapeHtml(form.action)}">${csrfField(form.csrfToken)}<button type="submit" class="btn btn-submit">${escapeHtml(form.label)}</button></form>`
          : `<a class="btn btn-secondary" href="${escapeHtml(linkHref)}">${escapeHtml(linkLabel)}</a>`
      }
    </div>`,
  });
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
