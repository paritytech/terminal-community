/**
 * The big number block shared by Home ("Today's Income") and Check out
 * ("Enter Payment Amount"): label, amount, token symbol — one set of classes
 * so both tabs render the figure at the exact same size and position, and
 * switching between them doesn't shift anything.
 *
 * The figure is `text-display-xl` in Martian Mono: the system's face for
 * numbers, with tabular figures so the digits don't shuffle as the merchant
 * types. Amount and symbol are a value and its unit, ranked by fg step only.
 */
export function AmountHero({
  label,
  value,
  symbol,
  testId,
  dimmed = false,
}: {
  label: string;
  value: string;
  symbol: string;
  testId?: string;
  /** Fade the figure while it's still loading. */
  dimmed?: boolean;
}) {
  return (
    <div>
      <p className="text-body-l text-fg-secondary mb-1">{label}</p>
      <div className="flex items-baseline justify-between gap-4">
        <span
          data-testid={testId}
          className={`text-display-xl font-mono text-fg-primary break-all ${
            dimmed ? "opacity-50" : ""
          }`}
        >
          {value}
        </span>
        <span className="text-label-l text-fg-secondary shrink-0">{symbol}</span>
      </div>
    </div>
  );
}
