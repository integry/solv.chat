import { fireEvent, screen, waitFor } from "@testing-library/react";

/** The assistant switcher's button (named "Assistant <selected name>"). */
export function assistantButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Assistant / });
}

/** Waits until the switcher shows a selected assistant. */
export async function findAssistantButton(): Promise<HTMLElement> {
  const button = await screen.findByRole("button", { name: /^Assistant / });
  await waitFor(() => {
    if (!button.getAttribute("data-value")) throw new Error("no assistant selected yet");
  });
  return button;
}

/** Id of the selected assistant, or "" when there is none. */
export function selectedAssistantId(): string {
  return assistantButton().getAttribute("data-value") ?? "";
}

function openList(): void {
  const button = assistantButton();
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
}

/** Picks an assistant by id through the listbox. */
export function pickAssistant(id: string): void {
  openList();
  const option = screen.getAllByRole("option").find((el) => el.getAttribute("data-value") === id);
  if (!option) throw new Error(`no assistant option ${id}`);
  fireEvent.click(option);
}

/** Names of the assistants listed in the switcher, in order. */
export function listedAssistantNames(): string[] {
  openList();
  const names = screen
    .getAllByRole("option")
    .filter((el) => el.hasAttribute("data-value"))
    .map((el) => el.querySelector(".switcher-option-name")?.textContent ?? "");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  return names;
}

/** Opens the header "New assistant" form through the switcher's last option. */
export function openNewAssistantForm(): void {
  openList();
  fireEvent.click(screen.getByRole("option", { name: "New assistant" }));
}
