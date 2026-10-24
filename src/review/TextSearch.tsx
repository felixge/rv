import { batch, createComputed, createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewInstance } from "../components/CodeView";
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

// A file to search, in the order it is shown.
export type TextSearchSource = {
  path: string;
  file?: Source;
  diff?: FileDiffMetadata | null;
};

// Find (/ or Cmd/Ctrl+F) in the viewed file, or in every file of the all-files
// diff, plus highlighting other occurrences of text selected on a single line.
export function useTextSearch(options: {
  sources: Accessor<TextSearchSource[]>;
  split: Accessor<boolean>;
  expanded: Accessor<boolean>;
  contentKey: Accessor<string>;
  viewerMode: Accessor<ViewerMode>;
  selected: Accessor<string>;
  viewer: Accessor<CodeViewInstance<Comment> | undefined>;
}) {
  const { sources, split, expanded, contentKey, viewerMode, selected, viewer } = options;
  const [open, setOpen] = createSignal(false);
  const [highlightSelectedText, setHighlightSelectedText] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let selectedMatch: number | null = null;
  const findAll = (text: string) => sources().flatMap(({ path, file, diff }) =>
    textSearchMatches(text, file || null, diff || null, split(), expanded())
      .map((match) => ({ ...match, path })));
  const matches = createMemo(() => findAll(query()));
  const current = createMemo(() => matches()[active()]);
  // The rendered <diffs-container> of each file in the virtual window.
  const hosts = () => viewer()?.getRenderedItems() || [];

  const onTextSelection = (event: Event) => {
    const host = hosts().find((item) => event.composedPath().includes(item.element));
    const shadow = host?.element.shadowRoot;
    if (!host) return;
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
    const index = findAll(text).findIndex((match) =>
      match.path === host.id && match.line === Number(startLine.dataset.line) &&
      match.start === start && match.side === side);
    if (index === -1) {
      setHighlightSelectedText(false);
      return;
    }
    batch(() => {
      setQuery(text);
      selectedMatch = index;
      setActive(index);
      setHighlightSelectedText(true);
      setOpen(false);
    });
  };
  document.addEventListener("pointerup", onTextSelection);
  document.addEventListener("dblclick", onTextSelection);
  onCleanup(() => {
    document.removeEventListener("pointerup", onTextSelection);
    document.removeEventListener("dblclick", onTextSelection);
  });
  createEffect(on([contentKey, viewerMode], () => setHighlightSelectedText(false)));
  // Choose the match before effects follow it to another file, including when
  // an asynchronous all-files search publishes its completed sources.
  createComputed(on([query, contentKey, viewerMode, split, expanded, sources], () => {
    // Loading other files must not replace an explicitly selected occurrence.
    if (highlightSelectedText() && selectedMatch === null) return;
    // Start at the first match in or after the selected file.
    const all = sources();
    const after = new Set(all
      .slice(Math.max(0, all.findIndex((source) => source.path === selected())))
      .map((source) => source.path));
    setActive(selectedMatch ??
      Math.max(0, matches().findIndex((match) => after.has(match.path))));
    selectedMatch = null;
  }));
  createEffect(on([open, current, selected, viewer], ([isOpen, match, path, instance]) => {
    // In the all-files diff, the viewed file follows the match first:
    // re-rendering for a new selection would cancel an earlier scroll.
    if (!isOpen || !match || match.path !== path) return;
    instance?.scrollTo({
      type: "line",
      id: match.path,
      lineNumber: match.line,
      side: match.side,
      align: "center",
    });
  }));
  createEffect(on([open, highlightSelectedText, matches, current, contentKey, viewerMode, viewer], ([isOpen, highlightSelection, all, match]) => {
    clearHighlights();
    if ((!isOpen && !highlightSelection) || !match) return;
    const styled = new Map<ShadowRoot, HTMLStyleElement>();
    const observer = new MutationObserver(() => applyHighlights());
    const applyHighlights = () => {
      clearHighlights();
      const renderedLines = new Map<string, Map<number, HTMLElement[]>>();
      for (const host of hosts()) {
        const shadow = host.element.shadowRoot;
        if (!shadow) continue;
        if (!styled.has(shadow)) {
          const style = document.createElement("style");
          style.textContent = highlightStyles;
          shadow.append(style);
          styled.set(shadow, style);
          observer.observe(shadow, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        }
        const lines = new Map<number, HTMLElement[]>();
        for (const line of shadow.querySelectorAll<HTMLElement>("[data-line]")) {
          const number = Number(line.dataset.line);
          lines.set(number, [...lines.get(number) || [], line]);
        }
        renderedLines.set(host.id, lines);
      }
      const rangeFor = (target: typeof match) => {
        const lines = renderedLines.get(target.path);
        return lines ? rangeForMatch(target, lines) : null;
      };
      const otherRanges = all
        .filter((other) => other !== match)
        .map(rangeFor)
        .filter((range): range is Range => range !== null);
      if (otherRanges.length)
        CSS.highlights.set(textSearchMatchesHighlightName, new Highlight(...otherRanges));
      const activeRange = rangeFor(match);
      if (activeRange) CSS.highlights.set(textSearchHighlightName, new Highlight(activeRange));
    };
    applyHighlights();
    // CodeView first mounts plain text and later replaces it with highlighted
    // token nodes. It also replaces lines as they enter and leave the virtual
    // window, and mounts files as they scroll into view, so rebuild the Ranges
    // after any of these DOM changes.
    const container = viewer()?.getContainerElement();
    if (container) observer.observe(container, { childList: true, subtree: true });
    onCleanup(() => {
      observer.disconnect();
      clearHighlights();
      for (const style of styled.values()) style.remove();
    });
  }));

  const move = (offset: number) => {
    const count = matches().length;
    if (!count) return;
    setActive((index) => (index + offset + count) % count);
  };
  const show = () => {
    batch(() => {
      setHighlightSelectedText(false);
      setOpen(true);
    });
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  };
  const findNext = (offset: number) => {
    if (!query()) return show();
    batch(() => {
      setHighlightSelectedText(false);
      setOpen(true);
      move(offset);
    });
  };
  return {
    open, query, setQuery, matches, active, move, show, findNext,
    input: (element: HTMLInputElement) => {
      input = element;
    },
    close: () => setOpen(false),
  };
}

export function TextSearchBar(props: {
  search: ReturnType<typeof useTextSearch>;
  status?: string;
  onClose: () => void;
}) {
  const { search } = props;
  return (
    <div class="text-search" role="search">
      <input
        ref={search.input}
        aria-label="Find in viewed file"
        placeholder="Find"
        value={search.query()}
        onInput={(event) => search.setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search.move(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span aria-live="polite">
        {props.status || (search.query()
          ? `${search.matches().length ? search.active() + 1 : 0}/${search.matches().length}`
          : "0/0")}
      </span>
      <button aria-label="Previous match" disabled={!search.matches().length} onClick={() => search.move(-1)}>
        ↑
      </button>
      <button aria-label="Next match" disabled={!search.matches().length} onClick={() => search.move(1)}>
        ↓
      </button>
      <button aria-label="Close find" onClick={() => props.onClose()}>
        ×
      </button>
    </div>
  );
}
