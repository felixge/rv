import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  parseDiffFromFile,
  type CodeViewItem,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { BrowserTree, directoryPaths } from "../components/BrowserTree";
import { FileFinder } from "../components/FileFinder";
import { LineStats } from "../components/LineStats";
import { Modal } from "../components/Modal";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { ReviewPalette } from "../components/ReviewPalette";
import { CommandLauncher } from "../components/CommandLauncher";
import { api, loadFile } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { nameHue } from "../lib/format";
import { onCmdEnter, onPlainClick } from "../lib/events";
import { readLocation, readPreferences, viewHref, type ViewLocation } from "../lib/location";
import { rememberScroll, restoreScroll, scrollStore } from "../lib/scroll";
import { shortcuts, type Command } from "../lib/shortcuts";
import {
  textSearchHighlightName,
  textSearchMatches,
  textSearchMatchesHighlightName,
} from "../lib/textSearch";
import { formatPrompt, reference } from "../prompt.js";
import {
  MESSAGE_PATH,
  type Comment,
  type Comparison,
  type Content,
  type Info,
  type SavedState,
  type TextSearchMatch,
  type ViewerMode,
} from "../types";

declare const __RV_VERSION__: string;

export function Review({
  info,
  state,
  refreshInfo,
}: {
  info: Info;
  state: SavedState;
  refreshInfo: () => Promise<Info>;
}) {
  const [saved] = useState(() => ({ ...readPreferences(state.view), ...readLocation(info) }));
  const [restoring, setRestoring] = useState(saved.mode !== "working");
  const [reviewed, setReviewed] = useState<Record<string, string[]>>(() =>
    state.reviewed && typeof state.reviewed === "object" ? state.reviewed : {},
  );
  const [search, setSearch] = useState(saved.search);
  const [comments, setComments] = useState<Comment[]>(() =>
    Array.isArray(state.comments) ? state.comments : [],
  );
  const [storageError, setStorageError] = useState("");
  const [tab, setTab] = useState(saved.tab);
  const [mode, setMode] = useState(saved.mode);
  const [from, setFrom] = useState(saved.from);
  const [to, setTo] = useState(saved.to);
  const [comparison, setComparison] = useState<Comparison>(info.working);
  const compareLabel = !comparison.target
    ? "Uncommitted changes"
    : comparison.message !== undefined
      ? `Commit ${comparison.target.slice(0, 7)}`
      : `${comparison.base.slice(0, 7)} → ${comparison.target.slice(0, 7)}`;
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(saved.selected);
  const [viewerMode, setViewerMode] = useState(saved.viewerMode);
  const contentKey = JSON.stringify([
    tab, selected, ...(tab === "changes" ? [comparison.base, comparison.target] : []),
  ]);
  const [loaded, setLoaded] = useState<{ key: string; content: Content }>();
  // Never mount the previous file under the new selection while its effect loads.
  const content = loaded?.key === contentKey ? loaded.content : undefined;
  const parsedDiffs = useRef(new Map<string, FileDiffMetadata>());
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(saved.split);
  const [wrap, setWrap] = useState(saved.wrap);
  const [expanded, setExpanded] = useState(saved.expanded);
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [draft, setDraft] = useState("");
  const [generalDraft, setGeneralDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copiedPath, setCopiedPath] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showCopiedPrompt, setShowCopiedPrompt] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showTextSearch, setShowTextSearch] = useState(false);
  const [highlightSelectedText, setHighlightSelectedText] = useState(false);
  const [textSearch, setTextSearch] = useState("");
  const [activeTextMatch, setActiveTextMatch] = useState(0);
  const [reviewPickerRequest, setReviewPickerRequest] = useState(0);
  const [showFinder, setShowFinder] = useState(false);
  const [showLinePicker, setShowLinePicker] = useState(false);
  const [lineTarget, setLineTarget] = useState("");
  const [lineSide, setLineSide] = useState<"additions" | "deletions">("additions");
  const [lineError, setLineError] = useState("");
  const [showFiles, setShowFiles] = useState(saved.showFiles);
  const [showComments, setShowComments] = useState(saved.showComments);
  const [filesWidth, setFilesWidth] = useState(saved.filesWidth);
  const [commentsWidth, setCommentsWidth] = useState(saved.commentsWidth);
  const [collapsed, setCollapsed] = useState(saved.collapsed);
  const [highlight, setHighlight] = useState<Comment | null>(null);
  const [pendingComment, setPendingComment] = useState<Comment | null>(null);
  const clearSelection = () => {
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
  };
  const viewer = useRef<CodeViewHandle<Comment, undefined>>(null);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const textSearchInput = useRef<HTMLInputElement>(null);
  const selectedTextMatch = useRef<number | null>(null);
  const interactionVersion = useRef(0);
  const viewerFocusRequest = useRef<number | null>(null);
  const viewerScrollKey = JSON.stringify(["viewer", contentKey, viewerMode]);
  const activeViewerScrollKey = useRef(viewerScrollKey);
  activeViewerScrollKey.current = viewerScrollKey;
  const explicitViewerScrollKey = useRef("");
  const comparisonRequest = useRef(0);
  const viewRefresh = useRef(0);
  const latestCommitPending = useRef(false);
  const [contentRevision, setContentRevision] = useState(0);
  const keySequence = useRef("");
  const keySequenceTimer = useRef<number | undefined>(undefined);
  const reviewHistory = useRef<{
    scope: string;
    paths: string[];
    reviewed: boolean;
  }[]>([]);
  const treeOrder = useRef<[string[], string[]]>([[], []]);
  const setUnreviewedTreeOrder = useCallback((paths: string[]) => {
    treeOrder.current[0] = paths;
  }, []);
  const setReviewedTreeOrder = useCallback((paths: string[]) => {
    treeOrder.current[1] = paths;
  }, []);
  useEffect(() => {
    const trackInteraction = () => interactionVersion.current++;
    const trackTypingFocus = (event: FocusEvent) => {
      if ((event.target as HTMLElement).matches(
        "input, textarea, select, [contenteditable=true]",
      )) trackInteraction();
    };
    document.addEventListener("pointerdown", trackInteraction, true);
    document.addEventListener("keydown", trackInteraction, true);
    document.addEventListener("focusin", trackTypingFocus);
    return () => {
      document.removeEventListener("pointerdown", trackInteraction, true);
      document.removeEventListener("keydown", trackInteraction, true);
      document.removeEventListener("focusin", trackTypingFocus);
    };
  }, []);
  useEffect(() => {
    if (saved.mode !== "working")
      void compare(saved.mode, { to: saved.target, from: saved.base, restore: true }).finally(
        () => setRestoring(false),
      );
  }, []);
  const href = (overrides: Partial<ViewLocation> = {}) => viewHref({
    tab, comparison, path: selected, viewerMode, split, expanded, commits: info.commits,
    ...overrides,
  });
  const fileHref = (path: string) => href({ path });
  const initialURL = useRef(true);
  useEffect(() => {
    if (restoring || comparing || error) return;
    const next = href();
    if (initialURL.current) {
      history.replaceState(null, "", next);
      initialURL.current = false;
    } else if (next !== `${location.pathname}${location.search}${location.hash}`) {
      history.pushState(null, "", next);
    }
  }, [restoring, comparing, error, tab, comparison, selected, viewerMode, split, expanded, info.commits]);
  useEffect(() => {
    // Back/Forward use the same loading path as a direct link or new tab.
    const restoreURL = () => location.reload();
    window.addEventListener("popstate", restoreURL);
    return () => window.removeEventListener("popstate", restoreURL);
  }, []);

  // Send only changed sections: navigation or preferences in another tab must
  // never write its stale copy of comments back over the shared review.
  const stateRef = useRef<SavedState>(state);
  const pendingState = useRef<SavedState>({});
  const stateDirty = useRef(false);
  const stateFlush = useRef<(keepalive?: boolean) => void>(() => {});
  useEffect(() => {
    // Mutable views are only reviewed for this page snapshot.
    const next: SavedState = {
      view: { search, wrap, showFiles, showComments, filesWidth, commentsWidth, collapsed },
      reviewed: Object.fromEntries(
        Object.entries(reviewed).filter(
          ([scope]) => scope !== "files" && scope !== "working",
        ),
      ),
      comments,
    };
    for (const key of ["view", "reviewed", "comments"] as const) {
      if (JSON.stringify(next[key]) !== JSON.stringify(stateRef.current[key])) {
        Object.assign(pendingState.current, { [key]: next[key] });
        stateDirty.current = true;
      }
    }
    stateRef.current = next;
    const timer = setTimeout(() => stateFlush.current(), 250);
    return () => clearTimeout(timer);
  }, [
    search, wrap, showFiles, showComments, filesWidth, commentsWidth,
    collapsed, reviewed, comments,
  ]);
  useEffect(() => {
    const flush = (keepalive = false) => {
      if (!stateDirty.current) return;
      stateDirty.current = false;
      const patch = pendingState.current;
      pendingState.current = {};
      fetch("/api/state", {
        method: "PATCH",
        headers: { "X-Rv": "1" },
        body: JSON.stringify(patch),
        keepalive,
      })
        .then(async (response) => {
          if (response.ok) return;
          throw new Error((await response.json()).error);
        })
        .catch(() => {
          pendingState.current = { ...patch, ...pendingState.current };
          stateDirty.current = true;
          setStorageError(
            "Could not save review state to disk. Copy your comments before closing.",
          );
        });
    };
    stateFlush.current = flush;
    const flushOnHide = () => flush(true);
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, []);
  const paths = useMemo(
    () =>
      tab === "files"
        ? info.files
        : comparison.entries.map((entry) => entry.path),
    [tab, info.files, comparison],
  );
  const entries = tab === "files" ? info.working.entries : comparison.entries;
  const fileSearch = search.trim().replaceAll("\\", "/").toLowerCase();
  const selectedEntry = comparison.entries.find((entry) => entry.path === selected);
  const messageView =
    tab === "changes" &&
    selected === MESSAGE_PATH &&
    comparison.message !== undefined;
  const messageContent = useMemo<Content | undefined>(
    () => comparison.message === undefined
      ? undefined
      : {
          oldFile: null,
          newFile: {
            name: "COMMIT_MESSAGE.txt",
            contents: comparison.message,
            cacheKey: contentKey,
          },
        },
    [comparison.message, contentKey],
  );
  const reviewScope =
    tab === "files"
      ? "files"
      : !comparison.target
        ? "working"
        : JSON.stringify([
            comparison.message !== undefined ? "commit" : "range",
            comparison.base,
            comparison.target,
          ]);
  const reviewedInView = reviewed[reviewScope];
  const [unreviewedPaths, reviewedPaths] = useMemo(
    () => [
      paths.filter((path) => !reviewedInView?.includes(path)),
      paths.filter((path) => reviewedInView?.includes(path)),
    ],
    [paths, reviewedInView],
  );
  const hasMessage = tab === "changes" && comparison.message !== undefined;
  const messageReviewed = reviewedInView?.includes(MESSAGE_PATH) || false;
  const reviewedCount =
    reviewedPaths.length + (hasMessage && messageReviewed ? 1 : 0);
  const selectedReviewed = reviewedInView?.includes(selected) || false;
  const focusViewer = useCallback(() => {
    viewerContainer.current?.focus({ preventScroll: true });
  }, []);
  const select = useCallback(
    (path: string) => {
      if (path === selected) {
        focusViewer();
        return;
      }
      viewerFocusRequest.current = interactionVersion.current;
      setSelected(path);
      clearSelection();
    },
    [selected, focusViewer],
  );

  useEffect(() => {
    if (restoring) return;
    if (messageView && messageContent) {
      setLoaded({
        key: contentKey,
        content: messageContent,
      });
      setLoading(false);
      setError("");
      return;
    }
    if (!selected || !paths.includes(selected)) {
      setLoaded(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const load =
      tab === "files"
        ? loadFile(selected, "", contentRevision).then((newFile) => ({
            oldFile: null,
            newFile,
          }))
        : Promise.all([
            loadFile(selected, comparison.base, contentRevision),
            loadFile(selected, comparison.target, contentRevision),
          ]).then(([oldFile, newFile]) => ({ oldFile, newFile }));
    load
      .then((value) => {
        if (active) setLoaded({ key: contentKey, content: value });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, paths, tab, comparison, messageView, messageContent, restoring, contentKey, contentRevision]);

  async function compare(nextMode: string, {
    to: nextTo = to,
    from: nextFrom = from,
    restore = false,
    info: refreshedInfo,
    refresh = restore ? 0 : ++viewRefresh.current,
  }: { to?: string; from?: string; restore?: boolean; info?: Info; refresh?: number } = {}) {
    const id = ++comparisonRequest.current;
    if (!restore) setContentRevision(refresh);
    if (!restore) {
      setMode(nextMode);
      setSearch("");
    }
    setComparing(true);
    setError("");
    clearSelection();
    try {
      const nextInfo = restore ? info : refreshedInfo || await refreshInfo();
      if (id !== comparisonRequest.current) return;
      const result =
        nextMode === "working"
          ? nextInfo.working
          : await api<Comparison>("compare", {
              mode: nextMode,
              from: nextFrom,
              to: nextTo,
              refresh: String(refresh),
            });
      if (id !== comparisonRequest.current) return;
      setComparison(result);
      if (nextMode === "commit") setTo(result.target);
      setSelected((current) => {
        const kept = result.entries.some((entry) => entry.path === current);
        if (restore && (tab === "files" || kept)) return current;
        if (nextMode === "commit") return MESSAGE_PATH;
        return kept ? current : result.entries[0]?.path || "";
      });
    } catch (e) {
      if (id === comparisonRequest.current) {
        if (restore) setSelected("");
        setError((e as Error).message);
      }
    } finally {
      if (id === comparisonRequest.current) setComparing(false);
    }
  }

  const diffView = tab === "changes" && !messageView && viewerMode === "diff";
  const singleSide = tab === "changes" && !messageView && viewerMode !== "diff"
    ? viewerMode === "old" ? "deletions" : "additions"
    : undefined;
  const fileSource = diffView ? undefined
    : singleSide === "deletions" ? content?.oldFile : content?.newFile;

  function changeViewerMode(value: ViewerMode) {
    setViewerMode(value);
    clearSelection();
    setShowLinePicker(false);
  }

  const onSelection = useCallback((value: SelectedLineRange | null) => {
    setHighlight(null);
    if (value) setShowComments(true);
    // A reference must use one file-side's coordinates, never mixed old/new numbers.
    setRange(
      value && singleSide
        ? { start: value.start, end: value.end, side: singleSide }
        : value?.endSide && value.endSide !== value.side
        ? { ...value, end: value.start, endSide: value.side }
        : value,
    );
  }, [singleSide]);
  const options = useMemo(
    () => ({
      theme: "light-plus" as const,
      themeType: "light" as const,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      enableLineSelection: true,
      onLineSelected: onSelection,
      itemMetrics: { lineHeight: 23 },
      pointerEventsOnScroll: true,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      expandUnchanged: expanded,
      disableFileHeader: true,
    }),
    [split, wrap, expanded, onSelection],
  );
  const prompt = formatPrompt(comments);
  const notice = diffView
    ? content?.newFile?.notice || content?.oldFile?.notice
    : fileSource?.notice;
  const start = range ? Math.min(range.start, range.end) : 1;
  const end = range ? Math.max(range.start, range.end) : 1;

  function matchesScope(comment: Comment) {
    return (
      !comment.general &&
      (tab === "files"
        ? comment.context === "File"
        : comment.comparison
          ? comment.comparison.base === comparison.base &&
            comment.comparison.target === comparison.target
          : comment.context === compareLabel)
    );
  }
  function matchesView(comment: Comment) {
    return comment.path === selected && matchesScope(comment) &&
      (!singleSide || (comment.side || "additions") === singleSide);
  }
  function commentRange(comment: Comment): SelectedLineRange {
    return {
      start: comment.start,
      end: comment.end,
      ...(diffView
        ? {
            side:
              comment.side === "deletions"
                ? ("deletions" as const)
                : ("additions" as const),
          }
        : {}),
    };
  }
  const fileDiff = useMemo(() => {
    if (!content || !diffView || notice ||
        !(content.oldFile || content.newFile)) return null;
    let diff = parsedDiffs.current.get(contentKey);
    if (!diff) {
      diff = parseDiffFromFile(content.oldFile, content.newFile);
      // Include the comparison even for additions/deletions with a missing side.
      diff.cacheKey = contentKey;
      parsedDiffs.current.set(contentKey, diff);
    }
    return diff;
  }, [content, contentKey, diffView, notice]);
  const textMatches = useMemo(
    () => textSearchMatches(
      textSearch,
      fileSource || null,
      fileDiff,
      split,
      expanded,
    ),
    [textSearch, fileSource, fileDiff, split, expanded],
  );
  const currentTextMatch = textMatches[activeTextMatch];
  useEffect(() => {
    const onTextSelection = (event: Event) => {
      const host = viewerContainer.current?.querySelector("diffs-container");
      const shadow = host?.shadowRoot;
      if (!host || !event.composedPath().includes(host)) return;
      const selection = (
        shadow as ShadowRoot & { getSelection?: () => Selection | null }
      )?.getSelection?.() || document.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const startElement = range?.startContainer instanceof Element
        ? range.startContainer
        : range?.startContainer.parentElement;
      const endElement = range?.endContainer instanceof Element
        ? range.endContainer
        : range?.endContainer.parentElement;
      const startLine = startElement?.closest<HTMLElement>("[data-line]");
      const endLine = endElement?.closest<HTMLElement>("[data-line]");
      const query = selection?.toString() || "";
      if (
        !range || range.collapsed || !shadow || !startLine ||
        startLine !== endLine || !shadow.contains(startLine) || query.includes("\n")
      ) {
        setHighlightSelectedText(false);
        return;
      }

      const beforeSelection = document.createRange();
      beforeSelection.selectNodeContents(startLine);
      beforeSelection.setEnd(range.startContainer, range.startOffset);
      const start = beforeSelection.toString().length;
      const side = startLine.closest("[data-deletions]") ||
          startLine.dataset.lineType?.includes("deletion")
        ? "deletions"
        : startLine.closest("[data-additions]") ||
            startLine.dataset.lineType?.includes("addition")
          ? "additions"
          : undefined;
      const matches = textSearchMatches(query, fileSource || null, fileDiff, split, expanded);
      const selectedMatch = matches.findIndex((match) =>
        match.line === Number(startLine.dataset.line) &&
        match.start === start && match.side === side
      );
      if (selectedMatch === -1) {
        setHighlightSelectedText(false);
        return;
      }
      setTextSearch(query);
      selectedTextMatch.current = selectedMatch;
      setActiveTextMatch(selectedMatch);
      setHighlightSelectedText(true);
      setShowTextSearch(false);
    };
    document.addEventListener("pointerup", onTextSelection);
    document.addEventListener("dblclick", onTextSelection);
    return () => {
      document.removeEventListener("pointerup", onTextSelection);
      document.removeEventListener("dblclick", onTextSelection);
    };
  }, [fileSource, fileDiff, split, expanded]);
  useEffect(
    () => setHighlightSelectedText(false),
    [contentKey, viewerMode],
  );
  useEffect(
    () => {
      setActiveTextMatch(selectedTextMatch.current ?? 0);
      selectedTextMatch.current = null;
    },
    [textSearch, contentKey, viewerMode, split, expanded],
  );
  useEffect(() => {
    if (!showTextSearch || !currentTextMatch || !viewer.current) return;
    viewer.current.scrollTo({
      type: "line",
      id: selected,
      lineNumber: currentTextMatch.line,
      side: currentTextMatch.side,
      align: "center",
    });
  }, [showTextSearch, currentTextMatch, selected]);
  useEffect(() => {
    CSS.highlights.delete(textSearchHighlightName);
    CSS.highlights.delete(textSearchMatchesHighlightName);
    if (
      (!showTextSearch && !highlightSelectedText) ||
      !currentTextMatch || !viewerContainer.current
    ) return;
    const host = viewerContainer.current.querySelector("diffs-container");
    const shadow = host?.shadowRoot;
    if (!shadow) return;
    const style = document.createElement("style");
    style.textContent = `::highlight(${textSearchMatchesHighlightName}) {
      color: inherit;
      background: rgba(147, 157, 171, 0.35);
    }
    ::highlight(${textSearchHighlightName}) {
      color: inherit;
      background: #ffd75e;
    }`;
    shadow.append(style);

    const rangeForMatch = (
      match: TextSearchMatch,
      renderedLines: Map<number, HTMLElement[]>,
    ) => {
      const side = match.side;
      const lines = renderedLines.get(match.line) || [];
      const line = !side
        ? lines[0]
        : lines.find((candidate) =>
            candidate.closest(`[data-${side}]`) ||
            candidate.dataset.lineType?.includes(
              side === "deletions" ? "deletion" : "addition",
            )
          );
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let startNode: Text | null = null;
      let endNode: Text | null = null;
      let startOffset = 0;
      let endOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const nextOffset = offset + node.data.length;
        if (!startNode && match.start < nextOffset) {
          startNode = node;
          startOffset = match.start - offset;
        }
        if (match.end <= nextOffset) {
          endNode = node;
          endOffset = match.end - offset;
          break;
        }
        offset = nextOffset;
      }
      if (!startNode || !endNode) return null;
      const range = new Range();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    };

    const applyHighlights = () => {
      CSS.highlights.delete(textSearchHighlightName);
      CSS.highlights.delete(textSearchMatchesHighlightName);
      const renderedLines = new Map<number, HTMLElement[]>();
      for (const line of shadow.querySelectorAll<HTMLElement>("[data-line]")) {
        const number = Number(line.dataset.line);
        const candidates = renderedLines.get(number) || [];
        candidates.push(line);
        renderedLines.set(number, candidates);
      }
      const otherRanges = textMatches
        .filter((match) => match !== currentTextMatch)
        .map((match) => rangeForMatch(match, renderedLines))
        .filter((range): range is Range => range !== null);
      if (otherRanges.length) {
        CSS.highlights.set(
          textSearchMatchesHighlightName,
          new Highlight(...otherRanges),
        );
      }
      const activeRange = rangeForMatch(currentTextMatch, renderedLines);
      if (!activeRange) return false;
      CSS.highlights.set(textSearchHighlightName, new Highlight(activeRange));
      return true;
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
      CSS.highlights.delete(textSearchHighlightName);
      CSS.highlights.delete(textSearchMatchesHighlightName);
      style.remove();
    };
  }, [showTextSearch, highlightSelectedText, textMatches, currentTextMatch, contentKey, viewerMode]);
  const moveTextMatch = (offset: number) => {
    if (!textMatches.length) return;
    setActiveTextMatch((current) =>
      (current + offset + textMatches.length) % textMatches.length,
    );
  };
  const openTextSearch = () => {
    setHighlightSelectedText(false);
    setShowTextSearch(true);
    requestAnimationFrame(() => {
      textSearchInput.current?.focus();
      textSearchInput.current?.select();
    });
  };
  const findTextMatch = (offset: number) => {
    if (!textSearch) {
      openTextSearch();
      return;
    }
    setHighlightSelectedText(false);
    setShowTextSearch(true);
    moveTextMatch(offset);
  };
  const annotations = comments.filter(matchesView).map((comment) => ({
    lineNumber: comment.end,
    side:
      comment.side === "deletions"
        ? ("deletions" as const)
        : ("additions" as const),
    metadata: comment,
  }));
  // CodeView needs a new version when the same item gets new text or annotations.
  const itemVersion = useRef(0);
  const previousComments = useRef(comments);
  const previousContent = useRef(content);
  if (
    previousComments.current !== comments ||
    previousContent.current !== content
  ) {
    previousComments.current = comments;
    previousContent.current = content;
    itemVersion.current++;
  }
  const items: CodeViewItem<Comment>[] =
    content && !notice
      ? fileSource
        ? [
            {
              type: "file",
              id: selected,
              file: fileSource,
              annotations,
              version: itemVersion.current,
            },
          ]
        : fileDiff
          ? [
              {
                type: "diff",
                id: selected,
                fileDiff,
                annotations,
                version: itemVersion.current,
              },
            ]
          : []
      : [];
  const highlightedRange =
    highlight && matchesView(highlight) ? commentRange(highlight) : range;
  // Full-file rendering has one column; side metadata is only for the comment.
  const viewerRange = highlightedRange && !diffView
    ? { start: highlightedRange.start, end: highlightedRange.end }
    : highlightedRange;
  // The explorer lists current files, not changes: show their total size in
  // lines instead of +/− change stats. Stats follow the file search.
  function groupStats(groupPaths: string[]) {
    const visible = groupPaths.filter((path) => path.toLowerCase().includes(fileSearch));
    if (tab === "files") {
      const missing = visible.some((path) => info.lineCounts[path] == null);
      return {
        lines: visible.reduce((sum, path) => sum + (info.lineCounts[path] || 0), 0),
        title: `Total lines of code${missing ? "; excludes binary or unpreviewable files" : ""}`,
      };
    }
    const changes = entries.filter((entry) => visible.includes(entry.path));
    const missing = changes.some((entry) => entry.additions == null || entry.deletions == null);
    return {
      additions: changes.reduce((sum, entry) => sum + (entry.additions || 0), 0),
      deletions: changes.reduce((sum, entry) => sum + (entry.deletions || 0), 0),
      title: `Lines changed${missing ? "; excludes files with unavailable line counts (binary or unpreviewable text)" : ""}`,
    };
  }

  useEffect(() => {
    if (
      viewerFocusRequest.current !== null && content && !loading && !comparing &&
      !restoring && items.length
    ) {
      const request = viewerFocusRequest.current;
      viewerFocusRequest.current = null;
      if (request === interactionVersion.current) focusViewer();
    }
  }, [content, loading, comparing, restoring, items.length, focusViewer]);

  useEffect(() => {
    const scrollKey = viewerScrollKey;
    let scroller: HTMLElement | null = null;
    const save = () => {
      if (scroller && activeViewerScrollKey.current === scrollKey)
        rememberScroll(info.root, scrollKey, scroller);
    };
    // Explicit comment navigation owns the destination; ordinary file and mode
    // navigation returns to the last position for that exact rendered view.
    const position = scrollStore(info.root)[scrollKey];
    const restoreInteraction = interactionVersion.current;
    let frame = 0;
    let listening = false;
    let attempts = 0;
    const restore = () => {
      scroller ||= viewerContainer.current;
      if (!scroller) {
        if (attempts++ < 120) frame = requestAnimationFrame(restore);
        return;
      }
      // Syntax highlighting can finish after mount. Wait until the virtualized
      // content is tall enough instead of letting the browser clamp the saved
      // position to zero before those lines exist.
      if (
        position &&
        scroller.scrollHeight - scroller.clientHeight < position.top &&
        attempts++ < 120
      ) {
        frame = requestAnimationFrame(restore);
        return;
      }
      if (interactionVersion.current !== restoreInteraction) {
        // Never override scrolling or focus movement performed while the
        // virtualized content was still finishing its initial render.
      } else if (explicitViewerScrollKey.current === scrollKey)
        explicitViewerScrollKey.current = "";
      else restoreScroll(info.root, scrollKey, scroller);
      scroller.addEventListener("scroll", save, { passive: true });
      listening = true;
    };
    frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      if (listening && scroller) {
        scroller.removeEventListener("scroll", save);
      }
    };
  }, [info.root, viewerScrollKey, content]);

  useEffect(() => {
    if (!pendingComment || loading || comparing || !content || !viewer.current)
      return;
    explicitViewerScrollKey.current = viewerScrollKey;
    viewer.current.scrollTo({
      type: "range",
      id: pendingComment.path,
      range: commentRange(pendingComment),
      align: "center",
    });
    setPendingComment(null);
  }, [pendingComment, content, loading, comparing, viewerMode, viewerScrollKey]);

  async function openComment(comment: Comment) {
    const id = ++comparisonRequest.current;
    setComparing(false);
    setRange(null);
    setHighlight(comment);
    setError("");
    if (viewerMode !== "diff" && comment.context !== "File" && !comment.commit)
      setViewerMode(comment.side === "deletions" ? "old" : "new");
    if (matchesView(comment)) {
      setPendingComment(comment);
      return;
    }
    if (matchesScope(comment)) {
      setSelected(comment.path);
      setPendingComment(comment);
      return;
    }
    const refresh = ++viewRefresh.current;
    setContentRevision(refresh);
    setLoaded(undefined);
    setSearch("");
    let nextInfo: Info;
    try {
      nextInfo = await refreshInfo();
      if (id !== comparisonRequest.current) return;
    } catch (e) {
      if (id === comparisonRequest.current) setError((e as Error).message);
      return;
    }
    if (comment.context === "File") {
      setTab("files");
      setComparing(false);
    } else {
      try {
        const nextMode =
          comment.context === "Working tree" || comment.context === "Uncommitted changes"
            ? "working"
            : comment.context.startsWith("Commit ")
              ? "commit"
              : "range";
        const [base, target] = comment.context.split(" → ");
        const result =
          nextMode === "working"
            ? nextInfo.working
            : comment.comparison ||
              await api<Comparison>("compare", {
                mode: nextMode,
                from: base,
                to: nextMode === "commit" ? comment.context.slice(7) : target,
                refresh: String(refresh),
              });
        if (id !== comparisonRequest.current) return;
        setComparison(result);
        setMode(nextMode);
        setFrom(result.base);
        setTo(result.target || nextInfo.commits[0]?.id || "");
        setTab("changes");
        setComparing(false);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    setSelected(comment.path);
    setPendingComment(comment);
  }

  function saveComment() {
    if (!draft.trim()) return;
    setSubmitted(false);
    if (editing) {
      setComments((items) =>
        items.map((item) =>
          item.id === editing ? { ...item, text: draft.trim() } : item,
        ),
      );
    } else {
      if (!range || !selected) return;
      const comment: Comment = {
        id: crypto.randomUUID(),
        path: selected,
        start,
        end,
        text: draft.trim(),
        side: range.side,
        context: tab === "files" ? "File" : compareLabel,
        ...(tab === "changes" ? { comparison } : {}),
        ...(messageView ? { commit: comparison.target } : {}),
      };
      setComments((items) => [...items, comment]);
    }
    setDraft("");
    setEditing(undefined);
    setRange(null);
    setCopied(false);
  }

  function saveGeneralComment() {
    if (!generalDraft.trim()) return;
    setSubmitted(false);
    setComments((items) => [...items, {
      id: crypto.randomUUID(),
      path: "",
      start: 0,
      end: 0,
      text: generalDraft.trim(),
      general: true,
      context: "General",
    }]);
    setGeneralDraft("");
    setCopied(false);
  }

  async function copyPrompt() {
    setCopyError("");
    // Never open a dialog on failure.
    try {
      await copyText(prompt);
      setCopied(true);
      setShowPrompt(false);
      setShowCopiedPrompt(true);
    } catch {
      setCopied(false);
      setCopyError(
        "Clipboard blocked by your browser. Use Preview to select and copy the text.",
      );
    }
  }

  async function submitPrompt() {
    if (!prompt || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await fetch("/api/agent/submit", {
        method: "POST",
        headers: { "X-Rv": "1", "Content-Type": "text/plain" },
        body: prompt,
      });
      if (!response.ok) throw new Error((await response.json()).error);
      setComments([]);
      setDraft("");
      setGeneralDraft("");
      setEditing(undefined);
      setRange(null);
      setHighlight(null);
      setShowPrompt(false);
      setCopied(false);
      setSubmitted(true);
      pendingState.current = { ...pendingState.current, comments: [] };
      stateDirty.current = true;
      stateFlush.current();
    } catch (error) {
      setSubmitError((error as Error).message || "Could not submit the prompt.");
    } finally {
      setSubmitting(false);
    }
  }

  const sendPrompt = info.agent ? submitPrompt : copyPrompt;
  const copyLabel = copied ? "✓ Copied" : "Copy Prompt";
  const sendLabel = !info.agent ? copyLabel : submitting ? "Submitting…" : "Submit to Agent";

  function changeTab(value: "files" | "changes", refresh = true) {
    if (refresh) {
      comparisonRequest.current++;
      if (value === "files") setComparing(false);
      const request = ++viewRefresh.current;
      setContentRevision(request);
      void refreshInfo().catch((error) => {
        if (request === viewRefresh.current)
          setError((error as Error).message);
      });
    }
    setTab(value);
    setSearch("");
    clearSelection();
    if (
      value === "changes" &&
      !comparison.entries.some((entry) => entry.path === selected)
    )
      setSelected(
        comparison.message !== undefined
          ? MESSAGE_PATH
          : comparison.entries[0]?.path || "",
      );
  }

  function resetReview() {
    setComments([]);
    setReviewed({});
    reviewHistory.current = [];
    setEditing(undefined);
    setDraft("");
    setGeneralDraft("");
    clearSelection();
    setCopied(false);
  }

  function clearReview() {
    if (!window.confirm(
      "Clear all comments and review progress? View settings will be kept. This cannot be undone.",
    )) return;
    resetReview();
  }

  function clearCopiedReview() {
    setShowCopiedPrompt(false);
    resetReview();
  }

  function togglePathReviewed(path: string, advance = false) {
    if (!path || !(path === MESSAGE_PATH || paths.includes(path)) || loading || comparing)
      return;
    const wasReviewed = reviewedInView?.includes(path) || false;
    reviewHistory.current.push({
      scope: reviewScope,
      paths: [path],
      reviewed: wasReviewed,
    });
    if (advance && !wasReviewed) moveFile(1);
    setReviewed((current) => ({
      ...current,
      [reviewScope]: wasReviewed
        ? (current[reviewScope] || []).filter((item) => item !== path)
        : [...(current[reviewScope] || []), path],
    }));
  }

  function toggleDirectoryReviewed(directory: string) {
    if (loading || comparing) return;
    const files = paths.filter((path) => path.startsWith(directory));
    if (!files.length) return;
    const wasReviewed = files.every((path) => reviewedInView?.includes(path));
    reviewHistory.current.push({
      scope: reviewScope,
      paths: files,
      reviewed: wasReviewed,
    });
    setReviewed((current) => ({
      ...current,
      [reviewScope]: wasReviewed
        ? (current[reviewScope] || []).filter(
            (item) => !files.includes(item),
          )
        : [...new Set([...(current[reviewScope] || []), ...files])],
    }));
  }

  function toggleReviewed() {
    togglePathReviewed(selected, true);
  }

  function undo() {
    const action = reviewHistory.current.pop();
    if (!action) return;
    setReviewed((current) => {
      const reviewed = current[action.scope] || [];
      return {
        ...current,
        [action.scope]: action.reviewed
          ? [...new Set([...reviewed, ...action.paths])]
          : reviewed.filter((path) => !action.paths.includes(path)),
      };
    });
    if (action.scope === reviewScope) {
      const restored = action.paths.find(
        (path) => path === MESSAGE_PATH || paths.includes(path),
      );
      if (restored) select(restored);
    }
  }

  function moveFile(offset: number) {
    const reviewItems = treeOrder.current.flat();
    if (!reviewItems.length) return;
    const current = reviewItems.indexOf(selected);
    const next = current < 0
      ? (offset > 0 ? 0 : reviewItems.length - 1)
      : (current + offset + reviewItems.length) % reviewItems.length;
    select(reviewItems[next]);
  }

  function selectLineTarget() {
    const match = lineTarget.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) {
      setLineError("Enter a line number or range, such as 12 or 12-15.");
      return;
    }
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    const side = singleSide || lineSide;
    const source = side === "deletions" ? content?.oldFile : content?.newFile;
    const lineCount = source?.contents ? source.contents.split("\n").length : 0;
    if (first < 1 || last < 1 || first > lineCount || last > lineCount) {
      setLineError(`Choose a line between 1 and ${lineCount}.`);
      return;
    }
    const nextRange: SelectedLineRange = {
      start: Math.min(first, last),
      end: Math.max(first, last),
      ...(tab === "changes" && !messageView ? { side } : {}),
    };
    setShowLinePicker(false);
    setShowComments(true);
    setLineError("");
    onSelection(nextRange);
    requestAnimationFrame(() => viewer.current?.scrollTo({
      type: "range",
      id: selected,
      range: diffView ? nextRange : { start: nextRange.start, end: nextRange.end },
      align: "center",
    }));
  }

  function runCommand(command: Command) {
    if (command === "palette") setShowShortcuts(true);
    else if (command === "find-viewed-file") openTextSearch();
    else if (command === "next-text-match") findTextMatch(1);
    else if (command === "previous-text-match") findTextMatch(-1);
    else if (command === "find-file") setShowFinder(true);
    else if (command === "search-files") {
      setShowFiles(true);
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>('[aria-label="Find a file"]')?.focus(),
      );
    } else if (command === "next-file") moveFile(1);
    else if (command === "previous-file") moveFile(-1);
    else if (command === "review-palette") setReviewPickerRequest((value) => value + 1);
    else if (command === "file-browser") {
      viewerFocusRequest.current = interactionVersion.current;
      changeTab("files");
    } else if (command === "uncommitted") {
      changeTab("changes", false);
      void compare("working");
    } else if (command === "recent-commit") {
      if (latestCommitPending.current) return;
      latestCommitPending.current = true;
      const refresh = ++viewRefresh.current;
      setContentRevision(refresh);
      void refreshInfo()
        .then(async (nextInfo) => {
          if (refresh !== viewRefresh.current) return;
          const latest = nextInfo.commits[0]?.id;
          if (!latest) return;
          setTo(latest);
          changeTab("changes", false);
          await compare("commit", { to: latest, info: nextInfo, refresh });
        })
        .catch((error) => setError((error as Error).message))
        .finally(() => {
          latestCommitPending.current = false;
        });
    } else if (command === "comment" && content && !notice && (diffView || fileSource)) {
      setLineTarget(range ? `${start}${end !== start ? `-${end}` : ""}` : "");
      setLineSide(singleSide || (range?.side === "deletions" ? "deletions" : "additions"));
      setLineError("");
      setShowLinePicker(true);
    } else if (command === "toggle-reviewed") toggleReviewed();
    else if (command === "undo") undo();
    else if (command === "save-comment") saveComment();
    else if (command === "copy-prompt" && comments.length) void copyPrompt();
    else if (command === "preview-prompt" && comments.length) setShowPrompt(true);
    else if (command === "toggle-diff" && diffView) setSplit((value) => !value);
    else if (command === "toggle-wrap") setWrap((value) => !value);
    else if (command === "toggle-files") setShowFiles((value) => !value);
    else if (command === "toggle-comments") setShowComments((value) => !value);
    else if (command === "expand-diff" && fileDiff) setExpanded(true);
    else if (command === "collapse-diff" && fileDiff) setExpanded(false);
    else if (command === "refresh") location.reload();
    else if (command === "cancel") {
      setEditing(undefined);
      setRange(null);
      setDraft("");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches("input, textarea, select, [contenteditable=true]");
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === "f" || key === "g")) {
        event.preventDefault();
        if (key === "f") openTextSearch();
        else findTextMatch(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "k") {
        event.preventDefault();
        setShowShortcuts(true);
        return;
      }

      if (event.key === "Escape") {
        if (showTextSearch) {
          event.preventDefault();
          setShowTextSearch(false);
          focusViewer();
        } else if (showShortcuts || showFinder || showLinePicker || showPrompt || showCopiedPrompt) {
          event.preventDefault();
          setShowShortcuts(false);
          setShowFinder(false);
          setShowLinePicker(false);
          setShowPrompt(false);
          setShowCopiedPrompt(false);
        } else if (editing || range) {
          event.preventDefault();
          setEditing(undefined);
          setRange(null);
          setDraft("");
        }
        return;
      }
      if (
        typing || event.metaKey || event.ctrlKey || event.altKey ||
        showShortcuts || showFinder || showLinePicker || showPrompt || showCopiedPrompt
      )
        return;

      const sequence = keySequence.current;
      keySequence.current = "";
      window.clearTimeout(keySequenceTimer.current);
      if (!sequence && key === "g") {
        event.preventDefault();
        keySequence.current = "g";
        keySequenceTimer.current = window.setTimeout(() => {
          keySequence.current = "";
        }, 1000);
        return;
      }
      const bind = sequence + key;
      const shortcut =
        (event.shiftKey && shortcuts.find((item) => item.bind === bind.toUpperCase())) ||
        shortcuts.find((item) => item.bind === bind);
      if (!shortcut) return;
      event.preventDefault();
      runCommand(shortcut.command);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(keySequenceTimer.current);
    };
  });

  return (
    <div className="app">
      <header className="topbar">
        <span
          className="repo-name"
          title={info.root}
          style={{ "--repo-hue": nameHue(info.name) } as CSSProperties}
        >
          {info.name}
        </span>
        {info.branch && <span className="branch">⑂ {info.branch}</span>}
        <ReviewPalette
          tab={tab}
          comparison={comparison}
          mode={mode}
          from={from}
          to={to}
          commits={info.commits}
          isGit={info.isGit}
          comparing={comparing}
          onFiles={() => changeTab("files")}
          onWorking={() => {
            changeTab("changes", false);
            void compare("working");
          }}
          onCommit={(value) => {
            setTo(value);
            changeTab("changes", false);
            void compare("commit", { to: value });
          }}
          onRangeDraft={(nextFrom, nextTo) => {
            setMode("range");
            setFrom(nextFrom);
            setTo(nextTo);
          }}
          onRange={() => {
            changeTab("changes", false);
            void compare("range");
          }}
          openRequest={reviewPickerRequest}
        />
        <button
          className="refresh"
          onClick={() => location.reload()}
          title="Reload files and commits; keep your view and saved comments"
        >
          ↻ <span>Refresh</span>
        </button>
        <div className="top-actions">
          <button
            className="finder-trigger"
            title="Find a file (F)"
            onClick={() => setShowFinder(true)}
          >
            <span aria-hidden="true">⌕</span>
            Find file
            <kbd>F</kbd>
          </button>
          <button
            className="shortcut-trigger"
            aria-label="Command launcher"
            title="Command launcher (? or Cmd+K)"
            onClick={() => setShowShortcuts(true)}
          >
            ?
          </button>
          <button className="clear" onClick={clearReview}>
            Clear
          </button>
          <button
            className="primary copy"
            disabled={!comments.length || submitting}
            onClick={sendPrompt}
          >
            {info.agent && submitted && !submitting ? "✓ Submitted" : sendLabel}
            <span className="count">{comments.length}</span>
          </button>
        </div>
      </header>
      <div
        className={`workspace${showFiles ? "" : " hide-files"}${showComments ? "" : " hide-comments"}`}
        style={
          {
            "--files-size": filesWidth ? `${filesWidth}px` : undefined,
            "--comments-size": commentsWidth ? `${commentsWidth}px` : undefined,
          } as CSSProperties
        }
      >
        <div className="panel-rail files" hidden={showFiles}>
          <button
            className="panel-toggle"
            aria-label="Show file browser"
            title="Show file browser"
            aria-controls="file-browser"
            onClick={() => setShowFiles(true)}
          >
            ›
          </button>
        </div>
        <aside
          className="sidebar"
          id="file-browser"
          aria-label="File browser"
          hidden={!showFiles}
        >
          <PanelResizeHandle side="files" onResize={setFilesWidth} />
          <div className="sidebar-header">
            <strong>{tab === "files" ? "Repository files" : "Changed files"}</strong>
            <span className="file-count">
              {paths.length + (hasMessage ? 1 : 0)}
            </span>
            <LineStats {...groupStats(unreviewedPaths)} />
            <button
              className="panel-toggle"
              aria-label="Hide file browser"
              title="Hide file browser"
              aria-controls="file-browser"
              onClick={() => setShowFiles(false)}
            >
              ‹
            </button>
          </div>
          <div className="tree-toolbar">
            <div className="search">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Find a file"
                placeholder="Find a file…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <button
              className="tree-action"
              aria-label="Collapse all directories"
              title="Collapse all directories"
              onClick={() => setCollapsed(directoryPaths(paths))}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
                <path d="M2 3.5h3l1 1h6v6.5H2z" />
                <path d="M4.5 7.75h5" />
              </svg>
            </button>
            <button
              className="tree-action"
              aria-label="Expand all directories"
              title="Expand all directories"
              onClick={() => setCollapsed([])}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
                <path d="M2 3.5h3l1 1h6v6.5H2z" />
                <path d="M4.5 7.75h5 M7 5.25v5" />
              </svg>
            </button>
          </div>
          {[false, true].map((done) => {
            if (done && !reviewedCount) return null;
            const groupPaths = done ? reviewedPaths : unreviewedPaths;
            const includeMessage = hasMessage && messageReviewed === done &&
              "commit message".includes(search.toLowerCase());
            return (
              <section
                key={String(done)}
                className={`file-section${groupPaths.length || includeMessage ? "" : " no-files"}`}
                aria-label={done ? "Reviewed" : "Unreviewed"}
              >
                {done && <div className="sidebar-caption">
                  <span className="section-label">
                    Reviewed
                    <span className="file-count">
                      {reviewedCount}
                    </span>
                  </span>
                  <LineStats {...groupStats(groupPaths)} />
                </div>}
                {(!!groupPaths.length || includeMessage) && (
                  <BrowserTree
                    key={`${reviewScope}:${includeMessage}:${JSON.stringify(groupPaths)}`}
                    paths={groupPaths}
                    entries={entries}
                    selected={groupPaths.includes(selected) ||
                      includeMessage && selected === MESSAGE_PATH ? selected : ""}
                    includeMessage={includeMessage}
                    onSelect={select}
                    onOrderChange={done
                      ? setReviewedTreeOrder
                      : setUnreviewedTreeOrder}
                    fileHref={fileHref}
                    scrollRoot={info.root}
                    scrollKey={JSON.stringify(["explorer", reviewScope, done])}
                    reviewed={done}
                    onToggleReviewed={togglePathReviewed}
                    onToggleDirectoryReviewed={toggleDirectoryReviewed}
                    search={search}
                    collapsed={collapsed}
                    onCollapse={(path, closed) =>
                      setCollapsed((current) =>
                        closed
                          ? [...new Set([...current, path])]
                          : current.filter((item) => item !== path),
                      )
                    }
                  />
                )}
                {!done &&
                  !groupPaths.length &&
                  !includeMessage && (
                    <p className="sidebar-empty">
                      {reviewedCount
                        ? "All reviewed."
                        : tab === "files"
                          ? "No files yet."
                          : "No changed files."}
                    </p>
                  )}
              </section>
            );
          })}
        </aside>
        <main className="main">
          {showTextSearch && (
            <div className="text-search" role="search">
              <input
                ref={textSearchInput}
                aria-label="Find in viewed file"
                placeholder="Find"
                value={textSearch}
                onChange={(event) => setTextSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    moveTextMatch(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span aria-live="polite">
                {textSearch
                  ? `${textMatches.length ? activeTextMatch + 1 : 0}/${textMatches.length}`
                  : "0/0"}
              </span>
              <button
                aria-label="Previous match"
                disabled={!textMatches.length}
                onClick={() => moveTextMatch(-1)}
              >
                ↑
              </button>
              <button
                aria-label="Next match"
                disabled={!textMatches.length}
                onClick={() => moveTextMatch(1)}
              >
                ↓
              </button>
              <button
                aria-label="Close find"
                onClick={() => {
                  setShowTextSearch(false);
                  focusViewer();
                }}
              >
                ×
              </button>
            </div>
          )}
          <div className="file-heading">
            <a
              className="file-path"
              href={messageView || paths.includes(selected) ? href() : undefined}
              onClick={onPlainClick()}
            >
              {messageView
                ? `Commit message · ${comparison.target.slice(0, 7)}`
                : selected && paths.includes(selected)
                  ? selected
                  : "No file selected"}
            </a>
            {!messageView && selected && paths.includes(selected) && (
              <button
                className="tree-action copy-path"
                aria-label={copiedPath === selected ? "Copied file path" : "Copy file path"}
                title={copiedPath === selected ? "Copied" : "Copy file path"}
                onClick={async () => {
                  try {
                    await copyText(selected);
                  } catch {
                    return;
                  }
                  setCopiedPath(selected);
                  setTimeout(
                    () => setCopiedPath((path) => (path === selected ? undefined : path)),
                    1500,
                  );
                }}
              >
                {copiedPath === selected ? (
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
                    <path d="M3 7.5l2.5 2.5L11 4.5" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
                    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
                    <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" />
                  </svg>
                )}
              </button>
            )}
            {diffView &&
              selectedEntry?.additions != null &&
              selectedEntry.deletions != null && (
                <LineStats
                  className="file-diff-stats line-stats"
                  additions={selectedEntry.additions}
                  deletions={selectedEntry.deletions}
                  title="Lines changed"
                />
              )}
            <div className="view-controls">
              {tab === "changes" && !messageView && (
                <div className="viewer-modes" role="group" aria-label="File view">
                  {(["diff", "old", "new"] as const).map((value) => (
                    <a
                      key={value}
                      href={href({ viewerMode: value })}
                      aria-label={`View ${value}`}
                      aria-current={viewerMode === value ? "true" : undefined}
                      onClick={onPlainClick(() => changeViewerMode(value))}
                    >
                      {value === "diff" ? "Diff" : value === "old" ? "Old" : "New"}
                    </a>
                  ))}
                </div>
              )}
              {diffView && (
                <div className="segmented" role="group" aria-label="Diff layout">
                  {[false, true].map((value) => (
                    <a
                      key={String(value)}
                      href={href({ split: value })}
                      aria-current={split === value ? "true" : undefined}
                      onClick={onPlainClick(() => setSplit(value))}
                    >
                      {value ? "Split" : "Unified"}
                    </a>
                  ))}
                </div>
              )}
              {fileDiff && (
                <a
                  className="expand-all"
                  href={href({ expanded: !expanded })}
                  aria-current={expanded ? "true" : undefined}
                  title={
                    expanded
                      ? "Collapse unchanged lines (C)"
                      : "Expand all hidden lines (E)"
                  }
                  onClick={onPlainClick(() => setExpanded((value) => !value))}
                >
                  {expanded ? "Collapse all" : "Expand all"}
                </a>
              )}
              <button
                className="wrap-toggle"
                aria-label="Wrap long lines"
                aria-pressed={wrap}
                title="Wrap long lines (W)"
                onClick={() => setWrap((value) => !value)}
              >
                Wrap
              </button>
            </div>
            {(messageView || paths.includes(selected)) && (
              <button
                className={`review-toggle${selectedReviewed ? " reviewed" : ""}`}
                aria-label={
                  selectedReviewed ? "Mark unreviewed" : "Mark reviewed"
                }
                aria-pressed={selectedReviewed}
                disabled={loading || comparing}
                title={
                  selectedReviewed
                    ? "Move back to unreviewed"
                    : "Move to Reviewed"
                }
                onClick={toggleReviewed}
              >
                {selectedReviewed ? "✓ Reviewed" : "Mark reviewed"}
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <div
            className="code-pane"
            key={`${tab}:${selected}:${comparison.base}:${comparison.target}:${viewerMode}`}
          >
            {loading || comparing || restoring ? (
              <div className="empty">
                <p>Loading…</p>
              </div>
            ) : !info.isGit && tab === "changes" ? (
              <div className="empty">
                <h2>Not a Git repository</h2>
                <p>You can still browse files and leave comments.</p>
              </div>
            ) : tab === "changes" && !paths.length && !messageView ? (
              <div className="empty">
                <span className="empty-symbol">✓</span>
                <h2>No changes to review</h2>
                <p>
                  {compareLabel === "Uncommitted changes"
                    ? "You have no uncommitted changes."
                    : "These revisions have no file differences."}
                  <br />
                  New changes appear when you refresh.
                </p>
              </div>
            ) : !messageView && (!selected || !paths.includes(selected)) ? (
              <div className="empty">
                <span className="empty-symbol">⌘</span>
                <h2>A little space for a better review.</h2>
                <p>
                  Choose a file on the left.
                  <br />
                  Select a line number to leave a comment.
                </p>
                <div className="empty-steps">
                  <span>01 &nbsp; Read</span>
                  <span>02 &nbsp; Comment</span>
                  <span>03 &nbsp; Copy</span>
                </div>
              </div>
            ) : notice ? (
              <div className="empty">
                <h2>Preview unavailable</h2>
                <p>{notice}</p>
              </div>
            ) : content && singleSide && !fileSource ? (
              <div className="empty">
                <h2>File does not exist in the {viewerMode} revision</h2>
                <p>{viewerMode === "old" ? "This file was added." : "This file was deleted."}</p>
              </div>
            ) : content && (content.newFile || content.oldFile) ? (
              <>
                <CodeView
                  ref={viewer}
                  containerRef={(element) => {
                    viewerContainer.current = element;
                    if (element) element.tabIndex = 0;
                  }}
                  className="code-view"
                  items={items}
                  options={options}
                  selectedLines={
                    viewerRange
                      ? { id: selected, range: viewerRange }
                      : null
                  }
                  onSelectedLinesChange={(selection) =>
                    onSelection(selection?.range || null)
                  }
                  renderAnnotation={({ metadata: comment }) => (
                    <button
                      className="comment-marker"
                      aria-label={`Open comment on ${reference(comment)}`}
                      onClick={() => {
                        setShowComments(true);
                        setHighlight(comment);
                        requestAnimationFrame(() => {
                          const card = document.getElementById(
                            `comment-${comment.id}`,
                          );
                          card?.scrollIntoView({ block: "nearest" });
                          card?.focus({ preventScroll: true });
                        });
                      }}
                    >
                      ▤ &nbsp; {reference(comment)} · {comment.text}
                    </button>
                  )}
                />
                {!(diffView ? content.newFile?.contents || content.oldFile?.contents : fileSource?.contents) && (
                  <p className="empty">Empty file</p>
                )}
              </>
            ) : (
              content && (
                <div className="empty">
                  <p>File no longer exists. Refresh to update the file list.</p>
                </div>
              )
            )}
          </div>
          <div className="code-footer">
            <span>
              {tab === "changes"
                ? compareLabel
                : "Click a line number to comment · Shift-click for a range"}
            </span>
            {range && (
              <span>
                Ln {start}
                {end !== start ? `–${end}` : ""}
                {range.side === "deletions" ? " · old side" : ""}
              </span>
            )}
          </div>
        </main>
        <aside
          className="comments-panel"
          id="review-comments"
          aria-label="Review comments"
          hidden={!showComments}
        >
          <PanelResizeHandle side="comments" onResize={setCommentsWidth} />
          <div className="panel-heading">
            <h2>
              Review comments <span>{comments.length}</span>
            </h2>
            <button
              className="panel-toggle"
              aria-label="Hide comments"
              title="Hide comments (M)"
              aria-controls="review-comments"
              onClick={() => setShowComments(false)}
            >
              ›
            </button>
          </div>
          <div className="comment-actions">
            <button
              className="text-button"
              disabled={!comments.length}
              onClick={() => setShowPrompt(true)}
            >
              Preview
            </button>
          </div>
          <form
            className="general-composer"
            onSubmit={(event) => {
              event.preventDefault();
              saveGeneralComment();
            }}
          >
            <label htmlFor="general-comment-text">General comment</label>
            <textarea
              id="general-comment-text"
              placeholder="Add feedback not tied to a file…"
              value={generalDraft}
              onChange={(event) => setGeneralDraft(event.target.value)}
              onKeyDown={onCmdEnter(saveGeneralComment)}
            />
            <div className="composer-actions">
              <button className="primary" disabled={!generalDraft.trim()}>
                Add general comment
              </button>
            </div>
          </form>
          <div className="comments-body">
            {[copyError, submitError, storageError].filter(Boolean).map((message) => (
              <p role="alert" className="error" key={message}>{message}</p>
            ))}
            {!comments.length && !range && (
              <div className="comment-empty">
                <span className="comment-icon">▤</span>
                <h3>Your thoughts, ready for an agent.</h3>
                <p>
                  Select a line in the code to add a comment. Collect your
                  feedback here, then {info.agent ? "submit" : "copy"} it as one prompt.
                </p>
              </div>
            )}
            {comments.map((comment, index) => (
              <article
                className={`comment${comment.general ? " general" : ""}${highlight?.id === comment.id ? " highlighted" : ""}`}
                key={comment.id}
                id={`comment-${comment.id}`}
                tabIndex={comment.general ? undefined : 0}
                aria-label={comment.general ? "General comment" : `Comment on ${reference(comment)}`}
                onMouseEnter={() => !comment.general && setHighlight(comment)}
                onMouseLeave={() => !comment.general && setHighlight(null)}
                onFocus={() => !comment.general && setHighlight(comment)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setHighlight(null);
                }}
                onClick={comment.general ? undefined : (event) => {
                  if (!(event.target as HTMLElement).closest("button, textarea"))
                    void openComment(comment);
                }}
                onKeyDown={comment.general ? undefined : (event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    void openComment(comment);
                  }
                }}
              >
                <div className="comment-top">
                  <span className="comment-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <code>{reference(comment)}</code>
                </div>
                {editing === comment.id ? (
                  <div className="inline-edit">
                    <textarea
                      aria-label="Edit comment"
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={onCmdEnter(saveComment)}
                    />
                    <button
                      onClick={() => {
                        setEditing(undefined);
                        setDraft("");
                      }}
                    >
                      Cancel edit
                    </button>
                    <button
                      className="primary"
                      disabled={!draft.trim()}
                      onClick={saveComment}
                    >
                      Save comment
                    </button>
                  </div>
                ) : (
                  <p>{comment.text}</p>
                )}
                <div className="comment-bottom">
                  <span>
                    {comment.context}
                    {comment.side === "deletions" ? " · old side" : ""}
                  </span>
                  <button
                    onClick={() => {
                      setEditing(comment.id);
                      setRange(null);
                      setDraft(comment.text);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    aria-label={`Delete comment ${index + 1}`}
                    onClick={() => {
                      setComments((items) =>
                        items.filter((item) => item.id !== comment.id),
                      );
                      if (editing === comment.id) {
                        setEditing(undefined);
                        setDraft("");
                        setRange(null);
                      }
                      setCopied(false);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
            {!editing && range && selected && (
              <form
                className="composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveComment();
                }}
              >
                <label htmlFor="comment-text">New comment</label>
                <code>
                  {reference({
                    path: selected,
                    start,
                    end,
                    commit: messageView ? comparison.target : undefined,
                  })}
                </code>
                {range.side === "deletions" && (
                  <small>Old side · line numbers before the change</small>
                )}
                <textarea
                  id="comment-text"
                  autoFocus
                  placeholder="What should the agent change?"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onCmdEnter(saveComment)}
                />
                <div className="composer-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setRange(null);
                      setDraft("");
                    }}
                  >
                    Cancel
                  </button>
                  <button className="primary" disabled={!draft.trim()}>
                    Add comment
                  </button>
                </div>
              </form>
            )}
          </div>
        </aside>
        <div className="panel-rail comments" hidden={showComments}>
          <button
            className="panel-toggle"
            aria-label="Show comments"
            title="Show comments (M)"
            aria-controls="review-comments"
            onClick={() => setShowComments(true)}
          >
            ‹
          </button>
        </div>
      </div>
      <footer className="statusbar">
        <span>⑂ {info.branch || "Files"}</span>
        <span>{info.isGit ? "Git" : "Folder"} · read-only</span>
        <span className="status-right">
          No auto-refresh
          <span className="status-dot" />
          Refresh when you’re ready.
          <span className="status-dot" />
          rv {__RV_VERSION__}
        </span>
      </footer>
      {showPrompt && (
        <Modal className="prompt-dialog" aria-label="Prompt preview" onClose={() => setShowPrompt(false)}>
          <div className="panel-heading">
            <h2>Prompt preview</h2>
            <button
              autoFocus
              onClick={() => setShowPrompt(false)}
              aria-label="Close preview"
            >
              ✕
            </button>
          </div>
          <textarea
            aria-label="Prompt text"
            readOnly
            value={prompt}
            onFocus={(event) => event.target.select()}
          />
          <div className="dialog-footer">
            <span>
              Exactly what gets {info.agent ? "submitted" : "copied"}.
            </span>
            <div className="dialog-actions">
              {info.agent && (
                <button onClick={copyPrompt}>
                  {copyLabel}
                </button>
              )}
              <button
                className="primary"
                disabled={submitting}
                onClick={sendPrompt}
              >
                {sendLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showCopiedPrompt && (
        <Modal
          className="prompt-dialog copied-prompt-dialog"
          aria-labelledby="copied-prompt-title"
          onClose={() => setShowCopiedPrompt(false)}
          onSubmit={clearCopiedReview}
        >
          <div className="panel-heading copied-prompt-heading">
            <div>
              <span className="copied-prompt-check" aria-hidden="true">✓</span>
              <div>
                <h2 id="copied-prompt-title">Prompt copied to clipboard</h2>
                <p>You can clear this review or keep the comments for later.</p>
              </div>
            </div>
          </div>
          <textarea
            aria-label="Copied prompt"
            readOnly
            value={prompt}
            onFocus={(event) => event.target.select()}
          />
          <div className="dialog-footer">
            <span>Clear also resets review progress.</span>
            <div className="dialog-actions">
              <button type="button" onClick={() => setShowCopiedPrompt(false)}>
                Keep Comments
              </button>
              <button className="primary" type="submit" autoFocus>
                Clear
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showFinder && (
        <FileFinder
          paths={hasMessage ? [MESSAGE_PATH, ...paths] : paths}
          reviewed={reviewedInView || []}
          onSelect={select}
          fileHref={fileHref}
          onClose={() => setShowFinder(false)}
        />
      )}
      {showShortcuts && (
        <CommandLauncher
          onClose={() => setShowShortcuts(false)}
          onChoose={(command) => {
            setShowShortcuts(false);
            runCommand(command);
          }}
        />
      )}
      {showLinePicker && (
        <Modal
          className="line-dialog"
          aria-labelledby="line-dialog-title"
          onClose={() => setShowLinePicker(false)}
          onSubmit={selectLineTarget}
        >
          <div className="panel-heading">
            <h2 id="line-dialog-title">Comment on a line</h2>
            <button type="button" onClick={() => setShowLinePicker(false)} aria-label="Close line picker">✕</button>
          </div>
          <div className="line-dialog-body">
            <label htmlFor="line-target">Line or range</label>
            <input
              id="line-target"
              autoFocus
              inputMode="numeric"
              placeholder="12 or 12-15"
              value={lineTarget}
              onChange={(event) => {
                setLineTarget(event.target.value);
                setLineError("");
              }}
            />
            {diffView && (
              <label className="line-side">
                Side
                <select value={lineSide} onChange={(event) => setLineSide(event.target.value as "additions" | "deletions")}>
                  <option value="additions">New side</option>
                  <option value="deletions">Old side</option>
                </select>
              </label>
            )}
            {lineError && <p role="alert" className="line-error">{lineError}</p>}
          </div>
          <div className="dialog-footer">
            <span>{selected}</span>
            <button className="primary" disabled={!lineTarget.trim()}>Start comment</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
