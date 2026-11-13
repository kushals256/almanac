/** Injected clock. AGENT_NOW is a test-only override; production uses the real time. */
let fixed: Date | null = null;

export function setNow(d: Date | string | null): void {
  fixed = d === null ? null : new Date(d);
}

export function now(): Date {
  return fixed ? new Date(fixed) : new Date();
}

/** 'YYYY-MM-DD' for an instant in an IANA timezone. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Day arithmetic on 'YYYY-MM-DD' strings (timezone-free, noon-anchored to dodge DST). */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay();
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 'Tue 3 Nov' style label for a 'YYYY-MM-DD'. */
export function humanDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}
