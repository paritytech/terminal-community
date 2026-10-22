"use client";

/**
 * Pushes admin-payload identifiers to Sentry's scope as tags so the
 * Performance/Issues dashboards can filter by `merchant_id`, `terminal_id`,
 * and `merchant_key`. Re-runs whenever the payload changes (scan / clear /
 * test-populate) so a freshly bound terminal becomes filterable immediately.
 *
 * Mounted once at the layout root; renders nothing.
 */

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

import { useAdminQrPayload } from "@/lib/config/admin-qr-binding";

export function SentryTags() {
  const payload = useAdminQrPayload();

  useEffect(() => {
    // `undefined` = still loading. Don't clear tags during a transient
    // loading state — only react to the actual null/present transitions.
    if (payload === undefined) return;
    Sentry.setTags({
      merchant_id: payload?.merchantId ?? "",
      terminal_id: payload?.terminalId ?? "",
      merchant_key: payload?.merchantKey ?? "",
      admin_configured: payload !== null,
    });
  }, [payload]);

  return null;
}
