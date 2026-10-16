import { createMemo, createSignal, For, Show } from "solid-js";
import { autofocus, useListNavigation } from "../lib/events";
import { shortcuts, type Command } from "../lib/shortcuts";
import { Modal } from "./Modal";

export function CommandLauncher(props: { onClose: () => void; onChoose: (command: Command) => void }) {
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => {
    const normalized = query().trim().toLowerCase();
    return shortcuts.filter((shortcut) =>
      `${shortcut.label} ${shortcut.category} ${shortcut.keys.join(" ")}`
        .toLowerCase()
        .includes(normalized),
    );
  });
  const list = useListNavigation(matches, (shortcut) => props.onChoose(shortcut.command));
  return (
    <Modal class="shortcut-dialog" aria-labelledby="shortcut-title" onClose={props.onClose}>
        <div class="shortcut-heading">
          <div>
            <h2 id="shortcut-title">Commands</h2>
            <p>Run a command or look up its shortcut.</p>
          </div>
          <button onClick={props.onClose} aria-label="Close command launcher">✕</button>
        </div>
        <div class="shortcut-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={autofocus}
            aria-label="Search commands and keyboard shortcuts"
            placeholder="Search commands…"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              list.setActive(0);
            }}
            onKeyDown={list.onKeyDown}
          />
        </div>
        <div class="shortcut-list" role="listbox" aria-label="Commands">
          <For each={matches()}>
            {(shortcut, index) => (
              <button
                type="button"
                class={`shortcut-row${index() === list.active() ? " active" : ""}`}
                role="option"
                aria-selected={index() === list.active()}
                onMouseEnter={() => list.setActive(index())}
                onClick={() => props.onChoose(shortcut.command)}
              >
                <span class="shortcut-label">
                  {shortcut.label}
                  <small>{shortcut.category}</small>
                </span>
                <span class="shortcut-keys">
                  <For each={shortcut.keys}>
                    {(key) => key === "or" ? <small>or</small> : <kbd>{key}</kbd>}
                  </For>
                </span>
              </button>
            )}
          </For>
          <Show when={!matches().length}><p class="shortcut-empty">No shortcuts found.</p></Show>
        </div>
        <p class="shortcut-note"><kbd>↑</kbd><kbd>↓</kbd> Navigate · <kbd>Enter</kbd> Run · <kbd>Esc</kbd> Close</p>
    </Modal>
  );
}
