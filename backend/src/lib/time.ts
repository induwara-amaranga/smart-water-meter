/**
 * Local-time helpers using a fixed UTC offset (Sri Lanka is UTC+05:30 with no
 * daylight saving), so month, day and hour boundaries match the customer's clock.
 */
export class LocalTime {
  constructor(private readonly offsetMinutes: number) {}

  private shift(d: Date): Date {
    return new Date(d.getTime() + this.offsetMinutes * 60_000);
  }

  private unshift(d: Date): Date {
    return new Date(d.getTime() - this.offsetMinutes * 60_000);
  }

  /** Local wall-clock parts of an instant. */
  parts(d: Date) {
    const s = this.shift(d);
    return {
      year: s.getUTCFullYear(),
      month: s.getUTCMonth() + 1,
      day: s.getUTCDate(),
      hour: s.getUTCHours(),
    };
  }

  /** Instant for a local wall-clock time (month is 1-based and may overflow). */
  at(year: number, month: number, day = 1, hour = 0): Date {
    return this.unshift(new Date(Date.UTC(year, month - 1, day, hour)));
  }

  startOfDay(d: Date): Date {
    const p = this.parts(d);
    return this.at(p.year, p.month, p.day);
  }

  startOfMonth(d: Date): Date {
    const p = this.parts(d);
    return this.at(p.year, p.month, 1);
  }

  /** "2026-10" -> [start, end) of that local month. */
  monthRange(period: string): { start: Date; end: Date } {
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (!m) throw new Error(`Invalid period ${period}`);
    const year = Number(m[1]);
    const month = Number(m[2]);
    return { start: this.at(year, month, 1), end: this.at(year, month + 1, 1) };
  }

  periodOf(d: Date): string {
    const p = this.parts(d);
    return `${p.year}-${String(p.month).padStart(2, '0')}`;
  }

  previousPeriod(d: Date): string {
    const p = this.parts(d);
    return this.periodOf(this.at(p.year, p.month - 1, 1));
  }

  daysInMonth(d: Date): number {
    const p = this.parts(d);
    return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  }
}
