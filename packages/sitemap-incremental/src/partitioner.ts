import type { WeekDateRange } from './types';

export class Partitioner {
  private timezoneOffsetMs: number;

  constructor(timezoneOffsetHours: number = 7) {
    this.timezoneOffsetMs = timezoneOffsetHours * 60 * 60 * 1000;
  }

  /**
   * Formats date into ISO 8601 with timezone offset: YYYY-MM-DDTHH:mm:ss+07:00
   */
  formatDate(dateInput: string | Date): string {
    const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    if (Number.isNaN(d.getTime())) return '';

    const shifted = new Date(d.getTime() + this.timezoneOffsetMs);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hours = String(shifted.getUTCHours()).padStart(2, '0');
    const mins = String(shifted.getUTCMinutes()).padStart(2, '0');
    const secs = String(shifted.getUTCSeconds()).padStart(2, '0');

    const totalMinutes = Math.floor(this.timezoneOffsetMs / (60 * 1000));
    const sign = totalMinutes >= 0 ? '+' : '-';
    const absMins = Math.abs(totalMinutes);
    const tzHours = String(Math.floor(absMins / 60)).padStart(2, '0');
    const tzRemainderMins = String(absMins % 60).padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${mins}:${secs}${sign}${tzHours}:${tzRemainderMins}`;
  }

  getCurrentPeriod(): { yearMonth: string; day: number; week: number } {
    const nowUtc = new Date();
    const nowLocal = new Date(nowUtc.getTime() + this.timezoneOffsetMs);
    const year = nowLocal.getUTCFullYear();
    const month = String(nowLocal.getUTCMonth() + 1).padStart(2, '0');
    const day = nowLocal.getUTCDate();
    const week = Math.min(4, Math.ceil(day / 7));

    return {
      yearMonth: `${year}-${month}`,
      day,
      week,
    };
  }

  getWeeksForMonth(yearMonth: string, currentYearMonth: string, currentDay: number): number[] {
    if (yearMonth > currentYearMonth) return [];
    if (yearMonth === currentYearMonth) {
      const maxWeek = Math.min(4, Math.ceil(currentDay / 7));
      return Array.from({ length: maxWeek }, (_, i) => i + 1);
    }
    return [1, 2, 3, 4];
  }

  getWeekDateRange(yearMonth: string, week: number): WeekDateRange {
    const [yearStr, monthStr] = yearMonth.split('-');
    const yearNum = parseInt(yearStr || '0', 10);
    const monthNum = parseInt(monthStr || '1', 10);

    const startDay = (week - 1) * 7 + 1;
    let endDay = week * 7;
    if (week === 4) {
      endDay = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
    }

    return {
      month: yearMonth,
      week,
      start: new Date(Date.UTC(yearNum, monthNum - 1, startDay)),
      end: new Date(Date.UTC(yearNum, monthNum - 1, endDay, 23, 59, 59, 999)),
    };
  }

  isPastClosedWeek(
    month: string,
    week: number,
    currentYearMonth: string,
    currentWeek: number
  ): boolean {
    if (month < currentYearMonth) return true;
    if (month === currentYearMonth && week < currentWeek) return true;
    return false;
  }
}
