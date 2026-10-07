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
import type { Command } from "../lib/shortcuts";
import { formatPrompt, reference } from "../prompt.js";
import { TextSearchBar, useTextSearch } from "./TextSearch";
import { Sidebar } from "./Sidebar";
import { CommentsPanel } from "./CommentsPanel";
import { FileHeading } from "./FileHeading";
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
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState("");
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
  const [contentRevision, setContentRevision] = useState(0);
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

  const { error: storageError, saveNow } = useSavedState(state, {
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
  const selectedEntry = comparison.entries.find((entry) => entry.path === selected);
  const messageView =
    tab === "changes" &&
    selected === MESSAGE_PATH &&
    comparison.mode === "commit";
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
    closeDialog();
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
      ...(diffView ? { side: comment.side || "additions" } : {}),
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
  const find = useTextSearch({
    fileSource, fileDiff, split, expanded, contentKey, viewerMode, selected, viewer, viewerContainer,
  });
  const annotations = comments.filter(matchesView).map((comment) => ({
    lineNumber: comment.end,
    side: comment.side || "additions",
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
  const item = fileSource ? { type: "file" as const, file: fileSource }
    : fileDiff ? { type: "diff" as const, fileDiff } : null;
  const items = (content && !notice && item
    ? [{ ...item, id: selected, annotations, version: itemVersion.current }]
    : []) as CodeViewItem<Comment>[];
  const highlightedRange =
    highlight && matchesView(highlight) ? commentRange(highlight) : range;
  // Full-file rendering has one column; side metadata is only for the comment.
  const viewerRange = highlightedRange && !diffView
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
  });

  useEffect(() => {
    if (!pendingComment || loading || comparing || !content || !viewer.current)
      return;
    skipScrollRestore();
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
        // Older comments identify their comparison only by its label.
        const { context } = comment;
        const nextMode = comment.comparison?.mode ||
          (context === "Working tree" || context === "Uncommitted changes" ? "working"
            : context.startsWith("Commit ") ? "commit" : "range");
        const [from = "", to = ""] = comment.comparison
          ? [comment.comparison.base, comment.comparison.target]
          : nextMode === "commit" ? ["", context.slice(7)] : context.split(" → ");
        const result = nextMode === "working"
          ? nextInfo.working
          : await api<Comparison>("compare", {
              mode: nextMode,
              from,
              to,
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
        ...(tab === "changes" ? {
          comparison: { mode: comparison.mode, base: comparison.base, target: comparison.target },
        } : {}),
        ...(messageView ? { commit: comparison.target } : {}),
      };
      setComments((items) => [...items, comment]);
    }
    cancelComment();
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
      setDialog("copied");
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
      cancelComment();
      setGeneralDraft("");
      setHighlight(null);
      closeDialog();
      setCopied(false);
      setSubmitted(true);
      saveNow({ comments: [] });
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
      ...(tab === "changes" && !messageView ? { side } : {}),
    };
    closeDialog();
    onSelection(nextRange);
    requestAnimationFrame(() => viewer.current?.scrollTo({
      type: "range",
      id: selected,
      range: diffView ? nextRange : { start, end },
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
    } else if (command === "comment" && content && !notice && (diffView || fileSource)) {
      setDialog("line");
    } else if (command === "toggle-reviewed") toggleReviewed();
    else if (command === "undo") undo();
    else if (command === "save-comment") saveComment();
    else if (command === "copy-prompt" && comments.length) void copyPrompt();
    else if (command === "preview-prompt" && comments.length) setDialog("prompt");
    else if (command === "toggle-diff" && diffView) setSplit((value) => !value);
    else if (command === "toggle-wrap") setWrap((value) => !value);
    else if (command === "toggle-files") setShowFiles((value) => !value);
    else if (command === "toggle-comments") setShowComments((value) => !value);
    else if (command === "expand-diff" && fileDiff) setExpanded(true);
    else if (command === "collapse-diff" && fileDiff) setExpanded(false);
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
            href={href}
            stats={diffView ? selectedEntry : undefined}
            showModes={tab === "changes" && !messageView}
            viewerMode={viewerMode}
            onViewerMode={changeViewerMode}
            diffView={diffView}
            split={split}
            onSplit={setSplit}
            expandable={!!fileDiff}
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
          newComment={!editing && range && selected ? {
            reference: reference({
              path: selected,
              start,
              end,
              commit: messageView ? comparison.target : undefined,
            }),
            oldSide: range.side === "deletions",
          } : null}
          selecting={!!range}
          errors={[copyError, submitError, storageError]}
          agent={info.agent}
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
          agent={info.agent}
          copyLabel={copyLabel}
          sendLabel={sendLabel}
          submitting={submitting}
          onCopy={copyPrompt}
          onSend={sendPrompt}
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
          showSide={diffView}
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
