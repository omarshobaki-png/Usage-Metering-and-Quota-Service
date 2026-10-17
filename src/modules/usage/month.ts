declare const utcMonthBrand: unique symbol;

// A normalized SQL date, such as "2026-10-01", constructed by getUtcMonth.
export type UtcMonth = string & { readonly [utcMonthBrand]: true };

export function getUtcMonth(processedAt: Date): UtcMonth {
  const year = processedAt.getUTCFullYear();

  if (!Number.isFinite(processedAt.getTime()) || year < 1 || year > 9999) {
    throw new RangeError("Processing time must be a valid date in years 0001–9999.");
  }

  // ISO timestamps use UTC regardless of the server's local timezone.
  return `${processedAt.toISOString().slice(0, 7)}-01` as UtcMonth;
}
