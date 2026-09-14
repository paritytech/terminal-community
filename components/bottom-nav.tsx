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
 */
export function BottomNav() {
  const pathname = usePathname();
  const { locked, hidden } = useShellNavState();
  const lockClass = locked ? "pointer-events-none opacity-40" : "";
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
    `flex flex-col items-center gap-0.5 transition ${lockClass} ${
      active ? "text-white" : "text-neutral-500 hover:text-neutral-300"
    }`;

  return (
    <nav className="shrink-0 border-t border-neutral-800 bg-black px-6 py-2">
      <div className="flex justify-around items-center max-w-md mx-auto">
        <Link href="/terminal" aria-disabled={locked} className={tab(isCheckout)}>
          <Calculator className="w-5 h-5" />
          <span className="text-[10px] font-medium">Check out</span>
        </Link>
        <Link href="/home" aria-disabled={locked} className={tab(isHome)}>
          <House className="w-5 h-5" />
          <span className="text-[10px] font-medium">Home</span>
        </Link>
        <Link href="/history" aria-disabled={locked} className={tab(isHistory)}>
          <ReceiptText className="w-5 h-5" />
          <span className="text-[10px] font-medium">History</span>
        </Link>
      </div>
    </nav>
  );
}
