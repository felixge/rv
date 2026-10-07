import { useState } from "react";
import { useListNavigation } from "../lib/events";
import { shortcuts, type Command } from "../lib/shortcuts";
import { Modal } from "./Modal";

export function CommandLauncher({ onClose, onChoose }: { onClose: () => void; onChoose: (command: Command) => void }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const matches = shortcuts.filter((shortcut) =>
    `${shortcut.label} ${shortcut.category} ${shortcut.keys.join(" ")}`
      .toLowerCase()
      .includes(normalized),
  );
  const list = useListNavigation(matches, (shortcut) => onChoose(shortcut.command));
  return (
    <Modal className="shortcut-dialog" aria-labelledby="shortcut-title" onClose={onClose}>
        <div className="shortcut-heading">
          <div>
            <h2 id="shortcut-title">Commands</h2>
            <p>Run a command or look up its shortcut.</p>
          </div>
          <button onClick={onClose} aria-label="Close command launcher">✕</button>
        </div>
        <div className="shortcut-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            aria-label="Search commands and keyboard shortcuts"
            placeholder="Search commands…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              list.setActive(0);
            }}
            onKeyDown={list.onKeyDown}
          />
        </div>
        <div className="shortcut-list" role="listbox" aria-label="Commands">
          {matches.map((shortcut, index) => (
            <button
              type="button"
              className={`shortcut-row${index === list.active ? " active" : ""}`}
              key={shortcut.label}
              role="option"
              aria-selected={index === list.active}
              onMouseEnter={() => list.setActive(index)}
              onClick={() => onChoose(shortcut.command)}
            >
              <span className="shortcut-label">
                {shortcut.label}
                <small>{shortcut.category}</small>
              </span>
              <span className="shortcut-keys">
                {shortcut.keys.map((key) =>
                  key === "or" ? <small key={key}>or</small> : <kbd key={key}>{key}</kbd>,
                )}
              </span>
            </button>
          ))}
          {!matches.length && <p className="shortcut-empty">No shortcuts found.</p>}
        </div>
        <p className="shortcut-note"><kbd>↑</kbd><kbd>↓</kbd> Navigate · <kbd>Enter</kbd> Run · <kbd>Esc</kbd> Close</p>
    </Modal>
  );
}
