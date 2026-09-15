"use client";

import Link from "next/link";
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";

/** A 40×40 icon button: quiet at rest, tertiary hover, circular. */
export const iconButtonClass =
  "inline-flex size-10 items-center justify-center rounded-full text-fg-primary hover:bg-action-tertiary-hover transition-colors";

/**
 * Header for every screen below a tab: back (or close) on the left, the title
 * centred, and a 40px slot on the right — an action when the screen has one,
 * an empty spacer otherwise, so the title stays centred and the header is the
 * same height everywhere.
 */
export function SubpageHeader({
  title,
  backHref,
  onBack,
  backLabel = "Back",
  close = false,
  action,
  testId,
}: {
  title?: string;
  /** Navigate back with a link… */
  backHref?: string;
  /** …or with a handler (in-page state machines). */
  onBack?: () => void;
  backLabel?: string;
  /** Show an ✕ instead of the back arrow (dismissing a flow, not going back). */
  close?: boolean;
  /** Optional right-hand control — a 40×40 tap target, e.g. `iconButtonClass`. */
  action?: ReactNode;
  testId?: string;
}) {
  const Icon = close ? X : ArrowLeft;
  const back = backHref ? (
    <Link href={backHref} className={iconButtonClass} aria-label={backLabel}>
      <Icon className="size-6" />
    </Link>
  ) : onBack ? (
    <button type="button" onClick={onBack} className={iconButtonClass} aria-label={backLabel}>
      <Icon className="size-6" />
    </button>
  ) : (
    <div className="size-10" aria-hidden />
  );

  return (
    <header className="flex items-center justify-between gap-2 px-4 py-4 shrink-0">
      {back}
      <span data-testid={testId} className="min-w-0 truncate text-heading-l text-fg-primary">
        {title}
      </span>
      {action ?? <div className="size-10 shrink-0" aria-hidden />}
    </header>
  );
}
