"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { SubpageHeader, iconButtonClass } from "@/components/subpage-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatLogsAsText } from "@/lib/debug/log-capture";

/**
 * Settings → Help us fix an issue: a user problem report. Description +
 * optional screenshots + optional technical details (the captured console
 * log) are sent as one Sentry event with attachments. The logs icon in the
 * header opens the raw log list (/settings/logs).
 */

const MAX_DESCRIPTION = 1200;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg"];

interface Attachment {
  file: File;
  id: string;
}

type SendState = "form" | "sending" | "error" | "success";

function formatSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

// The screen's one main action, wherever the flow is: primary pill, full
// width because it sits in the bottom slot.
const PRIMARY_PILL =
  "mt-8 w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100";

export default function ReportIssuePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [includeTechnical, setIncludeTechnical] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>("form");

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFileError(null);
    const next: Attachment[] = [];
    for (const file of Array.from(list)) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setFileError(`${file.name}: only PNG or JPG screenshots are supported.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setFileError(`${file.name}: larger than 10 MB.`);
        continue;
      }
      next.push({ file, id: `${file.name}-${file.size}-${file.lastModified}` });
    }
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.id));
      return [...prev, ...next.filter((a) => !seen.has(a.id))];
    });
  };

  const handleSend = async () => {
    setSendState("sending");
    try {
      const fileBuffers = await Promise.all(
        attachments.map(async ({ file }) => ({
          filename: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        })),
      );

      Sentry.withScope((scope) => {
        scope.setTag("report.kind", "user-report");
        scope.setExtra("description", description);
        for (const attachment of fileBuffers) scope.addAttachment(attachment);
        if (includeTechnical) {
          scope.addAttachment({ filename: "console-logs.txt", data: formatLogsAsText() });
        }
        Sentry.captureMessage(
          `User report: ${description.slice(0, 120)}`,
          "info",
        );
      });

      // flush() actually pushes the event out — its result is the only real
      // "did it leave the device" signal we have.
      const flushed = await Sentry.flush(5000);
      setSendState(flushed ? "success" : "error");
    } catch {
      setSendState("error");
    }
  };

  /* ── Sending / outcome overlays ─────────────────────────────── */

  if (sendState === "sending") {
    return (
      <FullScreen>
        <Loader2 className="size-8 animate-spin text-fg-secondary mb-6" aria-hidden />
        <p className="text-heading-l text-fg-primary">Sending…</p>
      </FullScreen>
    );
  }

  if (sendState === "error") {
    return (
      <FullScreen onClose={() => setSendState("form")}>
        <div className="size-14 rounded-full bg-status-error text-fg-static-white flex items-center justify-center mb-6">
          <X className="size-6" strokeWidth={3} aria-hidden />
        </div>
        <p className="text-heading-l text-fg-primary text-center mb-10">
          Couldn&apos;t send.
          <br />
          Try again
        </p>
        <div className="flex-1" />
        <Button onClick={handleSend} className={PRIMARY_PILL}>
          Retry
        </Button>
      </FullScreen>
    );
  }

  if (sendState === "success") {
    return (
      <FullScreen onClose={() => router.push("/settings")}>
        <div className="size-14 rounded-full bg-status-success text-fg-static-white flex items-center justify-center mb-6">
          <Check className="size-6" strokeWidth={3} aria-hidden />
        </div>
        <p className="text-heading-l text-fg-primary text-center mb-10">
          Thanks! for your feedback we&apos;ll look into it
        </p>
        <div className="flex-1" />
        <Button onClick={() => router.push("/settings")} className={PRIMARY_PILL}>
          Done
        </Button>
      </FullScreen>
    );
  }

  /* ── Form ───────────────────────────────────────────────────── */

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header — logs shortcut on the right */}
        <SubpageHeader
          title="Report a problem"
          backHref="/settings"
          backLabel="Back to settings"
          action={
            <Link href="/settings/logs" className={iconButtonClass} aria-label="View logs">
              <ScrollText className="size-6" />
            </Link>
          }
        />

        <main className="flex-1 min-h-0 overflow-y-auto flex flex-col px-6 pb-6">
          <h1 className="text-heading-l text-fg-primary">Describe what happened</h1>
          <p className="text-body-m text-fg-secondary mb-4">
            What were you doing when it went wrong?
          </p>

          {/* Description — a control draws its own hairline */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-baseline">
              <Label htmlFor="report-description" className="text-label-m text-fg-secondary">
                Tell us what happened…
              </Label>
              <span className="text-caption font-mono text-fg-tertiary">
                {description.length}/{MAX_DESCRIPTION}
              </span>
            </div>
            <Textarea
              id="report-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={MAX_DESCRIPTION}
              rows={5}
              className="resize-none"
            />
          </div>

          {/* Screenshots — a container; attachments sit on the nested step */}
          <div className="mt-4 rounded-nested bg-surface-container p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-label-l text-fg-primary">Add screenshot</p>
                <p className="text-body-m text-fg-secondary mt-0.5">
                  Add a screenshot to help us understand (PNG or JPG, max 10 MB)
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach screenshot"
                className={`${iconButtonClass} shrink-0 text-fg-secondary`}
              >
                <Paperclip className="size-5" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                multiple
                hidden
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>

            {attachments.length > 0 && (
              <div className="mt-3 space-y-2">
                {attachments.map(({ file, id }) => (
                  <div
                    key={id}
                    className="flex items-center gap-3 rounded-small bg-surface-nested px-3 py-2.5"
                  >
                    <ImageIcon className="size-5 text-fg-secondary shrink-0" aria-hidden />
                    <div className="flex-1 min-w-0">
                      <p className="text-body-m text-fg-primary truncate">{file.name}</p>
                      <p className="text-caption text-fg-tertiary">{formatSize(file.size)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setAttachments((prev) => prev.filter((a) => a.id !== id))
                      }
                      aria-label={`Remove ${file.name}`}
                      className="shrink-0 rounded-full p-1.5 text-fg-error hover:bg-action-error transition-colors"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {fileError && <p className="text-body-s text-fg-error mt-2">{fileError}</p>}
          </div>

          {/* Technical details */}
          <div className="mt-4 rounded-nested bg-surface-container p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <Label htmlFor="include-technical" className="text-label-l text-fg-primary">
                Include technical details
              </Label>
              <p className="text-body-m text-fg-secondary mt-0.5">
                Helps us find the problem faster. No personal data is shared
              </p>
            </div>
            <Checkbox
              id="include-technical"
              checked={includeTechnical}
              onCheckedChange={(value) => setIncludeTechnical(value === true)}
              className="mt-1 size-5 shrink-0"
            />
          </div>

          <div className="flex-1" />
          <Button
            type="button"
            onClick={handleSend}
            disabled={description.trim() === ""}
            className={PRIMARY_PILL}
          >
            Send
          </Button>
        </main>
      </div>
    </div>
  );
}

function FullScreen({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader close onBack={onClose} backLabel="Close" />
        <main className="flex-1 flex flex-col items-center justify-center px-6 pb-10">
          {children}
        </main>
      </div>
    </div>
  );
}
