import { useMemo, useState } from "react";
import { onPlainClick, useListNavigation } from "../lib/events";
import { compareTreePaths, fuzzyScore } from "../lib/sort";
import { MESSAGE_PATH } from "../types";
import { Modal } from "./Modal";

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
  const matches = useMemo(
    () => paths
      .flatMap((path, order) => {
        const label = path === MESSAGE_PATH ? "Commit message" : path;
        const score = fuzzyScore(label, query);
        return score === null ? [] : [{ path, label, order, score }];
      })
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
  const list = useListNavigation(matches, (match) => choose(match.path));
  return (
    <Modal
      backdropClassName="finder-backdrop"
      className="file-finder"
      aria-labelledby="file-finder-title"
      onClose={onClose}
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
              list.setActive(0);
            }}
            onKeyDown={list.onKeyDown}
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
                className={index === list.active ? "active" : ""}
                role="option"
                aria-selected={index === list.active}
                onMouseEnter={() => list.setActive(index)}
                onClick={onPlainClick(() => choose(match.path))}
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
    </Modal>
  );
}
