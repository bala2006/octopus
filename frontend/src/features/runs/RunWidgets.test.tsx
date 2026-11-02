import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskBoard } from "./RunWidgets";

it("shows task dependencies, write scope and turn budget next to the owned work", () => {
  render(<TaskBoard agents={{}} tasks={[
    { key: "T-2", title: "Build API", status: "todo", constraints_json: { dependencies: ["T-1"], write_paths: ["src/api", "tests/api"], max_turns: 8 } },
    { key: "T-3", title: "Review API", status: "cancelled", constraints_json: { write_paths: [], max_turns: 3 } },
  ]} />);
  expect(screen.getByText("T-1")).toBeVisible();
  expect(screen.getByText("src/api, tests/api")).toBeVisible();
  expect(screen.getByText("8 turns")).toBeVisible();
  expect(screen.getByText("Read only")).toBeVisible();
  expect(screen.getByText("Review API")).toBeVisible();
  expect(screen.getByText("Cancelled")).toBeVisible();
});
