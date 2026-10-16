import { createMemo, createSignal, For, Show } from "solid-js";
import { autofocus, useListNavigation, onPlainClick } from "../lib/events";
import { compareTreePaths, fuzzyScore } from "../lib/sort";
import { MESSAGE_PATH } from "../types";
import { Modal } from "./Modal";

export function FileFinder(props: {
  paths: string[];
  reviewed: string[];
  onSelect: (path: string) => void;
  fileHref: (path: string) => string;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const matches = createMemo(() => props.paths
    .flatMap((path, order) => {
      const label = path === MESSAGE_PATH ? "Commit message" : path;
      const score = fuzzyScore(label, query());
      return score === null ? [] : [{ path, label, order, score }];
    })
    .sort((left, right) =>
      left.score - right.score ||
      compareTreePaths(left.label, right.label) ||
      left.order - right.order,
    )
    .slice(0, 100));
  const choose = (path: string) => {
    props.onSelect(path);
    props.onClose();
  };
  const list = useListNavigation(matches, (match) => choose(match.path));
  return (
    <Modal
      backdropClass="finder-backdrop"
      class="file-finder"
      aria-labelledby="file-finder-title"
      onClose={props.onClose}
    >
        <h2 id="file-finder-title">Find a file</h2>
        <div class="finder-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={autofocus}
            aria-label="Fuzzy find file"
            placeholder="Type part of a file path…"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              list.setActive(0);
            }}
            onKeyDown={list.onKeyDown}
          />
          <kbd>F</kbd>
        </div>
        <div class="finder-results" role="listbox" aria-label="Files">
          <For each={matches()}>
            {(match, index) => {
              const done = () => props.reviewed.includes(match.path);
              return (
                <a
                  href={props.fileHref(match.path)}
                  class={index() === list.active() ? "active" : ""}
                  role="option"
                  aria-selected={index() === list.active()}
                  onMouseEnter={() => list.setActive(index())}
                  onClick={onPlainClick(() => choose(match.path))}
                >
                  <span class="finder-path">{match.label}</span>
                  <span class={`finder-state${done() ? " reviewed" : ""}`}>
                    {done() ? "✓ Reviewed" : "Unreviewed"}
                  </span>
                </a>
              );
            }}
          </For>
          <Show when={!matches().length}><p>No matching files.</p></Show>
        </div>
        <div class="finder-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
    </Modal>
  );
}
