"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calculator, House, ReceiptText } from "lucide-react";
import { useShellNavState } from "@/components/nav-lock";

/**
 * Shared bottom tab bar, rendered once by the (shell) route-group layout —
 * individual pages never render it themselves. Adding/removing a nav item or
 * restyling the bar happens in exactly one place.
 *
 * Lock state (taps disabled, e.g. while a sale is awaiting payment) comes from
 * the NavLock context — pages set it with useNavLock(condition).
 *
 * Tabs: Check out (sale flow: /items → /tips → /terminal — also where `/`
 * lands once the host resolves), Home (dashboard, gear there leads to
 * /settings), History. Settings pages show no active tab.
 *
 * Design system: a nav rail takes no container of its own — it sits on the
 * page surface, each item hugs its label, and the current item is marked by
 * a container-surface pill with shadow-1 (never by label weight, which stays
 * constant so the rail doesn't twitch between tabs).
 */
export function BottomNav() {
  const pathname = usePathname();
  const { locked, hidden } = useShellNavState();
  const currentPath = pathname?.replace(/\/+$/, "") || "/";

  if (hidden) return null;

  const isCheckout =
    currentPath === "/" ||
    currentPath.startsWith("/items") ||
    currentPath.startsWith("/terminal") ||
    currentPath.startsWith("/tips");
  const isHome = currentPath.startsWith("/home");
  const isHistory = currentPath.startsWith("/history");

  const tab = (active: boolean) =>
    [
      "flex flex-col items-center gap-0.5 rounded-full px-4 py-1.5 text-label-s transition-colors",
      active
        ? "bg-surface-container text-fg-primary shadow-1"
        : "text-fg-secondary hover:bg-surface-container hover:text-fg-primary",
      locked ? "pointer-events-none cursor-not-allowed opacity-50" : "",
    ].join(" ");

  return (
    <nav className="shrink-0 bg-surface-main px-6 pt-2 pb-3">
      <div className="flex justify-around items-center max-w-md mx-auto">
        <Link
          href="/terminal"
          aria-disabled={locked}
          aria-current={isCheckout ? "page" : undefined}
          className={tab(isCheckout)}
        >
          <Calculator className="size-6" aria-hidden />
          <span>Check out</span>
        </Link>
        <Link
          href="/home"
          aria-disabled={locked}
          aria-current={isHome ? "page" : undefined}
          className={tab(isHome)}
        >
          <House className="size-6" aria-hidden />
          <span>Home</span>
        </Link>
        <Link
          href="/history"
          aria-disabled={locked}
          aria-current={isHistory ? "page" : undefined}
          className={tab(isHistory)}
        >
          <ReceiptText className="size-6" aria-hidden />
          <span>History</span>
        </Link>
      </div>
    </nav>
  );
}
