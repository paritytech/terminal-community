"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, Files, FileText, Loader2 } from "lucide-react";
import { SubpageHeader } from "@/components/subpage-header";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/web3";
import { useAdminQrPayload } from "@/lib/config/admin-qr";
import { useBulletin } from "@/lib/hooks/use-bulletin";
import { useSalesHistory, addCsvReport, getAllCsvReports, type CsvReportRecord, type SaleRecord } from "@/lib/storage";
import { captureError } from "@/lib/telemetry";
import { saveFile } from "@/lib/utils/save-file";
import {
  type ExportRow,
  buildCsv,
  countDistinctSales,
  enumerateDateRange,
  fetchExportRowsForDate,
  formatYmd,
} from "@/lib/export/csv";

type Period = "today" | "week" | "month" | "custom";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); // Monday-based
  return day;
}

/** "12 June 2026" */
function dayLabel(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** "12 June - 12 July 2025" (year once when shared), single day collapses. */
function rangeLabel(from: Date, to: Date): string {
  if (formatYmd(from) === formatYmd(to)) return dayLabel(from);
  if (from.getFullYear() === to.getFullYear()) {
    return `${from.getDate()} ${MONTH_NAMES[from.getMonth()]} - ${to.getDate()} ${MONTH_NAMES[to.getMonth()]} ${to.getFullYear()}`;
  }
  return `${dayLabel(from)} - ${dayLabel(to)}`;
}

/** "Today at 13:02" / "Yesterday at 13:02" / "11.07.26 at 13:02" */
function createdAtLabel(value: Date | string): string {
  const d = new Date(value);
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = startOfDay(new Date());
  const thatDay = startOfDay(d);
  const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86_400_000);
  if (diffDays === 0) return `Today at ${time}`;
  if (diffDays === 1) return `Yesterday at ${time}`;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  return `${dd}.${mm}.${yy} at ${time}`;
}

// Period chips: a chip keeps rounded-full (outside the pill count) and is
// selected by moving to the primary action surface.
const CHIP_BASE = "inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-label-m transition-colors";
const CHIP_OFF = "bg-action-tertiary text-fg-primary hover:bg-action-tertiary-hover";
const CHIP_ON = "bg-action-primary text-fg-primary-inverted hover:bg-action-primary-hover";

export default function ExportCsvPage() {
  const router = useRouter();
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  const { readDailyReport } = useBulletin();
  const merchantIdentity = adminPayload?.receivingAddress ?? account?.address;
  const { sales } = useSalesHistory();

  const [period, setPeriod] = useState<Period | null>(null);
  const [customRange, setCustomRange] = useState<{ from: Date; to: Date } | null>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [reports, setReports] = useState<CsvReportRecord[] | null>(null);
  const [viewReport, setViewReport] = useState<CsvReportRecord | null>(null);

  useEffect(() => {
    getAllCsvReports().then(setReports).catch(() => setReports([]));
  }, []);

  useEffect(() => {
    if (!showSuccess) return;
    const t = setTimeout(() => setShowSuccess(false), 3500);
    return () => clearTimeout(t);
  }, [showSuccess]);

  // The selected period as a concrete [from, to] day range.
  const range = useMemo((): { from: Date; to: Date } | null => {
    const now = new Date();
    if (period === "today") return { from: startOfDay(now), to: now };
    if (period === "week") return { from: startOfWeek(now), to: now };
    if (period === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
    if (period === "custom" && customRange) return customRange;
    return null;
  }, [period, customRange]);

  // Local incoming sales inside the selected range — powers the "N transactions"
  // subtitle and the "No transactions to export" gate.
  const txCount = useMemo(() => {
    if (!range || !sales) return 0;
    const from = startOfDay(range.from).getTime();
    const toEnd = startOfDay(range.to).getTime() + 86_400_000;
    return sales.filter((s: SaleRecord) => {
      if (s.type !== "incoming") return false;
      const t = new Date(s.timestamp).getTime();
      return t >= from && t < toEnd;
    }).length;
  }, [range, sales]);

  const subtitle = !period
    ? "Select a period to export"
    : period === "today"
      ? `For Today · ${txCount} transactions`
      : period === "week"
        ? `For This week · ${txCount} transactions`
        : period === "month"
          ? `For This month · ${txCount} transactions`
          : `Custom period · ${txCount} transactions`;

  const reportLabelForSelection = (): string => {
    const now = new Date();
    if (period === "month") return `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
    if (!range) return "";
    return rangeLabel(range.from, range.to);
  };

  const handleGenerate = async () => {
    if (!range || !merchantIdentity || generating || txCount === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const dates = enumerateDateRange(formatYmd(range.from), formatYmd(range.to));
      if (dates.length === 0) throw new Error("Choose a valid date range");
      if (dates.length > 92) throw new Error("Choose 92 days or fewer");

      const rows: ExportRow[] = [];
      for (const date of dates) {
        rows.push(...await fetchExportRowsForDate(date, merchantIdentity, readDailyReport));
      }
      if (rows.length === 0) throw new Error("No transactions to export");

      const record: Omit<CsvReportRecord, "id"> = {
        reportId: `csv-${Date.now()}`,
        label: reportLabelForSelection(),
        fromYmd: dates[0],
        toYmd: dates[dates.length - 1],
        txCount: countDistinctSales(rows),
        csv: buildCsv(rows),
        createdAt: new Date(),
      };
      await addCsvReport(record);
      setReports(await getAllCsvReports());
      setPeriod(null);
      setCustomRange(null);
      setShowSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
      captureError(err, { component: "export-csv", phase: "generate" });
    } finally {
      setGenerating(false);
    }
  };

  const downloadReport = async (report: CsvReportRecord) => {
    const name = report.fromYmd === report.toYmd
      ? `t3rminal-sales-${report.fromYmd}.csv`
      : `t3rminal-sales-${report.fromYmd}_${report.toYmd}.csv`;
    await saveFile(name, new Blob([report.csv], { type: "text/csv" }));
  };

  /* ── Report view ─────────────────────────────────────────────── */

  if (viewReport) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
          <SubpageHeader
            title={`Report for ${viewReport.label}`}
            onBack={() => setViewReport(null)}
            backLabel="Back to reports"
          />

          <main className="flex-1 min-h-0 flex flex-col px-4 pb-6">
            {/* CSV preview — a container sheet, code in the mono face */}
            <div className="flex-1 min-h-0 bg-surface-container rounded-container shadow-1 overflow-auto p-4 mb-6">
              <pre className="text-code font-mono text-fg-primary whitespace-pre">
                {previewCsv(viewReport.csv)}
              </pre>
            </div>

            <Button
              onClick={() => downloadReport(viewReport)}
              className="w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold shrink-0"
            >
              Download CSV
            </Button>
          </main>
        </div>
      </div>
    );
  }

  /* ── Main screen ─────────────────────────────────────────────── */

  const chipDisabled = generating ? "opacity-50 pointer-events-none" : "";
  const chip = (on: boolean) => `${CHIP_BASE} ${on ? CHIP_ON : CHIP_OFF} ${chipDisabled}`;

  const customChipLabel = customRange
    ? rangeLabel(customRange.from, customRange.to)
    : "Custom";

  const canGenerate = Boolean(period && !generating && txCount > 0 && merchantIdentity);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full">
        <SubpageHeader title="Export CSV" onBack={() => router.back()} backLabel="Back to home" />

        <main className="flex-1 flex flex-col px-4 pb-6">
          {/* New report card */}
          <div className="bg-surface-container rounded-container shadow-1 p-5 mb-8">
            <div className="flex items-center gap-4 mb-5">
              <div className="size-12 rounded-full bg-surface-nested flex items-center justify-center shrink-0">
                <FileText className="size-6 text-fg-primary" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="text-heading-l text-fg-primary">New report</h2>
                <p data-testid="export-subtitle" className="text-body-m text-fg-secondary">{subtitle}</p>
              </div>
            </div>

            {/* Period chips */}
            <div className="flex flex-wrap gap-2.5 mb-5">
              <button
                type="button"
                aria-pressed={period === "today"}
                onClick={() => setPeriod(period === "today" ? null : "today")}
                className={chip(period === "today")}
              >
                Today
              </button>
              <button
                type="button"
                aria-pressed={period === "week"}
                onClick={() => setPeriod(period === "week" ? null : "week")}
                className={chip(period === "week")}
              >
                This week
              </button>
              <button
                type="button"
                aria-pressed={period === "month"}
                onClick={() => setPeriod(period === "month" ? null : "month")}
                className={chip(period === "month")}
              >
                This month
              </button>
              <button
                type="button"
                aria-pressed={period === "custom"}
                onClick={() => setCalendarOpen(true)}
                className={chip(period === "custom")}
              >
                {customChipLabel}
                <CalendarDays className="size-4" aria-hidden />
              </button>
            </div>

            {error && (
              <div className="bg-action-error rounded-nested px-3 py-2 text-body-s text-fg-error mb-3">
                {error}
              </div>
            )}

            {/* Generate — the card's one action; disabled is the surface, not a fade */}
            <Button
              data-testid="btn-generate-report"
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold disabled:bg-action-disabled disabled:text-fg-disabled disabled:opacity-100"
            >
              {generating ? (
                <>
                  <Loader2 className="size-5 animate-spin" aria-hidden />
                  Generating...
                </>
              ) : period && txCount === 0 ? (
                "No transactions to export"
              ) : (
                "Generate report"
              )}
            </Button>
          </div>

          {/* Recent reports / zero state */}
          {reports && reports.length > 0 ? (
            <section>
              <h3 className="text-overline uppercase text-fg-secondary mb-3 px-2">
                Recent reports
              </h3>
              <div className="space-y-1">
                {reports.map((report) => (
                  <button
                    key={report.reportId}
                    onClick={() => setViewReport(report)}
                    className="w-full flex items-center gap-4 px-2 py-2.5 rounded-medium text-left hover:bg-surface-container transition-colors"
                  >
                    <span className="size-11 flex items-center justify-center shrink-0">
                      <FileText className="size-5 text-fg-secondary" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-label-l text-fg-primary truncate">
                        Report for {report.label}
                      </span>
                      <span className="block text-body-m text-fg-tertiary">
                        {report.txCount} transactions · {createdAtLabel(report.createdAt)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : reports ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <div className="bg-surface-container rounded-full p-4 mb-4 shadow-1">
                <Files className="size-6 text-fg-tertiary" aria-hidden />
              </div>
              <p className="text-body-m text-fg-secondary">Your exported reports will appear here</p>
            </div>
          ) : null}
        </main>
      </div>

      {/* Success toast — on the inverted surface, like every transient note */}
      {showSuccess && (
        <div className="fixed bottom-20 inset-x-0 z-40 flex justify-center px-6">
          <div className="flex items-center gap-2 bg-surface-container-inverted text-fg-primary-inverted text-label-m px-5 py-3 rounded-full shadow-2">
            <Check className="size-4" aria-hidden />
            Report Generated Successfully
          </div>
        </div>
      )}

      {/* Custom range calendar */}
      {calendarOpen && (
        <DateRangeSheet
          initialFrom={customRange?.from ?? null}
          initialTo={customRange?.to ?? null}
          onClose={() => setCalendarOpen(false)}
          onConfirm={(from, to) => {
            setCustomRange({ from, to });
            setPeriod("custom");
            setCalendarOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** First ~30 lines of the CSV, for the preview sheet. */
function previewCsv(csv: string): string {
  const lines = csv.split("\n");
  const shown = lines.slice(0, 30);
  return shown.join("\n") + (lines.length > 30 ? `\n… ${lines.length - 30} more rows` : "");
}

/* ── Date-range calendar sheet ──────────────────────────────────── */

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS_BACK = 12;

function DateRangeSheet({
  initialFrom,
  initialTo,
  onClose,
  onConfirm,
}: {
  initialFrom: Date | null;
  initialTo: Date | null;
  onClose: () => void;
  onConfirm: (from: Date, to: Date) => void;
}) {
  const [from, setFrom] = useState<Date | null>(initialFrom);
  const [to, setTo] = useState<Date | null>(initialTo);
  const today = startOfDay(new Date());

  const title = !from
    ? "Select Dates"
    : !to
      ? `${from.getDate()} ${MONTH_NAMES[from.getMonth()].slice(0, 3)} - Select To`
      : `${from.getDate()} ${MONTH_NAMES[from.getMonth()].slice(0, 3)} - ${to.getDate()} ${MONTH_NAMES[to.getMonth()].slice(0, 3)}`;

  const pick = (day: Date) => {
    if (!from || (from && to)) {
      setFrom(day);
      setTo(null);
    } else if (day.getTime() < from.getTime()) {
      setFrom(day);
    } else {
      setTo(day);
    }
  };

  // Newest month first, scrolling down goes back in time (matches the design).
  const months = Array.from({ length: MONTHS_BACK }, (_, i) => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - i, 1);
  });

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button aria-label="Close calendar" onClick={onClose} className="absolute inset-0 bg-surface-overlay" />
      <div className="relative bg-surface-container rounded-t-container shadow-3 max-h-[75dvh] flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <span className="text-heading-l text-fg-primary">{title}</span>
          <Button
            variant="ghost"
            disabled={!from}
            onClick={() => { setFrom(null); setTo(null); }}
            className="text-label-m text-fg-error"
          >
            Reset
          </Button>
        </div>

        {/* Weekday header — a table rule is a sanctioned border */}
        <div className="grid grid-cols-7 px-5 pb-2 border-b shrink-0">
          {WEEKDAYS.map((d) => (
            <span key={d} className="text-caption text-fg-tertiary text-center">{d}</span>
          ))}
        </div>

        {/* Months */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-24">
          {months.map((monthStart) => (
            <MonthGrid
              key={monthStart.toISOString()}
              monthStart={monthStart}
              from={from}
              to={to}
              maxDay={today}
              onPick={pick}
            />
          ))}
        </div>

        {/* Confirm — the sheet's bottom slot. The fade behind it is the one
            gradient the token set defines: the navigation overlay, which
            keeps the calendar legible as it scrolls under the button. */}
        {from && to && (
          <div className="absolute inset-x-0 bottom-0 p-4 bg-[linear-gradient(to_top,var(--gradient-navigation-overlay-start),var(--gradient-navigation-overlay-end))]">
            <Button
              onClick={() => onConfirm(from, to)}
              className="w-full h-auto rounded-full px-6 py-3.5 text-label-l font-semibold"
            >
              Select Dates
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function MonthGrid({
  monthStart,
  from,
  to,
  maxDay,
  onPick,
}: {
  monthStart: Date;
  from: Date | null;
  to: Date | null;
  maxDay: Date;
  onPick: (day: Date) => void;
}) {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0

  const fromT = from ? startOfDay(from).getTime() : null;
  const toT = to ? startOfDay(to).getTime() : null;

  const cells: (Date | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];

  return (
    <div className="py-3">
      <p className="text-body-m text-fg-secondary mb-3">
        {MONTH_NAMES[month]}{year !== new Date().getFullYear() ? ` ${year}` : ""}
      </p>
      <div className="grid grid-cols-7 gap-y-1">
        {cells.map((day, i) => {
          if (!day) return <span key={`pad-${i}`} />;
          const t = day.getTime();
          const disabled = t > maxDay.getTime();
          const isEndpoint = t === fromT || t === toT;
          const inRange = fromT !== null && toT !== null && t > fromT && t < toT;
          return (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => onPick(day)}
              className={`h-10 flex items-center justify-center text-body-m font-mono transition-colors ${
                inRange ? "bg-surface-nested" : ""
              } ${disabled ? "text-fg-disabled cursor-not-allowed" : "text-fg-primary hover:bg-selection-container-hover"}`}
            >
              <span
                className={`size-9 flex items-center justify-center rounded-full ${
                  isEndpoint ? "bg-action-primary text-fg-primary-inverted" : ""
                }`}
              >
                {day.getDate()}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
