import { useState } from "react";
import { shortcuts, type Command } from "../lib/shortcuts";

export function ShortcutHelp({ onClose, onChoose }: { onClose: () => void; onChoose: (command: Command) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const normalized = query.trim().toLowerCase();
  const matches = shortcuts.filter((shortcut) =>
    `${shortcut.label} ${shortcut.category} ${shortcut.keys.join(" ")}`
      .toLowerCase()
      .includes(normalized),
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="shortcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        onClick={(event) => event.stopPropagation()}
      >
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
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (matches.length)
                  setActive((current) =>
                    (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
                  );
              } else if (event.key === "Enter" && matches[active]) {
                event.preventDefault();
                onChoose(matches[active].command);
              }
            }}
          />
        </div>
        <div className="shortcut-list" role="listbox" aria-label="Commands">
          {matches.map((shortcut, index) => (
            <button
              type="button"
              className={`shortcut-row${index === active ? " active" : ""}`}
              key={shortcut.label}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
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
      </section>
    </div>
  );
}
