import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfirmDialog,
  CopyButton,
  DataTable,
  EmptyState,
  formatDate,
  formatDateTime,
  formatRelative,
  Notice,
  PageHeader,
  RelativeTime,
  RowMenu,
  Skeleton,
  StatusBadge,
  ToastProvider,
  useToast,
} from "../src/index.js";
import { expectNoSeriousA11yViolations } from "./support/axe.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const UTC = { locale: "en-US", timeZone: "UTC" } as const;
// 16 Nov 2026, 23:10:12 UTC
const INSTANT = Date.UTC(2026, 10, 16, 23, 10, 12);

describe("date formatting", () => {
  it("formats dates day-first with a short month name, never US numeric", () => {
    expect(formatDate(INSTANT, UTC)).toBe("16 Nov 2026");
    expect(formatDate(new Date(INSTANT), { locale: "en-GB", timeZone: "UTC" })).toBe("16 Nov 2026");
    expect(formatDate(INSTANT, UTC)).not.toMatch(/\d+\/\d+\/\d+/);
  });

  it("formats date and time with a 24-hour clock", () => {
    expect(formatDateTime(INSTANT, UTC)).toBe("16 Nov 2026, 23:10");
    expect(formatDateTime(Date.UTC(2026, 0, 5, 7, 4), UTC)).toBe("5 Jan 2026, 07:04");
    expect(formatDateTime(INSTANT, { locale: "en-US", timeZone: "Asia/Tokyo" })).toBe(
      "17 Nov 2026, 08:10",
    );
  });

  it("keeps the browser locale's month names", () => {
    expect(formatDate(INSTANT, { locale: "de-DE", timeZone: "UTC" })).toMatch(
      /^16\.? Nov\.? 2026$/,
    );
    expect(formatDate(INSTANT, { locale: "fr-FR", timeZone: "UTC" })).toBe("16 nov. 2026");
  });

  it("treats a date-only string as that calendar day in every time zone", () => {
    for (const timeZone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      expect(formatDate("2026-10-19", { locale: "en-US", timeZone })).toBe("19 Oct 2026");
      expect(formatDateTime("2026-10-19", { locale: "en-US", timeZone })).toBe("19 Oct 2026");
    }
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDate("not a date")).toBe("");
    expect(formatDateTime(Number.NaN)).toBe("");
    expect(formatRelative("nope")).toBe("");
  });

  it("formats relative times in words", () => {
    const now = INSTANT;
    const opts = { locale: "en-US", now };
    expect(formatRelative(now - 3 * 3600_000, opts)).toBe("3 hours ago");
    expect(formatRelative(now - 20_000, opts)).toBe("now");
    expect(formatRelative(now - 5 * 60_000, opts)).toBe("5 minutes ago");
    expect(formatRelative(now - 24 * 3600_000, opts)).toBe("yesterday");
    expect(formatRelative(now - 3 * 24 * 3600_000, opts)).toBe("3 days ago");
    expect(formatRelative(now - 14 * 24 * 3600_000, opts)).toBe("2 weeks ago");
    expect(formatRelative(now + 2 * 3600_000, opts)).toBe("in 2 hours");
    expect(formatRelative(now - 400 * 24 * 3600_000, opts)).toBe("last year");
  });

  it("RelativeTime shows words with the full date as its title", () => {
    render(
      <RelativeTime value={INSTANT - 3 * 3600_000} now={INSTANT} locale="en-US" timeZone="UTC" />,
    );
    const time = screen.getByText("3 hours ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("title")).toBe("16 Nov 2026, 20:10");
    expect(time.getAttribute("datetime")).toBe(new Date(INSTANT - 3 * 3600_000).toISOString());
  });
});

describe("PageHeader, EmptyState, StatusBadge, Skeleton, Notice", () => {
  it("renders a page header with title, description and actions", async () => {
    render(
      <main>
        <PageHeader
          title="Sources"
          description="Where answers come from."
          actions={
            <button type="button" className="btn btn-primary">
              Add source
            </button>
          }
        />
      </main>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Sources" })).toBeTruthy();
    expect(screen.getByText("Where answers come from.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add source" })).toBeTruthy();
    await expectNoSeriousA11yViolations();
  });

  it("renders an empty state with a heading, one sentence and an action", async () => {
    const onAdd = vi.fn();
    render(
      <main>
        <h1>Tests</h1>
        <EmptyState
          icon="tests"
          title="No tests yet"
          description="Add a question your assistant should get right."
          action={
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              Add test
            </button>
          }
        />
      </main>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "No tests yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add test" }));
    expect(onAdd).toHaveBeenCalledOnce();
    // The icon is decorative.
    expect(document.querySelector(".empty-state-icon")?.getAttribute("aria-hidden")).toBe("true");
    await expectNoSeriousA11yViolations();
  });

  it("renders status badges whose word carries the meaning", async () => {
    render(
      <main>
        <StatusBadge tone="success">Live</StatusBadge>
        <StatusBadge tone="warning" title="Saved but not published">
          Unpublished changes
        </StatusBadge>
        <StatusBadge>Not published yet</StatusBadge>
      </main>,
    );
    expect(screen.getByText("Live").className).toContain("badge-tone-success");
    expect(screen.getByText("Unpublished changes").getAttribute("title")).toBe(
      "Saved but not published",
    );
    expect(screen.getByText("Not published yet").className).toContain("badge-tone-neutral");
    await expectNoSeriousA11yViolations();
  });

  it("announces a skeleton once with its label and hides the shapes", async () => {
    render(
      <main>
        <Skeleton lines={4} label="Loading sources…" />
      </main>,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading sources…");
    expect(status.querySelectorAll(".skeleton-line[aria-hidden='true']")).toHaveLength(4);
    await expectNoSeriousA11yViolations();
  });

  it("uses role alert for error notices and status for the rest", async () => {
    render(
      <main>
        <Notice tone="error">Could not save.</Notice>
        <Notice tone="success">Saved.</Notice>
      </main>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Could not save.");
    expect(screen.getByRole("status").textContent).toBe("Saved.");
    await expectNoSeriousA11yViolations();
  });
});

function ConfirmHarness({ confirmText }: { confirmText?: string }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(0);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Delete source
      </button>
      <span data-testid="confirmed">{confirmed}</span>
      <ConfirmDialog
        open={open}
        title="Delete this source?"
        description="Its pages stop being used in answers."
        confirmLabel="Delete source"
        tone="danger"
        {...(confirmText !== undefined ? { confirmText } : {})}
        onConfirm={() => {
          setConfirmed((n) => n + 1);
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </main>
  );
}

describe("ConfirmDialog", () => {
  it("focuses Cancel, traps Tab, closes on Escape and returns focus", async () => {
    render(<ConfirmHarness />);
    const opener = screen.getByRole("button", { name: "Delete source" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Delete this source?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Its pages stop being used in answers.").id).toBe(
      dialog.getAttribute("aria-describedby"),
    );
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Delete source" });
    expect(document.activeElement).toBe(cancel);
    expect(confirm.className).toContain("btn-danger");
    await expectNoSeriousA11yViolations();

    // Tab wraps inside the dialog in both directions.
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByTestId("confirmed").textContent).toBe("0");
  });

  it("closes on the backdrop and confirms with the confirm button", () => {
    render(<ConfirmHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    fireEvent.click(document.querySelector(".dialog-backdrop") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete source" }));
    expect(screen.getByTestId("confirmed").textContent).toBe("1");
  });

  it("keeps a typed confirmation disabled until the exact text is typed", async () => {
    render(<ConfirmHarness confirmText="Docs Bot" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete source" }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Type Docs Bot to confirm") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const confirm = within(dialog).getByRole("button", {
      name: "Delete source",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "docs bot" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("confirmed").textContent).toBe("0");

    fireEvent.change(input, { target: { value: "Docs Bot" } });
    expect(confirm.disabled).toBe(false);
    await expectNoSeriousA11yViolations();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("confirmed").textContent).toBe("1");
  });
});

describe("RowMenu", () => {
  it("opens with the keyboard, moves with arrows, runs an item and returns focus", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <main>
        <RowMenu
          label="More actions for Docs"
          items={[
            { label: "Rename", onSelect: onRename },
            { label: "Delete", onSelect: onDelete, tone: "danger" },
          ]}
        />
      </main>,
    );
    const trigger = screen.getByRole("button", { name: "More actions for Docs" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await expectNoSeriousA11yViolations();

    await act(async () => {
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const menu = screen.getByRole("menu", { name: "More actions for Docs" });
    const items = within(menu).getAllByRole("menuitem");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items[0]);
    await expectNoSeriousA11yViolations();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1]?.className).toContain("row-menu-danger");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on a press outside", () => {
    render(
      <main>
        <RowMenu label="More" items={[{ label: "Rename", onSelect: () => {} }]} />
        <p>Elsewhere</p>
      </main>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("Elsewhere"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("CopyButton", () => {
  it("copies the value and says so", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <main>
        <CopyButton value="<script src=x></script>" label="Copy snippet" />
      </main>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy snippet" }));
    });
    expect(writeText).toHaveBeenCalledWith("<script src=x></script>");
    expect(screen.getByText("Copied.")).toBeTruthy();
    await expectNoSeriousA11yViolations();
  });

  it("explains when copying fails", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    render(<CopyButton value="abc" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByText(/Could not copy/)).toBeTruthy();
  });
});

interface Row {
  id: string;
  question: string;
  count: number;
}

describe("DataTable", () => {
  const columns = [
    { key: "question", header: "Question", render: (r: Row) => r.question },
    { key: "count", header: "Times asked", render: (r: Row) => r.count, align: "end" as const },
    {
      key: "actions",
      header: "Actions",
      hideHeader: true,
      render: (r: Row) => (
        <button type="button" className="btn btn-sm btn-secondary">
          Open {r.id}
        </button>
      ),
    },
  ];

  it("labels every cell with its column so the stacked layout stays readable", async () => {
    render(
      <main>
        <DataTable
          caption="Top questions"
          columns={columns}
          rows={[
            { id: "a", question: "How do I install?", count: 9 },
            { id: "b", question: "Refunds?", count: 2 },
          ]}
          rowKey={(r) => r.id}
        />
      </main>,
    );
    const table = screen.getByRole("table", { name: "Top questions" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Question", "Times asked", "Actions"]);
    const firstRow = within(table).getAllByRole("row")[1] as HTMLElement;
    const cells = within(firstRow).getAllByRole("cell");
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual([
      "Question",
      "Times asked",
      null,
    ]);
    expect(cells[1]?.className).toBe("data-table-end");
    await expectNoSeriousA11yViolations();
  });

  it("shows the empty content instead of an empty table", () => {
    render(
      <DataTable
        caption="Top questions"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<EmptyState title="No questions yet" />}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("heading", { name: "No questions yet" })).toBeTruthy();
  });
});

function ToastButtons() {
  const toast = useToast();
  return (
    <main>
      <button type="button" onClick={() => toast.success("Draft saved.")}>
        Save
      </button>
      <button type="button" onClick={() => toast.error("Could not publish.")}>
        Fail
      </button>
    </main>
  );
}

function NumberedToasts() {
  const toast = useToast();
  const count = useRef(0);
  return (
    <main>
      <button type="button" onClick={() => toast.success(`Saved ${++count.current}.`)}>
        Next
      </button>
      <button type="button" onClick={() => toast.error("Could not publish.")}>
        Fail
      </button>
    </main>
  );
}

function statusTexts() {
  return screen.queryAllByRole("status").map((el) => el.textContent);
}

describe("Toast", () => {
  it("announces success as status and errors as alert; success fades, errors stay", async () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastButtons />
      </ToastProvider>,
    );
    // No live-region roles until there is something to say.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status.textContent).toContain("Draft saved.");
    expect(alert.textContent).toContain("Could not publish.");
    expect(status.parentElement?.getAttribute("aria-live")).toBe("polite");
    expect(alert.parentElement?.getAttribute("aria-live")).toBe("assertive");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an undismissed error when newer messages fill the list", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <NumberedToasts />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("alert").textContent).toContain("Could not publish.");
    // Only success messages make room: the oldest one went, the newest three show.
    expect(statusTexts()).toEqual(["Saved 2.", "Saved 3.", "Saved 4."]);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryAllByRole("status")).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("Could not publish.");
  });

  it("keeps every waiting error and still shows the newest message", () => {
    render(
      <ToastProvider>
        <NumberedToasts />
      </ToastProvider>,
    );
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getAllByRole("alert")).toHaveLength(5);
    expect(statusTexts()).toEqual(["Saved 2."]);
  });

  it("passes axe with messages showing", async () => {
    render(
      <ToastProvider>
        <ToastButtons />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Fail" }));
    await expectNoSeriousA11yViolations();
  });

  it("does nothing outside a provider", () => {
    render(<ToastButtons />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
