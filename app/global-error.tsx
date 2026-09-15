"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { fontVariablesClassName, THEME_INIT_SCRIPT } from "@/lib/fonts";
import "./globals.css";

/**
 * Last-resort error boundary for unhandled crashes anywhere in the App
 * Router tree. Sentry's `captureUnderscoreErrorException` records the error
 * with the right context (next.js framework metadata, route, etc.) so it
 * shows up grouped in Issues rather than as a generic crash.
 *
 * Replaces the root layout, so it carries its own <html>: the same font
 * variables, theme bootstrap and stylesheet, so it renders in the active
 * theme like every other screen.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className={fontVariablesClassName}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh flex flex-col items-center justify-center p-8 gap-4">
        <h2 className="text-heading-l text-fg-primary">Something went wrong</h2>
        <p className="text-body-m text-fg-secondary max-w-md text-center">
          The terminal hit an unexpected error. Try again, and if it keeps
          happening report it to support.
        </p>
        <Button
          onClick={() => reset()}
          className="mt-2 h-auto w-fit rounded-full px-8 py-3 text-label-l"
        >
          Try again
        </Button>
      </body>
    </html>
  );
}
