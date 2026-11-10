import { LogOut, UserRound } from "lucide-react";

/**
 * Who is signed in, with a way to the account page and a sign-out.
 *
 * Rendered only on a hosted deployment, where the sign-in gateway sits in
 * front of this app (see lib/gateway-account.mjs); `account` is null on a local
 * run and this draws nothing.
 *
 * Both targets are plain document navigations, not router links: /account and
 * /logout are answered by the gateway, and this app has no route for either.
 * Sign-out is a form POST because the gateway deliberately ignores a GET (a
 * link on another site could otherwise sign the user out).
 */
export function AccountMenu({ account }) {
  if (!account) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Account</span>
        {account.kind === "owner" && <span className="font-mono text-[10px] text-faint">OWNER</span>}
      </div>
      <div className="flex items-center gap-1">
        <a
          href="/account"
          title={account.label}
          className="flex min-h-[36px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          <UserRound className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{account.label}</span>
        </a>
        <form method="POST" action="/logout" className="shrink-0">
          <button
            type="submit"
            aria-label="Sign out"
            title="Sign out"
            className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </form>
      </div>
    </div>
  );
}
