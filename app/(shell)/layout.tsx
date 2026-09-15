"use client";

import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { NavLockProvider } from "@/components/nav-lock";

/**
 * App shell for every page that shows the bottom tab bar. Owns the one
 * full-height frame (pages only render their content, sized with flex-1) and
 * renders BottomNav exactly once — change nav or frame here, it applies
 * everywhere. Routes without the nav (e.g. `/`) live outside this group.
 *
 * The content region is a min-h-0 flex column: pages scroll internally
 * (overflow on their own main areas) and the nav stays pinned and visible.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <NavLockProvider>
      <div className="flex h-dvh flex-col bg-surface-main">
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <BottomNav />
      </div>
    </NavLockProvider>
  );
}
