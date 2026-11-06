import { describe, expect, it } from "vitest";
import { calendarDays, weeklyTotals } from "./calendar";

describe("activity calendar", () => {
  it("aligns weeks on Sunday and retains leap day usage", () => {
    const days = calendarDays([{ date: "2024-02-29", tokens: 120 }, { date: "2024-03-01", tokens: 30 }], "2024-03-02");
    expect(new Date(`${days[0].date}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(days.at(-1)).toEqual({ date: "2024-03-02", tokens: 0 });
    expect(weeklyTotals(days).at(-1)).toEqual({ date: "2024-02-25", tokens: 150 });
    expect(days.filter((day) => day.tokens > 0)).toHaveLength(2);
  });
});
