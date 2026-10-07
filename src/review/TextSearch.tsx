import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  highlightStyles,
  lineSide,
  rangeForMatch,
  textSearchHighlightName,
  textSearchMatches,
  textSearchMatchesHighlightName,
} from "../lib/textSearch";
import type { Comment, Source, ViewerMode } from "../types";

function clearHighlights() {
  CSS.highlights.delete(textSearchHighlightName);
  CSS.highlights.delete(textSearchMatchesHighlightName);
}

// Find in the viewed file (Cmd/Ctrl+F), plus highlighting other occurrences of
// text selected on a single line.
export function useTextSearch({
  fileSource,
  fileDiff,
  split,
  expanded,
  contentKey,
  viewerMode,
  selected,
  viewer,
  viewerContainer,
}: {
  fileSource: Source | undefined;
  fileDiff: FileDiffMetadata | null;
  split: boolean;
  expanded: boolean;
  contentKey: string;
  viewerMode: ViewerMode;
  selected: string;
  viewer: RefObject<CodeViewHandle<Comment, undefined> | null>;
  viewerContainer: RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [highlightSelectedText, setHighlightSelectedText] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const selectedMatch = useRef<number | null>(null);
  const matches = useMemo(
    () => textSearchMatches(query, fileSource || null, fileDiff, split, expanded),
    [query, fileSource, fileDiff, split, expanded],
  );
  const current = matches[active];

  useEffect(() => {
    const onTextSelection = (event: Event) => {
      const host = viewerContainer.current?.querySelector("diffs-container");
      const shadow = host?.shadowRoot;
      if (!host || !event.composedPath().includes(host)) return;
      const selection = (
        shadow as ShadowRoot & { getSelection?: () => Selection | null }
      )?.getSelection?.() || document.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const lineOf = (node: Node | undefined) =>
        (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-line]");
      const startLine = lineOf(range?.startContainer);
      const text = selection?.toString() || "";
      if (
        !range || range.collapsed || !shadow || !startLine ||
        startLine !== lineOf(range.endContainer) || !shadow.contains(startLine) ||
        text.includes("\n")
      ) {
        setHighlightSelectedText(false);
        return;
      }
      const beforeSelection = document.createRange();
      beforeSelection.selectNodeContents(startLine);
      beforeSelection.setEnd(range.startContainer, range.startOffset);
      const start = beforeSelection.toString().length;
      const side = lineSide(startLine);
      const index = textSearchMatches(text, fileSource || null, fileDiff, split, expanded)
        .findIndex((match) =>
          match.line === Number(startLine.dataset.line) &&
          match.start === start && match.side === side);
      if (index === -1) {
        setHighlightSelectedText(false);
        return;
      }
      setQuery(text);
      selectedMatch.current = index;
      setActive(index);
      setHighlightSelectedText(true);
      setOpen(false);
    };
    document.addEventListener("pointerup", onTextSelection);
    document.addEventListener("dblclick", onTextSelection);
    return () => {
      document.removeEventListener("pointerup", onTextSelection);
      document.removeEventListener("dblclick", onTextSelection);
    };
  }, [fileSource, fileDiff, split, expanded]);
  useEffect(() => setHighlightSelectedText(false), [contentKey, viewerMode]);
  useEffect(() => {
    setActive(selectedMatch.current ?? 0);
    selectedMatch.current = null;
  }, [query, contentKey, viewerMode, split, expanded]);
  useEffect(() => {
    if (!open || !current || !viewer.current) return;
    viewer.current.scrollTo({
      type: "line",
      id: selected,
      lineNumber: current.line,
      side: current.side,
      align: "center",
    });
  }, [open, current, selected]);
  useEffect(() => {
    clearHighlights();
    if ((!open && !highlightSelectedText) || !current) return;
    const shadow = viewerContainer.current?.querySelector("diffs-container")?.shadowRoot;
    if (!shadow) return;
    const style = document.createElement("style");
    style.textContent = highlightStyles;
    shadow.append(style);
    const applyHighlights = () => {
      clearHighlights();
      const renderedLines = new Map<number, HTMLElement[]>();
      for (const line of shadow.querySelectorAll<HTMLElement>("[data-line]")) {
        const number = Number(line.dataset.line);
        renderedLines.set(number, [...renderedLines.get(number) || [], line]);
      }
      const otherRanges = matches
        .filter((match) => match !== current)
        .map((match) => rangeForMatch(match, renderedLines))
        .filter((range): range is Range => range !== null);
      if (otherRanges.length)
        CSS.highlights.set(textSearchMatchesHighlightName, new Highlight(...otherRanges));
      const activeRange = rangeForMatch(current, renderedLines);
      if (activeRange) CSS.highlights.set(textSearchHighlightName, new Highlight(activeRange));
    };
    applyHighlights();
    // CodeView first mounts plain text and later replaces it with highlighted
    // token nodes. It also replaces lines as they enter and leave the virtual
    // window, so rebuild the Range after either kind of DOM change.
    const observer = new MutationObserver(applyHighlights);
    observer.observe(shadow, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      clearHighlights();
      style.remove();
    };
  }, [open, highlightSelectedText, matches, current, contentKey, viewerMode]);

  const move = (offset: number) => {
    if (!matches.length) return;
    setActive((index) => (index + offset + matches.length) % matches.length);
  };
  const show = () => {
    setHighlightSelectedText(false);
    setOpen(true);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  };
  const findNext = (offset: number) => {
    if (!query) return show();
    setHighlightSelectedText(false);
    setOpen(true);
    move(offset);
  };
  return {
    open, query, setQuery, matches, active, input, move, show, findNext,
    close: () => setOpen(false),
  };
}

export function TextSearchBar({
  search,
  onClose,
}: {
  search: ReturnType<typeof useTextSearch>;
  onClose: () => void;
}) {
  const { query, matches, active, move } = search;
  return (
    <div className="text-search" role="search">
      <input
        ref={search.input}
        aria-label="Find in viewed file"
        placeholder="Find"
        value={query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span aria-live="polite">
        {query ? `${matches.length ? active + 1 : 0}/${matches.length}` : "0/0"}
      </span>
      <button aria-label="Previous match" disabled={!matches.length} onClick={() => move(-1)}>
        ↑
      </button>
      <button aria-label="Next match" disabled={!matches.length} onClick={() => move(1)}>
        ↓
      </button>
      <button aria-label="Close find" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
