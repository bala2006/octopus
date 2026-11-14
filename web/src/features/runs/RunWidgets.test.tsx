import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { TaskOut } from "@/types";
import { TaskBoard } from "./RunWidgets";

const task = (t: Partial<TaskOut>): TaskOut => ({ id: t.key!, run_id: "r", key: "T1", title: "", description: "", acceptance_criteria: "", assignee_agent_id: null,
  status: "todo", kind: "build", depends_on: [], result: "", created_by: null, attempts: 0, updated_at: "", requirements: [], files: [], skills: [], ...t });

it("shows each task's kind, dependencies and result in its column", () => {
  render(<TaskBoard agents={{}} tasks={[
    task({ key: "T2", title: "Build API", depends_on: ["T1"] }),
    task({ key: "T3", title: "Review API", kind: "review", status: "done", result: "Approved: solid." }),
  ]} />);
  expect(screen.getByText("T1")).toBeVisible();
  expect(screen.getByText("Review")).toBeVisible();
  expect(screen.getByText("Approved: solid.")).toBeVisible();
  expect(screen.getByText("Done")).toBeVisible();
});
