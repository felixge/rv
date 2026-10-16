import { onCleanup } from "solid-js";
import { isTyping } from "../lib/events";
import { shortcuts, type Command } from "../lib/shortcuts";

// Modified shortcuts also work while typing.
function modifiedCommand(event: KeyboardEvent, key: string): Command | undefined {
  if (event.altKey) return;
  if ((event.metaKey || event.ctrlKey) && key === "f") return "find-viewed-file";
  if ((event.metaKey || event.ctrlKey) && key === "g")
    return event.shiftKey ? "previous-text-match" : "next-text-match";
  if (event.metaKey && !event.ctrlKey && key === "k") return "palette";
}

// Global keyboard shortcuts. escape returns whether it closed or cancelled
// something; unmodified shortcuts pause while a dialog is open.
export function useKeyboard(options: {
  run: (command: Command) => void;
  escape: () => boolean;
  dialogOpen: () => boolean;
}) {
  let sequence = "";
  let sequenceTimer: number | undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const modified = modifiedCommand(event, key);
    if (modified) {
      event.preventDefault();
      options.run(modified);
      return;
    }
    if (event.key === "Escape") {
      if (options.escape()) event.preventDefault();
      return;
    }
    if (
      options.dialogOpen() || event.metaKey || event.ctrlKey || event.altKey ||
      isTyping(event.target)
    )
      return;
    const prefix = sequence;
    sequence = "";
    window.clearTimeout(sequenceTimer);
    if (!prefix && key === "g") {
      event.preventDefault();
      sequence = "g";
      sequenceTimer = window.setTimeout(() => {
        sequence = "";
      }, 1000);
      return;
    }
    const bind = prefix + key;
    const shortcut =
      (event.shiftKey && shortcuts.find((item) => item.bind === bind.toUpperCase())) ||
      shortcuts.find((item) => item.bind === bind);
    if (!shortcut) return;
    event.preventDefault();
    options.run(shortcut.command);
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    document.removeEventListener("keydown", onKeyDown);
    window.clearTimeout(sequenceTimer);
  });
}
