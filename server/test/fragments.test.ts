import { fragmentAsks } from "../src/engine/acceptance";

describe("fragmentAsks", () => {
  test("a conjunction-led piece of a sentence is a fragment", () => {
    expect(fragmentAsks(["and best user experience.", "Build a site.", "Works on mobile"])).toEqual(["and best user experience."]);
  });

  test("a piece of fewer than three words is a fragment", () => {
    expect(fragmentAsks(["EXIT", "Sign in works"])).toEqual(["EXIT"]);
  });

  test("whole asks are not fragments", () => {
    expect(fragmentAsks(["Create a fully simulated website like netflix, with demo data present and working."])).toEqual([]);
  });
});
