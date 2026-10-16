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
import { FileFinder } from "../components/FileFinder";
import { ReviewPalette } from "../components/ReviewPalette";
import { CommandLauncher } from "../components/CommandLauncher";
import { api, loadFile } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { nameHue } from "../lib/format";
import { isTyping } from "../lib/events";
import { readLocation, readPreferences, viewHref, type ViewLocation } from "../lib/location";
import { rememberPosition, scrollStore } from "../lib/scroll";
import { compareTreePaths } from "../lib/sort";
import type { Command } from "../lib/shortcuts";
import { formatPrompt, reference } from "../prompt.js";
import { TextSearchBar, useTextSearch, type TextSearchSource } from "./TextSearch";
import { Sidebar } from "./Sidebar";
import { CommentsPanel } from "./CommentsPanel";
import { DiffFileHeader, FileHeading } from "./FileHeading";
import { CopiedPromptDialog, LinePicker, PromptDialog } from "./Dialogs";
import { useKeyboard } from "./useKeyboard";
import { useViewerScroll } from "./useViewerScroll";
import { useSavedState } from "./useSavedState";
import {
  MESSAGE_PATH,
  type Comment,
  type Comparison,
  type Content,
  type Info,
  type SavedState,
  type ViewerMode,
} from "../types";

declare const __RV_VERSION__: string;
// Matches .diff-file-heading; CodeView reserves this much for each header.
const HEADER_HEIGHT = 44;
const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];

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
  const [reviewed, setReviewed] = useState(state.reviewed || {});
  const [search, setSearch] = useState(saved.search);
  const [comments, setComments] = useState(state.comments || []);
  const [tab, setTab] = useState(saved.tab);
  const [mode, setMode] = useState(saved.mode);
  const [from, setFrom] = useState(saved.from);
  const [to, setTo] = useState(saved.to);
  const [comparison, setComparison] = useState<Comparison>(info.working);
  const compareLabel = comparison.mode === "working"
    ? "Uncommitted changes"
    : comparison.mode === "commit"
      ? `Commit ${comparison.target.slice(0, 7)}`
      : `${comparison.base.slice(0, 7)} → ${comparison.target.slice(0, 7)}`;
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(saved.selected);
  const [viewerMode, setViewerMode] = useState(saved.viewerMode);
  // Diffs show every changed file in one scroll; "selected" follows the file
  // at the top. Old/New and the File Browser show one file at a time.
  const diffAll = tab === "changes" && viewerMode === "diff";
  const contentKey = JSON.stringify([
    tab, selected, ...(tab === "changes" ? [comparison.base, comparison.target] : []),
  ]);
  const [loaded, setLoaded] = useState<{ key: string; content: Content }>();
  const [contentRevision, setContentRevision] = useState(0);
  const allKey = JSON.stringify([comparison.base, comparison.target, contentRevision]);
  const [allLoaded, setAllLoaded] =
    useState<{ key: string; contents: Record<string, Content> }>();
  const allContents = allLoaded?.key === allKey ? allLoaded.contents : undefined;
  const parsedDiffs = useRef(new Map<string, FileDiffMetadata>());
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(saved.split);
  const [wrap, setWrap] = useState(saved.wrap);
  const [expanded, setExpanded] = useState(saved.expanded);
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  // The file the line range belongs to; in the all-files diff it may differ
  // from the selected file.
  const [rangePath, setRangePath] = useState("");
  const [draft, setDraft] = useState("");
  const [generalDraft, setGeneralDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [dialog, setDialog] =
    useState<"commands" | "finder" | "line" | "prompt" | "copied" | null>(null);
  const closeDialog = () => setDialog(null);
  const [reviewPickerRequest, setReviewPickerRequest] = useState(0);
  const [showFiles, setShowFiles] = useState(saved.showFiles);
  const [showComments, setShowComments] = useState(saved.showComments);
  const [filesWidth, setFilesWidth] = useState(saved.filesWidth);
  const [commentsWidth, setCommentsWidth] = useState(saved.commentsWidth);
  const [collapsed, setCollapsed] = useState(saved.collapsed);
  const [highlight, setHighlight] = useState<Comment | null>(null);
  const [pendingComment, setPendingComment] = useState<Comment | null>(null);
  const cancelComment = () => {
    setEditing(undefined);
    setRange(null);
    setDraft("");
  };
  const clearSelection = () => {
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
  };
  const viewer = useRef<CodeViewHandle<Comment, undefined>>(null);
  const viewerContainer = useRef<HTMLDivElement>(null);
  const interactionVersion = useRef(0);
  const viewerFocusRequest = useRef<number | null>(null);
  const viewerScrollKey = JSON.stringify(["viewer", contentKey, viewerMode]);
  const comparisonRequest = useRef(0);
  const viewRefresh = useRef(0);
  const latestCommitPending = useRef(false);
  const reviewHistory = useRef<{
    scope: string;
    paths: string[];
    reviewed: boolean;
  }[]>([]);
  const treeOrder = useRef<[string[], string[]]>([[], []]);
  useEffect(() => {
    const trackInteraction = () => interactionVersion.current++;
    const trackTypingFocus = (event: FocusEvent) => {
      if (isTyping(event.target)) trackInteraction();
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
  const replaceURL = useRef(false);
  useEffect(() => {
    if (restoring || comparing || error) return;
    const next = href();
    // Scrolling through the all-files diff updates the URL without history.
    if (initialURL.current || replaceURL.current) {
      history.replaceState(null, "", next);
      initialURL.current = false;
      replaceURL.current = false;
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

  const storageError = useSavedState(state, {
    view: { search, wrap, showFiles, showComments, filesWidth, commentsWidth, collapsed },
    // Mutable views are only reviewed for this page snapshot.
    reviewed: Object.fromEntries(
      Object.entries(reviewed).filter(([scope]) => scope !== "files" && scope !== "working"),
    ),
    comments,
  });
  const paths = useMemo(
    () =>
      tab === "files"
        ? info.files
        : comparison.entries.map((entry) => entry.path),
    [tab, info.files, comparison],
  );
  const entries = tab === "files" ? info.working.entries : comparison.entries;
  const isMessage = (path: string) =>
    tab === "changes" && path === MESSAGE_PATH && comparison.mode === "commit";
  // The commit message shown on its own; the all-files diff includes it.
  const messageView = !diffAll && isMessage(selected);
  const messageKey = JSON.stringify([tab, MESSAGE_PATH, comparison.base, comparison.target]);
  const messageContent = useMemo<Content | undefined>(
    () => comparison.message === undefined
      ? undefined
      : {
          oldFile: null,
          newFile: {
            name: "COMMIT_MESSAGE.txt",
            contents: comparison.message,
            cacheKey: messageKey,
          },
        },
    [comparison.message, messageKey],
  );
  const content = diffAll
    ? isMessage(selected) ? messageContent : allContents?.[selected]
    // Never mount the previous file under the new selection while its effect loads.
    : loaded?.key === contentKey ? loaded.content : undefined;
  const reviewScope =
    tab === "files"
      ? "files"
      : comparison.mode === "working"
        ? "working"
        : JSON.stringify([comparison.mode, comparison.base, comparison.target]);
  const reviewedInView = reviewed[reviewScope];
  const hasMessage = tab === "changes" && comparison.mode === "commit";
  const selectedReviewed = reviewedInView?.includes(selected) || false;
  const focusViewer = useCallback(() => {
    viewerContainer.current?.focus({ preventScroll: true });
  }, []);
  const select = useCallback(
    (path: string) => {
      if (diffAll) {
        setScrollRequest({ path });
        if (path === selected) {
          focusViewer();
          return;
        }
        viewerFocusRequest.current = interactionVersion.current;
        setSelected(path);
        clearSelection();
        return;
      }
      if (path === selected) {
        focusViewer();
        return;
      }
      viewerFocusRequest.current = interactionVersion.current;
      setSelected(path);
      clearSelection();
    },
    [selected, focusViewer, diffAll],
  );

  useEffect(() => {
    if (restoring || diffAll) return;
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
  }, [selected, paths, tab, comparison, messageView, messageContent, restoring, contentKey, contentRevision, diffAll]);

  useEffect(() => {
    if (restoring || !diffAll || comparing || allContents) return;
    let active = true;
    // Keeps a comparison error; comparing clears errors when it starts.
    setLoading(true);
    Promise.all(paths.map((path) => Promise.all([
      loadFile(path, comparison.base, contentRevision),
      loadFile(path, comparison.target, contentRevision),
    ]).then(([oldFile, newFile]) => [path, { oldFile, newFile }] as const)))
      .then((contents) => {
        if (!active) return;
        setAllLoaded({ key: allKey, contents: Object.fromEntries(contents) });
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [paths, comparison, restoring, comparing, allKey, allContents, contentRevision, diffAll]);

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

  const singleSide = tab === "changes" && !messageView && viewerMode !== "diff"
    ? viewerMode === "old" ? "deletions" : "additions"
    : undefined;
  const fileSource = diffAll ? undefined
    : singleSide === "deletions" ? content?.oldFile : content?.newFile;

  function changeViewerMode(value: ViewerMode) {
    setViewerMode(value);
    clearSelection();
    closeDialog();
  }

  const onSelection = useCallback((value: SelectedLineRange | null, path?: string) => {
    setHighlight(null);
    if (value) setShowComments(true);
    if (value && path) setRangePath(path);
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
      onLineSelected: (value: SelectedLineRange | null, context: { item: { id: string } }) =>
        onSelection(value, context.item.id),
      itemMetrics: { lineHeight: 23, diffHeaderHeight: HEADER_HEIGHT },
      pointerEventsOnScroll: true,
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      expandUnchanged: expanded,
      disableFileHeader: !diffAll,
      stickyHeaders: true,
      ...(diffAll ? { layout: { paddingTop: 0, paddingBottom: 0, gap: 0 } } : {}),
    }),
    [split, wrap, expanded, onSelection, diffAll],
  );
  const prompt = formatPrompt(comments);
  const notice = diffAll
    ? content?.newFile?.notice || content?.oldFile?.notice
    : fileSource?.notice;
  const start = range ? Math.min(range.start, range.end) : 1;
  const end = range ? Math.max(range.start, range.end) : 1;

  function matchesScope(comment: Comment) {
    return (
      !comment.general &&
      (tab === "files"
        ? !comment.comparison
        : comment.comparison?.base === comparison.base &&
          comment.comparison.target === comparison.target)
    );
  }
  function matchesView(comment: Comment) {
    return (diffAll || comment.path === selected) && matchesScope(comment) &&
      (!singleSide || (comment.side || "additions") === singleSide);
  }
  function commentRange(comment: Comment): SelectedLineRange {
    return {
      start: comment.start,
      end: comment.end,
      ...(diffAll && !isMessage(comment.path) ? { side: comment.side || "additions" } : {}),
    };
  }
  function parseDiff(key: string, { oldFile, newFile }: Content) {
    let diff = parsedDiffs.current.get(key);
    if (!diff) {
      diff = parseDiffFromFile(oldFile, newFile);
      // Include the comparison even for additions/deletions with a missing side.
      diff.cacheKey = key;
      parsedDiffs.current.set(key, diff);
    }
    return diff;
  }
  const diffKey = (path: string) => JSON.stringify([allKey, path]);
  const annotationsFor = (path: string) => comments
    .filter((comment) => comment.path === path && matchesView(comment))
    .map((comment) => ({
      lineNumber: comment.end,
      side: comment.side || "additions",
      metadata: comment,
    }));
  // CodeView needs a new version when the same item gets new text or annotations.
  const itemVersion = useRef(0);
  const previousComments = useRef(comments);
  const previousContent = useRef<unknown>(content);
  const versionedContent = diffAll ? allContents : content;
  if (
    previousComments.current !== comments ||
    previousContent.current !== versionedContent
  ) {
    previousComments.current = comments;
    previousContent.current = versionedContent;
    itemVersion.current++;
  }
  // Unreviewed files first, then reviewed ones, each in file tree order.
  const order = useMemo(() => {
    if (!diffAll) return [];
    const done = (path: string) => reviewedInView?.includes(path) || false;
    const all = [...(hasMessage ? [MESSAGE_PATH] : []), ...[...paths].sort(compareTreePaths)];
    return [...all.filter((path) => !done(path)), ...all.filter(done)];
  }, [diffAll, hasMessage, paths, reviewedInView]);
  const noticeFor = (path: string) => {
    const content = allContents?.[path];
    if (!content || isMessage(path)) return undefined;
    if (!content.oldFile && !content.newFile)
      return "File no longer exists. Refresh to update the file list.";
    return content.newFile?.notice || content.oldFile?.notice ||
      (!content.oldFile?.contents && !content.newFile?.contents ? "Empty file" : undefined);
  };
  const viewedSources = useMemo(() => [{ path: selected, file: fileSource }], [selected, fileSource]);
  // Find searches every file of the all-files diff, in display order.
  const allSources = useMemo(() => allContents ? order.flatMap<TextSearchSource>((path) => isMessage(path)
    ? [{ path, file: messageContent?.newFile }]
    : noticeFor(path) ? [] : [{ path, diff: parseDiff(diffKey(path), allContents[path]) }])
    : [], [allContents, order, messageContent]);
  const find = useTextSearch({
    sources: diffAll ? allSources : viewedSources, split, expanded, viewerMode, selected, viewer,
    // Moving between files of the all-files diff keeps the search.
    contentKey: diffAll ? allKey : contentKey,
  });
  // Keep item objects stable across unrelated renders: CodeView resets its
  // items when any item changes identity, and doing so while it renders (it
  // flushes React updates mid-frame) drops a pending scrollTo, e.g. from J/K.
  // Annotations follow comments through itemVersion.
  const allItems = useMemo(() => diffAll && allContents ? order.map((path) => {
    const shared = { id: path, annotations: annotationsFor(path), version: itemVersion.current };
    if (isMessage(path)) return { ...shared, type: "file", file: messageContent?.newFile };
    const notice = noticeFor(path);
    // Files without a previewable diff show only their header.
    return notice
      ? { ...shared, type: "diff", collapsed: true,
          fileDiff: parseDiff(diffKey(path), { oldFile: null, newFile: { name: path, contents: "" } }) }
      : { ...shared, type: "diff", fileDiff: parseDiff(diffKey(path), allContents[path]) };
  }) : [], [diffAll, allContents, order, messageContent, itemVersion.current]);
  const fileItems = useMemo(() => !diffAll && content && !notice && fileSource
    ? [{ type: "file", file: fileSource, id: selected, annotations: annotationsFor(selected), version: itemVersion.current }]
    : [], [diffAll, content, notice, fileSource, selected, singleSide, itemVersion.current]);
  const items = (diffAll ? allItems : fileItems) as CodeViewItem<Comment>[];
  const highlightedRange =
    highlight && matchesView(highlight) ? commentRange(highlight) : range;
  const highlightedPath = highlight && matchesView(highlight) ? highlight.path : rangePath;
  // Full-file rendering has one column; side metadata is only for the comment.
  const viewerRange = highlightedRange && !diffAll
    ? { start: highlightedRange.start, end: highlightedRange.end }
    : highlightedRange;

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

  const skipScrollRestore = useViewerScroll({
    root: info.root,
    scrollKey: viewerScrollKey,
    content,
    container: viewerContainer,
    interactionVersion,
    disabled: diffAll,
  });

  // The all-files diff remembers each file's scroll offset relative to the
  // file, under the key its own diff used before diffs were combined.
  const fileScrollKey = (path: string) => JSON.stringify([
    "viewer", JSON.stringify([tab, path, comparison.base, comparison.target]), "diff",
  ]);
  // Selection follows the file at the top only while the user scrolls the
  // diff: not after navigating to a file, which may be too short to reach the
  // top, and not when panels or wrapping change the layout.
  const scrollIntent = useRef(false);
  useEffect(() => {
    // Whether the latest interaction scrolls the diff.
    const track = (event: Event) => {
      const element = viewerContainer.current;
      scrollIntent.current = !!element && event.composedPath().includes(element) && (
        event.type === "wheel" || event.type === "touchstart" ||
        event instanceof KeyboardEvent && SCROLL_KEYS.includes(event.key) ||
        // Dragging the scrollbar.
        event instanceof PointerEvent && event.target === element &&
          event.offsetX >= element.clientWidth
      );
    };
    const types = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of types)
      document.addEventListener(type, track, { capture: true, passive: true });
    return () => {
      for (const type of types) document.removeEventListener(type, track, true);
    };
  }, []);
  // Set once the mounted all-files diff has scrolled to its initial file.
  const restoredKey = useRef("");
  const lastScrollTop = useRef(0);
  const live = useRef({ order, selected, findOpen: false });
  live.current = { order, selected, findOpen: find.open };
  // The viewed file follows the current match of a search across files.
  const findMatch = find.open ? find.matches[find.active] : undefined;
  useEffect(() => {
    if (!diffAll || !findMatch || findMatch.path === selected) return;
    replaceURL.current = true;
    setSelected(findMatch.path);
  }, [findMatch]);
  function scrollToFile(path: string, offset = 0) {
    if (!viewer.current || !order.includes(path)) return;
    scrollIntent.current = false;
    viewer.current.scrollTo({ type: "item", id: path, align: "start", offset: -offset });
  }
  const onViewerScroll = useCallback((
    scrollTop: number,
    instance: NonNullable<ReturnType<CodeViewHandle<Comment, undefined>["getInstance"]>>,
  ) => {
    if (restoredKey.current !== allKey) return;
    let current = "";
    for (const path of live.current.order) {
      const top = instance.getTopForItem(path);
      if (top === undefined || top > scrollTop + 1) break;
      current = path;
    }
    if (!current) return;
    rememberPosition(info.root, fileScrollKey(current), {
      top: scrollTop - (instance.getTopForItem(current) || 0),
      left: 0,
    });
    // Only scrolling moves the selection, not layout changes like Expand all.
    const scrolled = scrollTop !== lastScrollTop.current;
    lastScrollTop.current = scrollTop;
    if (
      !scrolled || !scrollIntent.current ||
      live.current.findOpen || current === live.current.selected
    ) return;
    // The last files may be too short to reach the top: at the bottom, keep a
    // selected file that is still visible below the top one.
    const element = viewerContainer.current;
    const selectedTop = instance.getTopForItem(live.current.selected);
    if (
      element && selectedTop !== undefined &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 2 &&
      selectedTop > scrollTop && selectedTop < scrollTop + element.clientHeight
    ) return;
    replaceURL.current = true;
    setSelected(current);
  }, [allKey, info.root, tab, comparison]);
  const [scrollRequest, setScrollRequest] = useState<{ path: string }>();
  useEffect(() => {
    if (!diffAll || !allContents || loading || comparing || !viewer.current) return;
    if (restoredKey.current !== allKey) {
      restoredKey.current = allKey;
      scrollIntent.current = false;
      // A pending comment scrolls to its own lines.
      const path = order.includes(selected) ? selected : order[0];
      if (path && path !== selected) {
        replaceURL.current = true;
        setSelected(path);
      }
      if (!pendingComment && path)
        scrollToFile(path, scrollStore(info.root)[fileScrollKey(path)]?.top);
    } else if (scrollRequest) {
      scrollToFile(scrollRequest.path);
    }
    setScrollRequest(undefined);
  }, [scrollRequest, diffAll, allContents, loading, comparing]);

  useEffect(() => {
    if (!pendingComment || loading || comparing || !content || !viewer.current)
      return;
    skipScrollRestore();
    scrollIntent.current = false;
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
    if (viewerMode !== "diff" && comment.comparison && !comment.commit)
      setViewerMode(comment.side === "deletions" ? "old" : "new");
    if (matchesView(comment)) {
      setSelected(comment.path);
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
    if (!comment.comparison) {
      setTab("files");
      setComparing(false);
    } else {
      try {
        const { mode: nextMode, base, target } = comment.comparison;
        const result = nextMode === "working"
          ? nextInfo.working
          : await api<Comparison>("compare", {
              mode: nextMode,
              from: base,
              to: target,
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
    if (editing) {
      setComments((items) =>
        items.map((item) =>
          item.id === editing ? { ...item, text: draft.trim() } : item,
        ),
      );
    } else {
      if (!range || !rangePath) return;
      const comment: Comment = {
        id: crypto.randomUUID(),
        path: rangePath,
        start,
        end,
        text: draft.trim(),
        side: range.side,
        context: tab === "files" ? "File" : compareLabel,
        ...(tab === "changes" ? {
          comparison: { mode: comparison.mode, base: comparison.base, target: comparison.target },
        } : {}),
        ...(isMessage(rangePath) ? { commit: comparison.target } : {}),
      };
      setComments((items) => [...items, comment]);
    }
    cancelComment();
    setCopied(false);
  }

  function saveGeneralComment() {
    if (!generalDraft.trim()) return;
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
      setDialog("copied");
    } catch {
      setCopied(false);
      setCopyError(
        "Clipboard blocked by your browser. Use Preview to select and copy the text.",
      );
    }
  }

  const copyLabel = copied ? "✓ Copied" : "Copy Prompt";

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
        comparison.mode === "commit"
          ? MESSAGE_PATH
          : comparison.entries[0]?.path || "",
      );
  }

  function resetReview() {
    setComments([]);
    setReviewed({});
    reviewHistory.current = [];
    cancelComment();
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
    closeDialog();
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
    // Follow a file moving back to the unreviewed section.
    else if (diffAll && wasReviewed && path === selected) setScrollRequest({ path });
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

  function pickLines(start: number, end: number, side: "additions" | "deletions") {
    const nextRange: SelectedLineRange = {
      start,
      end,
      ...(tab === "changes" && !isMessage(selected) ? { side } : {}),
    };
    closeDialog();
    onSelection(nextRange, selected);
    requestAnimationFrame(() => viewer.current?.scrollTo({
      type: "range",
      id: selected,
      range: diffAll && !isMessage(selected) ? nextRange : { start, end },
      align: "center",
    }));
  }

  function runCommand(command: Command) {
    if (command === "palette") setDialog("commands");
    else if (command === "find-viewed-file") find.show();
    else if (command === "next-text-match") find.findNext(1);
    else if (command === "previous-text-match") find.findNext(-1);
    else if (command === "find-file") setDialog("finder");
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
    } else if (command === "comment" && content && !notice && (diffAll || fileSource)) {
      setDialog("line");
    } else if (command === "toggle-reviewed") toggleReviewed();
    else if (command === "undo") undo();
    else if (command === "save-comment") saveComment();
    else if (command === "copy-prompt" && comments.length) void copyPrompt();
    else if (command === "preview-prompt" && comments.length) setDialog("prompt");
    else if (command === "toggle-diff" && diffAll) setSplit((value) => !value);
    else if (command === "toggle-wrap") setWrap((value) => !value);
    else if (command === "toggle-files") setShowFiles((value) => !value);
    else if (command === "toggle-comments") setShowComments((value) => !value);
    else if (command === "expand-diff" && diffAll) setExpanded(true);
    else if (command === "collapse-diff" && diffAll) setExpanded(false);
    else if (command === "refresh") location.reload();
    else if (command === "cancel") cancelComment();
  }

  useKeyboard({
    run: runCommand,
    escape: () => {
      if (find.open) {
        find.close();
        focusViewer();
      } else if (dialog) closeDialog();
      else if (editing || range) cancelComment();
      else return false;
      return true;
    },
    dialogOpen: !!dialog,
  });

  const unreviewedCount = order.filter((path) => !reviewedInView?.includes(path)).length;
  const summary = `${paths.length} ${paths.length === 1 ? "file" : "files"} · ${unreviewedCount} unreviewed`;
  const codeView = (
    <CodeView
      ref={viewer}
      containerRef={(element) => {
        viewerContainer.current = element;
        // A remounted all-files diff scrolls to its file again.
        if (!element) {
          restoredKey.current = "";
          return;
        }
        element.tabIndex = 0;
      }}
      className="code-view"
      items={items}
      options={options}
      selectedLines={
        viewerRange
          ? { id: highlightedPath, range: viewerRange }
          : null
      }
      onSelectedLinesChange={(selection) =>
        onSelection(selection?.range || null, selection?.id)
      }
      onScroll={diffAll ? onViewerScroll : undefined}
      renderCustomHeader={diffAll ? (item) => (
        <DiffFileHeader
          path={item.id}
          title={isMessage(item.id) ? `Commit message · ${comparison.target.slice(0, 7)}` : ""}
          href={fileHref(item.id)}
          stats={entries.find((entry) => entry.path === item.id)}
          notice={noticeFor(item.id)}
          current={item.id === selected}
          reviewed={reviewedInView?.includes(item.id) || false}
          reviewDisabled={loading || comparing}
          onSelect={() => select(item.id)}
          onToggleReviewed={() => togglePathReviewed(item.id, item.id === selected)}
        />
      ) : undefined}
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
  );

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
            onClick={() => setDialog("finder")}
          >
            <span aria-hidden="true">⌕</span>
            Find file
            <kbd>F</kbd>
          </button>
          <button
            className="shortcut-trigger"
            aria-label="Command launcher"
            title="Command launcher (? or Cmd+K)"
            onClick={() => setDialog("commands")}
          >
            ?
          </button>
          <button className="clear" onClick={clearReview}>
            Clear
          </button>
          <button
            className="primary copy"
            disabled={!comments.length}
            onClick={copyPrompt}
          >
            {copyLabel}
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
        <Sidebar
          tab={tab}
          paths={paths}
          entries={entries}
          lineCounts={info.lineCounts}
          hasMessage={hasMessage}
          reviewed={reviewedInView}
          reviewScope={reviewScope}
          selected={selected}
          onSelect={select}
          fileHref={fileHref}
          root={info.root}
          search={search}
          onSearch={setSearch}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onToggleReviewed={togglePathReviewed}
          onToggleDirectoryReviewed={toggleDirectoryReviewed}
          revealSelected={diffAll}
          treeOrder={treeOrder}
          onHide={() => setShowFiles(false)}
          onResize={setFilesWidth}
          hidden={!showFiles}
        />
        <main className="main">
          {find.open && (
            <TextSearchBar
              search={find}
              onClose={() => {
                find.close();
                focusViewer();
              }}
            />
          )}
          <FileHeading
            path={messageView || paths.includes(selected) ? selected : ""}
            title={messageView ? `Commit message · ${comparison.target.slice(0, 7)}` : ""}
            summary={diffAll ? summary : undefined}
            href={href}
            showModes={tab === "changes" && !messageView}
            viewerMode={viewerMode}
            onViewerMode={changeViewerMode}
            diffView={diffAll}
            split={split}
            onSplit={setSplit}
            expandable={diffAll}
            expanded={expanded}
            onToggleExpanded={() => setExpanded((value) => !value)}
            wrap={wrap}
            onToggleWrap={() => setWrap((value) => !value)}
            reviewed={selectedReviewed}
            reviewDisabled={loading || comparing}
            onToggleReviewed={toggleReviewed}
          />
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <div
            className={`code-pane${diffAll ? " all-files" : ""}`}
            key={diffAll
              ? `${tab}:${comparison.base}:${comparison.target}:${viewerMode}`
              : `${tab}:${selected}:${comparison.base}:${comparison.target}:${viewerMode}`}
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
            ) : (diffAll ? !order.length : tab === "changes" && !paths.length && !messageView) ? (
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
            ) : diffAll ? (
              codeView
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
                {codeView}
                {!fileSource?.contents && (
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
        <CommentsPanel
          comments={comments}
          highlight={highlight}
          onHighlight={setHighlight}
          onOpen={(comment) => void openComment(comment)}
          editing={editing}
          draft={draft}
          onDraftChange={setDraft}
          onEdit={(comment) => {
            setEditing(comment.id);
            setRange(null);
            setDraft(comment.text);
          }}
          onDelete={(comment) => {
            setComments((items) => items.filter((item) => item.id !== comment.id));
            if (editing === comment.id) cancelComment();
            setCopied(false);
          }}
          onSave={saveComment}
          onCancel={cancelComment}
          generalDraft={generalDraft}
          onGeneralDraftChange={setGeneralDraft}
          onSaveGeneral={saveGeneralComment}
          newComment={!editing && range && rangePath ? {
            reference: reference({
              path: rangePath,
              start,
              end,
              commit: isMessage(rangePath) ? comparison.target : undefined,
            }),
            oldSide: range.side === "deletions",
          } : null}
          selecting={!!range}
          errors={[copyError, storageError]}
          onPreview={() => setDialog("prompt")}
          onHide={() => setShowComments(false)}
          onResize={setCommentsWidth}
          hidden={!showComments}
        />
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
      {dialog === "prompt" && (
        <PromptDialog
          prompt={prompt}
          copyLabel={copyLabel}
          onCopy={copyPrompt}
          onClose={closeDialog}
        />
      )}
      {dialog === "copied" && (
        <CopiedPromptDialog prompt={prompt} onClear={clearCopiedReview} onClose={closeDialog} />
      )}
      {dialog === "finder" && (
        <FileFinder
          paths={hasMessage ? [MESSAGE_PATH, ...paths] : paths}
          reviewed={reviewedInView || []}
          onSelect={select}
          fileHref={fileHref}
          onClose={closeDialog}
        />
      )}
      {dialog === "commands" && (
        <CommandLauncher
          onClose={closeDialog}
          onChoose={(command) => {
            closeDialog();
            runCommand(command);
          }}
        />
      )}
      {dialog === "line" && (
        <LinePicker
          path={selected}
          initialTarget={range ? `${start}${end !== start ? `-${end}` : ""}` : ""}
          initialSide={singleSide || (range?.side === "deletions" ? "deletions" : "additions")}
          showSide={diffAll && !isMessage(selected)}
          lineCount={(side) => {
            const source = side === "deletions" ? content?.oldFile : content?.newFile;
            return source?.contents ? source.contents.split("\n").length : 0;
          }}
          onPick={pickLines}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
