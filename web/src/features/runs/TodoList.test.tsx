import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TodoList } from "./TodoList";
import type { TodoState } from "./runState";

const todos: TodoState = {
  agent_id: "a",
  items: [
    { content: "Read the spec", status: "completed" },
    { content: "Build the cart", status: "in_progress" },
    { content: "Write the test", status: "pending" },
  ],
};

it("counts the finished items and reports the progress bar", () => {
  render(<TodoList todos={todos} />);
  expect(screen.getByText("1 of 3 done")).toBeVisible();
  const bar = screen.getByRole("progressbar", { name: "Checklist progress" });
  expect(bar).toHaveAttribute("aria-valuenow", "1");
  expect(bar).toHaveAttribute("aria-valuemax", "3");
});

it("says each item's status in words, not only by its icon", () => {
  render(<TodoList todos={todos} />);
  expect(screen.getByText("Read the spec").closest("li")).toHaveTextContent("(done)");
  expect(screen.getByText("Build the cart").closest("li")).toHaveTextContent("(in progress)");
  expect(screen.getByText("Write the test").closest("li")).toHaveTextContent("(to do)");
});
