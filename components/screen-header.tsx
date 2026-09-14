import type { ReactNode } from "react";

/**
 * Title bar shared by the tab pages (Home, Check out, History). Always
 * reserves a 40px action slot on the right — the Settings gear on Home, an
 * empty spacer elsewhere — so the header is the same height on every tab and
 * the content below it (the big amount, the list) doesn't jump when switching
 * tabs.
 *
 * The title is `text-display-l` (Manrope, 32/40, semibold): the one display
 * style a page title takes. Headings are never bold.
 */
export function ScreenHeader({
  title,
  action,
  testId,
}: {
  title: string;
  /** Optional right-hand control (a 40×40 tap target, e.g. `p-2` around a 24px icon). */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <header className="flex items-center justify-between px-6 py-5 shrink-0">
      <h1 data-testid={testId} className="text-display-l text-fg-primary">
        {title}
      </h1>
      {action ?? <div className="size-10 shrink-0" aria-hidden />}
    </header>
  );
}
