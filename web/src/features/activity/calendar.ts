export interface UsageDay { date: string; tokens: number }

export function calendarDays(days: UsageDay[], today: string): UsageDay[] {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 364 - start.getUTCDay());
  const values = new Map(days.map((day) => [day.date, day.tokens]));
  const result: UsageDay[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    result.push({ date, tokens: values.get(date) ?? 0 });
  }
  return result;
}

export function weeklyTotals(days: UsageDay[]): UsageDay[] {
  return days.reduce<UsageDay[]>((weeks, day, index) => {
    if (index % 7 === 0) weeks.push({ date: day.date, tokens: 0 });
    const week = weeks[weeks.length - 1];
    if (week) week.tokens += day.tokens;
    return weeks;
  }, []);
}

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
