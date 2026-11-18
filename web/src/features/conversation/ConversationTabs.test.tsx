import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationTabs, type ConversationTab } from "./ConversationTabs";

const tabs: ConversationTab[] = [
  { id: "chat", kind: "chat" },
  { id: "code", kind: "code" },
  { id: "changes", kind: "changes" },
  { id: "git", kind: "git" },
];

const props = { tabs, activeId: "chat", changes: [], onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn(), onMove: vi.fn() };

// jsdom has no layout. These stubs give the tab rail a fixed width and a scroll position the test can move.
let scrollLeft = 0;
const scrollBy = vi.fn();
const scrollIntoView = vi.fn();

function layout(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
}

const rail = () => document.querySelector<HTMLElement>(".conversation-tabs-track")!;

beforeEach(() => {
  scrollLeft = 0;
  scrollBy.mockClear();
  scrollIntoView.mockClear();
  layout(900, 400);
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = value; } });
  Element.prototype.scrollBy = scrollBy as unknown as Element["scrollBy"];
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  for (const key of ["scrollWidth", "clientWidth", "scrollLeft"] as const) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

it("shows only a right arrow while tabs are hidden past the right edge", () => {
  render(<ConversationTabs {...props} />);

  expect(screen.queryByRole("button", { name: "Scroll tabs left" })).toBeNull();
  expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeVisible();
});

it("shows no arrows when every tab fits", () => {
  layout(300, 400);
  render(<ConversationTabs {...props} />);

  expect(screen.queryByRole("button", { name: /Scroll tabs/ })).toBeNull();
});

it("scrolls the tabs with the arrows, and shows the left arrow once the rail has moved", () => {
  render(<ConversationTabs {...props} />);

  fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
  expect(scrollBy).toHaveBeenCalledWith({ left: 160, behavior: "smooth" });

  scrollLeft = 300;
  fireEvent.scroll(rail());
  expect(screen.getByRole("button", { name: "Scroll tabs left" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeVisible();
});

it("scrolls a newly selected tab into view", () => {
  const { rerender } = render(<ConversationTabs {...props} />);
  scrollIntoView.mockClear();

  rerender(<ConversationTabs {...props} activeId="git" />);

  expect(scrollIntoView).toHaveBeenCalledTimes(1);
});

it("shows the changes summary while the Changes tab is hovered", () => {
  render(<ConversationTabs {...props} />);
  const changesItem = screen.getByRole("tab", { name: "Changes" }).parentElement!;

  fireEvent.mouseEnter(changesItem);
  expect(screen.getByRole("tooltip")).toHaveTextContent("No files changed in the last turn.");

  fireEvent.mouseLeave(changesItem);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
