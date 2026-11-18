import { foldVerdicts, uncheckedChangeReason, type Ask } from "../src/engine/acceptance";

const asks: Ask[] = [
  { id: "R1", ask: "The list opens.", met: true, evidence: "Opened it." },
  { id: "R2", ask: "Search works.", met: false, evidence: "Returned nothing." },
];

describe("foldVerdicts", () => {
  test("a re-check keeps the asks it did not submit, and takes the new verdict on the ones it did", () => {
    const out = foldVerdicts(asks, [{ id: "R2", ask: "Search works.", met: true, evidence: "Found a title." }], () => "R3", true);
    expect(out).toEqual([asks[0], { id: "R2", ask: "Search works.", met: true, evidence: "Found a title." }]);
  });

  test("a re-check does not judge again an ask that already passed", () => {
    const out = foldVerdicts(asks, [{ id: "R1", ask: "The list opens.", met: false, evidence: "Placeholder." }], () => "R3", true);
    expect(out[0]).toEqual(asks[0]);
  });

  test("a first round counts an ask it did not submit as not met", () => {
    const out = foldVerdicts(asks, [{ id: "R2", ask: "Search works.", met: true, evidence: "Found a title." }], () => "R3");
    expect(out[0]).toMatchObject({ id: "R1", met: false });
  });
});

describe("uncheckedChangeReason", () => {
  test("says the last change is unchecked, and names the asks left unmet", () => {
    expect(uncheckedChangeReason(2, ["R2"])).toBe("2 acceptance checks left R2 not met, and the last change was not checked against the requirements.");
    expect(uncheckedChangeReason(1, [])).toBe("One acceptance check met every ask, and the last change was not checked against the requirements.");
  });
});
