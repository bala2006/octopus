/** Phase 2 of one writer: findings are structured, the writer answers each one, and only open blockers stop a part. */
import { addFindings, answerFindings, blockingOpen, renderFindings, reviewError, settlePrior } from "../src/lib/findings";

const major = { severity: "major" as const, problem: "No pricing section.", evidence: "Read index.html.", fix: "Add one." };
const minor = { severity: "minor" as const, problem: "Tidy the footer.", evidence: "Looked at it.", fix: "Align it." };

describe("reviewError", () => {
  test("request_changes needs a blocker or major finding", () => {
    expect(reviewError("request_changes", [])).toMatch(/at least one blocker or major/);
    expect(reviewError("request_changes", [minor])).toMatch(/at least one blocker or major/);
    expect(reviewError("request_changes", [major])).toBeNull();
  });

  test("approve may carry only minor notes", () => {
    expect(reviewError("approve", [])).toBeNull();
    expect(reviewError("approve", [minor])).toBeNull();
    expect(reviewError("approve", [major])).toMatch(/cannot carry blocker or major/);
  });
});

describe("addFindings", () => {
  test("ids keep counting across rounds, so an id never repeats within a part", () => {
    const first = addFindings([], "Kai", [major, major]);
    expect(first.list.map((f) => f.id)).toEqual(["F1", "F2"]);
    const second = addFindings(first.list, "Iris", [minor]);
    expect(second.list.map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
    expect(second.added).toEqual([expect.objectContaining({ id: "F3", critic: "Iris", status: "open" })]);
  });
});

describe("answerFindings", () => {
  test("applies answers to open findings and reports ids that match nothing", () => {
    const { list } = addFindings([], "Kai", [major]);
    const answered = answerFindings(list, [{ id: "F1", status: "fixed", response: "Added it." }, { id: "F9", status: "fixed", response: "?" }]);
    expect(answered.list[0]).toMatchObject({ status: "fixed", response: "Added it." });
    expect(answered.unknown).toEqual(["F9"]);
  });

  test("an answer does not reopen a finding that is already settled", () => {
    const settled = settlePrior(answerFindings(addFindings([], "Kai", [major]).list, [{ id: "F1", status: "fixed", response: "Done." }]).list);
    const again = answerFindings(settled, [{ id: "F1", status: "disputed", response: "No." }]);
    expect(again.list[0]!.status).toBe("resolved");
  });
});

describe("blockingOpen", () => {
  test("only open blocker and major findings stop a part from finishing", () => {
    const { list } = addFindings([], "Kai", [major, minor]);
    expect(blockingOpen(list).map((f) => f.id)).toEqual(["F1"]);
    const answered = answerFindings(list, [{ id: "F1", status: "disputed", response: "The section is in the footer." }]).list;
    expect(blockingOpen(answered)).toEqual([]);
  });
});

describe("settlePrior", () => {
  test("fixed and disputed findings settle when their round closes; open ones stay open", () => {
    const list = answerFindings(addFindings([], "Kai", [major, major]).list, [{ id: "F1", status: "fixed", response: "Done." }]).list;
    const settled = settlePrior(list);
    expect(settled.map((f) => f.status)).toEqual(["resolved", "open"]);
  });
});

describe("renderFindings", () => {
  test("lists id, severity, location, evidence and fix for the owner", () => {
    const { list } = addFindings([], "Kai", [{ ...major, file: "index.html", lines: "40-52" }]);
    const text = renderFindings(list);
    expect(text).toContain("F1 [major] index.html:40-52: No pricing section.");
    expect(text).toContain("Evidence: Read index.html.");
    expect(text).toContain("Fix: Add one.");
  });
});
