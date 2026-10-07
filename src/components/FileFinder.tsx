import { useMemo, useState } from "react";
import { compareTreePaths, fuzzyScore } from "../lib/sort";
import { MESSAGE_PATH } from "../types";

export function FileFinder({
  paths,
  reviewed,
  onSelect,
  fileHref,
  onClose,
}: {
  paths: string[];
  reviewed: string[];
  onSelect: (path: string) => void;
  fileHref: (path: string) => string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(
    () => paths
      .map((path, order) => {
        const label = path === MESSAGE_PATH ? "Commit message" : path;
        return { path, label, order, score: fuzzyScore(label, query) };
      })
      .filter((match): match is {
        path: string;
        label: string;
        order: number;
        score: number;
      } =>
        match.score !== null,
      )
      .sort((left, right) =>
        left.score - right.score ||
        compareTreePaths(left.label, right.label) ||
        left.order - right.order,
      )
      .slice(0, 100),
    [paths, query],
  );
  const choose = (path: string) => {
    onSelect(path);
    onClose();
  };
  return (
    <div className="modal-backdrop finder-backdrop" onClick={onClose}>
      <section
        className="file-finder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-finder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="file-finder-title">Find a file</h2>
        <div className="finder-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            aria-label="Fuzzy find file"
            placeholder="Type part of a file path…"
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
                    (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                    matches.length,
                  );
              } else if (event.key === "Enter" && matches[active]) {
                event.preventDefault();
                choose(matches[active].path);
              }
            }}
          />
          <kbd>F</kbd>
        </div>
        <div className="finder-results" role="listbox" aria-label="Files">
          {matches.map((match, index) => {
            const done = reviewed.includes(match.path);
            return (
              <a
                key={match.path}
                href={fileHref(match.path)}
                className={index === active ? "active" : ""}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  choose(match.path);
                }}
              >
                <span className="finder-path">{match.label}</span>
                <span className={`finder-state${done ? " reviewed" : ""}`}>
                  {done ? "✓ Reviewed" : "Unreviewed"}
                </span>
              </a>
            );
          })}
          {!matches.length && <p>No matching files.</p>}
        </div>
        <div className="finder-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </section>
    </div>
  );
}
