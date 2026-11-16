import { describe, expect, it } from "vitest";
import type { SpecialistsSettings } from "@octopus/shared";
import { hiddenCardIds, isSoloCanvas, soloCards, unseatedSpecialists } from "./soloCards";

type Card = { id: string; behavior: { template_key?: string } };
const card = (id: string, template_key: string): Card => ({ id, behavior: { template_key } });
const team: Card[] = [
  card("lead", "main"),
  card("rev", "specialist-reviewer"),
  card("sec", "specialist-security"),
  card("des", "specialist-designer"),
  card("ver", "specialist-verifier"),
  card("exp", "specialist-explorer"),
];
const settings = (on: string[]): SpecialistsSettings["specialists"] => {
  const flag = (name: string) => ({ enabled: on.includes(name), model: "gpt-6-luna", effort: "high" as const });
  return { reviewer: flag("reviewer"), security: flag("security"), designer: flag("designer"), explorer: flag("explorer"), verifier: flag("verifier") };
};

describe("solo canvas cards", () => {
  it("shows Octopus and one card per enabled specialist", () => {
    const cards = soloCards(team, settings(["reviewer", "security", "designer"]));
    expect(cards.map((c) => c.id)).toEqual(["lead", "rev", "sec", "des"]);
    expect(cards).toHaveLength(4);
  });

  it("shows Octopus alone when every specialist is off", () => {
    expect(soloCards(team, settings([]))).toEqual([team[0]]);
  });

  it("hides the cards of specialists that are off, and keeps them in the company", () => {
    expect([...hiddenCardIds(team, settings(["reviewer"]))].sort()).toEqual(["des", "exp", "sec", "ver"]);
  });

  it("finds the enabled specialists that have no agent on the canvas yet", () => {
    const partial = team.filter((c) => c.id !== "des");
    expect(unseatedSpecialists(partial, settings(["reviewer", "designer"]))).toEqual(["designer"]);
  });

  it("recognises a solo canvas by its lead", () => {
    expect(isSoloCanvas(team)).toBe(true);
    expect(isSoloCanvas([card("a", "software_engineer")])).toBe(false);
  });
});