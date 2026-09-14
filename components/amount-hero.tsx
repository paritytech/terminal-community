/**
 * The big number block shared by Home ("Today's Income") and Check out
 * ("Enter Payment Amount"): label, amount, token symbol — one set of classes
 * so both tabs render the figure at the exact same size and position, and
 * switching between them doesn't shift anything.
 *
 * text-6xl rather than 7xl so the largest keypad amount (9,999,999.99) still
 * fits on one line at phone width.
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
      <p className="text-neutral-400 text-base mb-1">{label}</p>
      <div className="flex items-baseline justify-between gap-4">
        <span
          data-testid={testId}
          className={`text-white text-6xl font-bold tracking-tight break-all ${
            dimmed ? "opacity-40" : ""
          }`}
        >
          {value}
        </span>
        <span className="text-neutral-400 text-base font-semibold shrink-0">{symbol}</span>
      </div>
    </div>
  );
}
