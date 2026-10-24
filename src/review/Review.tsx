import {
  batch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  parseDiffFromFile,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type FileDiffMetadata,
  type SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewInstance } from "../components/CodeView";
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
import codeStyles from "./code.css?inline";
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

// Event handlers update several signals at once; batch them so effects (URL
// history, loading) only see the final state.
function batched<T extends unknown[], R>(fn: (...args: T) => R) {
  return (...args: T) => batch(() => fn(...args));
}

export function Review(props: {
  info: Info;
  state: SavedState;
  refreshInfo: () => Promise<Info>;
}) {
  const info = () => props.info;
  const { state, refreshInfo } = props;
  const saved = { ...readPreferences(state.view), ...readLocation(untrack(info)) };
  const [restoring, setRestoring] = createSignal(saved.mode !== "working");
  const [reviewed, setReviewed] = createSignal(state.reviewed || {});
  const [search, setSearch] = createSignal(saved.search);
  const [comments, setComments] = createSignal(state.comments || []);
  const [tab, setTab] = createSignal(saved.tab);
  const [mode, setMode] = createSignal(saved.mode);
  const [from, setFrom] = createSignal(saved.from);
  const [to, setTo] = createSignal(saved.to);
  const [comparison, setComparison] = createSignal<Comparison>(untrack(info).working);
  const compareLabel = createMemo(() => {
    const { mode, base, target } = comparison();
    return mode === "working"
      ? "Uncommitted changes"
      : mode === "commit"
        ? `Commit ${target.slice(0, 7)}`
        : `${base.slice(0, 7)} → ${target.slice(0, 7)}`;
  });
  const [comparing, setComparing] = createSignal(false);
  const [error, setError] = createSignal("");
  const [selected, setSelected] = createSignal(saved.selected);
  const [viewerMode, setViewerMode] = createSignal(saved.viewerMode);
  // Diffs show every changed file in one scroll; "selected" follows the file
  // at the top. Old/New and the File Browser show one file at a time.
  const diffAll = createMemo(() => tab() === "changes" && viewerMode() === "diff");
  const contentKey = createMemo(() => JSON.stringify([
    tab(), selected(), ...(tab() === "changes" ? [comparison().base, comparison().target] : []),
  ]));
  const [loaded, setLoaded] = createSignal<{ key: string; content: Content }>();
  const [contentRevision, setContentRevision] = createSignal(0);
  const allKey = createMemo(() =>
    JSON.stringify([comparison().base, comparison().target, contentRevision()]));
  const [allLoaded, setAllLoaded] =
    createSignal<{ key: string; contents: Record<string, Content> }>();
  const allContents = createMemo(() => {
    const value = allLoaded();
    return value?.key === allKey() ? value.contents : undefined;
  });
  const [visibleDiffs, setVisibleDiffs] = createSignal<string[]>([]);
  const [searchAll, setSearchAll] = createSignal(false);
  const [diffErrors, setDiffErrors] = createSignal<{ key: string; paths: Record<string, string> }>();
  const failures = () => diffErrors()?.key === allKey() ? diffErrors()!.paths : {};
  const busyDiffs = new Set<string>();
  const [diffProgress, setDiffProgress] = createSignal(0);
  const parsedDiffs = new Map<string, FileDiffMetadata>();
  const [loading, setLoading] = createSignal(false);
  const [split, setSplit] = createSignal(saved.split);
  const [wrap, setWrap] = createSignal(saved.wrap);
  const [expanded, setExpanded] = createSignal(saved.expanded);
  const [range, setRange] = createSignal<SelectedLineRange | null>(null);
  // Preview dragged ranges without mounting or focusing the comment composer.
  const [linePreview, setLinePreview] = createSignal<CodeViewLineSelection | null>();
  // The file the line range belongs to; in the all-files diff it may differ
  // from the selected file.
  const [rangePath, setRangePath] = createSignal("");
  const [fileCommentPath, setFileCommentPath] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [generalDraft, setGeneralDraft] = createSignal("");
  const [editing, setEditing] = createSignal<string>();
  const [copied, setCopied] = createSignal(false);
  const [copyError, setCopyError] = createSignal("");
  const [dialog, setDialog] =
    createSignal<"commands" | "finder" | "line" | "prompt" | "copied" | null>(null);
  const closeDialog = () => setDialog(null);
  const [reviewPickerRequest, setReviewPickerRequest] = createSignal(0);
  const [showFiles, setShowFiles] = createSignal(saved.showFiles);
  const [showComments, setShowComments] = createSignal(saved.showComments);
  const [filesWidth, setFilesWidth] = createSignal(saved.filesWidth);
  const [commentsWidth, setCommentsWidth] = createSignal(saved.commentsWidth);
  const [collapsed, setCollapsed] = createSignal(saved.collapsed);
  const [highlight, setHighlight] = createSignal<Comment | null>(null);
  const [pendingComment, setPendingComment] = createSignal<Comment | null>(null);
  const cancelComment = batched(() => {
    setEditing(undefined);
    setRange(null);
    setLinePreview(undefined);
    setFileCommentPath("");
    setDraft("");
  });
  const clearSelection = batched(() => {
    setRange(null);
    setLinePreview(undefined);
    setFileCommentPath("");
    setHighlight(null);
    setPendingComment(null);
  });
  // The mounted viewer. A signal, so effects that use it run once it mounts.
  const [viewer, setViewer] = createSignal<CodeViewInstance<Comment>>();
  const viewerContainer = () => viewer()?.getContainerElement();
  let interactionVersion = 0;
  let viewerFocusRequest: number | null = null;
  const viewerScrollKey = createMemo(() => JSON.stringify(["viewer", contentKey(), viewerMode()]));
  let comparisonRequest = 0;
  let viewRefresh = 0;
  let latestCommitPending = false;
  let reviewHistory: {
    scope: string;
    paths: string[];
    reviewed: boolean;
  }[] = [];
  const treeOrder: [string[], string[]] = [[], []];
  {
    const trackInteraction = () => interactionVersion++;
    const trackTypingFocus = (event: FocusEvent) => {
      if (isTyping(event.target)) trackInteraction();
    };
    document.addEventListener("pointerdown", trackInteraction, true);
    document.addEventListener("keydown", trackInteraction, true);
    document.addEventListener("focusin", trackTypingFocus);
    onCleanup(() => {
      document.removeEventListener("pointerdown", trackInteraction, true);
      document.removeEventListener("keydown", trackInteraction, true);
      document.removeEventListener("focusin", trackTypingFocus);
    });
  }
  onMount(() => {
    if (saved.mode !== "working")
      void compare(saved.mode, { to: saved.target, from: saved.base, restore: true }).finally(
        () => setRestoring(false),
      );
  });
  const href = (overrides: Partial<ViewLocation> = {}) => viewHref({
    tab: tab(), comparison: comparison(), path: selected(), viewerMode: viewerMode(),
    split: split(), expanded: expanded(), commits: info().commits,
    ...overrides,
  });
  const fileHref = (path: string) => href({ path });
  let initialURL = true;
  let replaceURL = false;
  createEffect(() => {
    if (restoring() || comparing() || error()) return;
    const next = href();
    // Scrolling through the all-files diff updates the URL without history.
    if (initialURL || replaceURL) {
      history.replaceState(null, "", next);
      initialURL = false;
      replaceURL = false;
    } else if (next !== `${location.pathname}${location.search}${location.hash}`) {
      history.pushState(null, "", next);
    }
  });
  {
    // Back/Forward use the same loading path as a direct link or new tab.
    const restoreURL = () => location.reload();
    window.addEventListener("popstate", restoreURL);
    onCleanup(() => window.removeEventListener("popstate", restoreURL));
  }

  const storageError = useSavedState(state, () => ({
    view: {
      search: search(), wrap: wrap(), showFiles: showFiles(), showComments: showComments(),
      filesWidth: filesWidth(), commentsWidth: commentsWidth(), collapsed: collapsed(),
    },
    // Mutable views are only reviewed for this page snapshot.
    reviewed: Object.fromEntries(
      Object.entries(reviewed()).filter(([scope]) => scope !== "files" && scope !== "working"),
    ),
    comments: comments(),
  }));
  const paths = createMemo(() =>
    tab() === "files"
      ? info().files
      : comparison().entries.map((entry) => entry.path));
  const entries = () => tab() === "files" ? info().working.entries : comparison().entries;
  const isMessage = (path: string) =>
    tab() === "changes" && path === MESSAGE_PATH && comparison().mode === "commit";
  // The commit message shown on its own; the all-files diff includes it.
  const messageView = createMemo(() => !diffAll() && isMessage(selected()));
  const messageKey = createMemo(() =>
    JSON.stringify([tab(), MESSAGE_PATH, comparison().base, comparison().target]));
  const message = () => comparison().message;
  const messageContent = createMemo(on([message, messageKey], ([text, key]): Content | undefined =>
    text === undefined
      ? undefined
      : {
          oldFile: null,
          newFile: {
            name: "COMMIT_MESSAGE.txt",
            contents: text,
            cacheKey: key,
          },
        }));
  const content = createMemo(() => {
    if (diffAll()) return isMessage(selected()) ? messageContent() : allContents()?.[selected()];
    // Never mount the previous file under the new selection while its effect loads.
    const value = loaded();
    return value?.key === contentKey() ? value.content : undefined;
  });
  const reviewScope = createMemo(() =>
    tab() === "files"
      ? "files"
      : comparison().mode === "working"
        ? "working"
        : JSON.stringify([comparison().mode, comparison().base, comparison().target]));
  const reviewedInView = createMemo(() => reviewed()[reviewScope()]);
  const hasMessage = createMemo(() => tab() === "changes" && comparison().mode === "commit");
  const selectedReviewed = () => reviewedInView()?.includes(selected()) || false;
  const focusViewer = () => {
    viewerContainer()?.focus({ preventScroll: true });
  };
  const select = batched((path: string) => {
    if (diffAll()) {
      setScrollRequest({ path });
      if (path === selected()) {
        focusViewer();
        return;
      }
      viewerFocusRequest = interactionVersion;
      setSelected(path);
      clearSelection();
      return;
    }
    if (path === selected()) {
      focusViewer();
      return;
    }
    viewerFocusRequest = interactionVersion;
    setSelected(path);
    clearSelection();
  });

  // Whether the selected file is listed, not the list: refreshing an
  // unchanged list must not reload and remount the viewed file.
  const selectedListed = createMemo(() => paths().includes(selected()));
  createEffect(() => {
    if (restoring() || diffAll()) return;
    const key = contentKey();
    const message = messageContent();
    if (messageView() && message) {
      setLoaded({ key, content: message });
      setLoading(false);
      setError("");
      return;
    }
    const path = selected();
    if (!path || !selectedListed()) {
      setLoaded(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const { base, target } = comparison();
    const load =
      tab() === "files"
        ? loadFile(path, "", contentRevision()).then((newFile) => ({
            oldFile: null,
            newFile,
          }))
        : Promise.all([
            loadFile(path, base, contentRevision()),
            loadFile(path, target, contentRevision()),
          ]).then(([oldFile, newFile]) => ({ oldFile, newFile }));
    load
      .then((value) => {
        if (active) setLoaded({ key, content: value });
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    onCleanup(() => {
      active = false;
    });
  });

  let disposed = false;
  onCleanup(() => { disposed = true; });
  createEffect(() => {
    diffProgress();
    if (restoring() || !diffAll() || comparing()) return;
    setLoading(false);
    const key = allKey();
    const { base, target } = comparison();
    const revision = contentRevision();
    const contents = allContents();
    const errors = failures();
    const listed = new Set(paths());
    // Rebuild demand rather than queueing the entire comparison. Selection
    // takes priority; scrolling away or changing scopes drops unstarted work.
    const foreground = new Set([selected(), ...visibleDiffs(), ...(searchAll() ? paths() : [])]);
    const displayed = order();
    const index = displayed.indexOf(selected());
    // Anchor look-ahead to selection, never to the loaded/virtualized frontier:
    // completing a speculative load must not walk the rest of the comparison.
    const nearby = index < 0 ? [] : [displayed[index + 1], displayed[index + 2], displayed[index - 1]];
    const wanted = new Set([...foreground, ...nearby.filter((path): path is string => !!path)]);
    for (const path of wanted) {
      if (busyDiffs.size >= 3) break; // Three file pairs, at most six requests.
      // One speculative pair only, after foreground work drains. Leave two
      // slots available for a new selection or viewport while it is in flight.
      if (!foreground.has(path) && busyDiffs.size) break;
      const request = JSON.stringify([key, path]);
      if (!listed.has(path) || contents?.[path] || errors[path] || busyDiffs.has(request)) continue;
      busyDiffs.add(request);
      // Keep the slot until both requests finish, including after one fails.
      Promise.allSettled([loadFile(path, base, revision), loadFile(path, target, revision)])
        .then(([oldFile, newFile]) => {
          if (disposed || untrack(allKey) !== key) return;
          if (oldFile.status === "rejected") throw oldFile.reason;
          if (newFile.status === "rejected") throw newFile.reason;
          setAllLoaded((current) => ({
            key,
            contents: { ...(current?.key === key ? current.contents : {}), [path]: { oldFile: oldFile.value, newFile: newFile.value } },
          }));
        })
        .catch((e) => {
          if (disposed || untrack(allKey) !== key) return;
          setDiffErrors((current) => ({
            key, paths: { ...(current?.key === key ? current.paths : {}), [path]: e.message },
          }));
        })
        .finally(() => {
          busyDiffs.delete(request);
          if (!disposed) setDiffProgress((value) => value + 1);
        });
    }
  });

  async function compare(nextMode: string, {
    to: nextTo = to(),
    from: nextFrom = from(),
    restore = false,
    info: refreshedInfo,
    refresh = restore ? 0 : ++viewRefresh,
  }: { to?: string; from?: string; restore?: boolean; info?: Info; refresh?: number } = {}) {
    const id = ++comparisonRequest;
    batch(() => {
      if (!restore) setContentRevision(refresh);
      if (!restore) {
        setMode(nextMode);
        setSearch("");
      }
      setComparing(true);
      setError("");
      clearSelection();
    });
    try {
      const nextInfo = restore ? info() : refreshedInfo || await refreshInfo();
      if (id !== comparisonRequest) return;
      const result =
        nextMode === "working"
          ? nextInfo.working
          : await api<Comparison>("compare", {
              mode: nextMode,
              from: nextFrom,
              to: nextTo,
              refresh: String(refresh),
            });
      if (id !== comparisonRequest) return;
      batch(() => {
        setComparison(result);
        if (nextMode === "commit") setTo(result.target);
        setSelected((current) => {
          const kept = result.entries.some((entry) => entry.path === current);
          if (restore && (tab() === "files" || kept)) return current;
          if (nextMode === "commit") return MESSAGE_PATH;
          return kept ? current : result.entries[0]?.path || "";
        });
        setComparing(false);
      });
    } catch (e) {
      if (id === comparisonRequest) {
        batch(() => {
          if (restore) setSelected("");
          setError((e as Error).message);
          setComparing(false);
        });
      }
    }
  }

  const singleSide = createMemo(() => tab() === "changes" && !messageView() && viewerMode() !== "diff"
    ? viewerMode() === "old" ? "deletions" as const : "additions" as const
    : undefined);
  const fileSource = createMemo(() => diffAll() ? undefined
    : singleSide() === "deletions" ? content()?.oldFile : content()?.newFile);

  const changeViewerMode = batched((value: ViewerMode) => {
    setViewerMode(value);
    clearSelection();
    closeDialog();
  });

  const onSelection = batched((value: SelectedLineRange | null, path?: string) => {
    const side = singleSide();
    setHighlight(null);
    if (value) {
      setShowComments(true);
      setFileCommentPath("");
    }
    if (value && path) setRangePath(path);
    // A reference must use one file-side's coordinates, never mixed old/new numbers.
    setRange(
      value && side
        ? { start: value.start, end: value.end, side }
        : value?.endSide && value.endSide !== value.side
        ? { ...value, end: value.start, endSide: value.side }
        : value,
    );
  });
  const openLineComment = batched((value: SelectedLineRange, path: string) => {
    if (editing()) setDraft("");
    setEditing(undefined);
    onSelection(value, path);
    requestAnimationFrame(() => {
      document.getElementById("comment-text")?.focus({ preventScroll: true });
    });
  });
  const openFileComment = batched((path: string) => {
    if (editing()) setDraft("");
    setEditing(undefined);
    clearSelection();
    setSelected(path);
    setFileCommentPath(path);
    setShowComments(true);
    requestAnimationFrame(() => {
      document.getElementById("comment-text")?.focus({ preventScroll: true });
    });
  });
  const options = createMemo<CodeViewOptions<Comment, undefined>>(() => ({
    theme: "light-plus" as const,
    themeType: "light" as const,
    diffStyle: split() ? ("split" as const) : ("unified" as const),
    enableLineSelection: true,
    enableGutterUtility: true,
    unsafeCSS: codeStyles,
    onGutterUtilityClick: (value, { item }) => openLineComment(value, item.id),
    onLineEnter: ({ numberElement }, { item, instance }) => {
      const button = numberElement.querySelector<HTMLButtonElement>("[data-utility-button]");
      if (!button) return;
      button.setAttribute("aria-label", "Add line comment");
      button.title = "Add comment · drag to select multiple lines";
      // Pointer clicks and drags are handled by the viewer. Native keyboard
      // and assistive clicks still need to open the same composer.
      button.onclick = (event) => {
        if (event.detail !== 0) return;
        const hovered = instance.getHoveredLine();
        if (!hovered) return;
        const selection = viewer()?.getSelectedLines();
        openLineComment(selection?.id === item.id ? selection.range : {
          start: hovered.lineNumber,
          end: hovered.lineNumber,
          ...("side" in hovered && (hovered.side === "additions" || hovered.side === "deletions")
            ? { side: hovered.side } : {}),
        }, item.id);
      };
    },
    // Commit on release, keeping the composer (and its autofocus) out of
    // the way while the viewer previews a dragged range.
    onLineSelected: (value, { item }) => {
      setLinePreview(undefined);
      onSelection(value, item.id);
    },
    itemMetrics: { lineHeight: 23, diffHeaderHeight: HEADER_HEIGHT },
    pointerEventsOnScroll: true,
    overflow: wrap() ? ("wrap" as const) : ("scroll" as const),
    expandUnchanged: expanded(),
    disableFileHeader: !diffAll(),
    stickyHeaders: true,
    ...(diffAll() ? { layout: { paddingTop: 0, paddingBottom: 0, gap: 0 } } : {}),
  }));
  const prompt = createMemo(() => formatPrompt(comments()));
  const notice = createMemo(() => diffAll()
    ? content()?.newFile?.notice || content()?.oldFile?.notice
    : fileSource()?.notice);
  const start = () => {
    const value = range();
    return value ? Math.min(value.start, value.end) : 1;
  };
  const end = () => {
    const value = range();
    return value ? Math.max(value.start, value.end) : 1;
  };

  function matchesScope(comment: Comment) {
    return (
      !comment.general &&
      (tab() === "files"
        ? !comment.comparison
        : comment.comparison?.base === comparison().base &&
          comment.comparison.target === comparison().target)
    );
  }
  function matchesView(comment: Comment) {
    return (diffAll() || comment.path === selected()) && matchesScope(comment) &&
      (comment.file || !singleSide() || (comment.side || "additions") === singleSide());
  }
  function commentRange(comment: Comment): SelectedLineRange {
    return {
      start: comment.start,
      end: comment.end,
      ...(diffAll() && !isMessage(comment.path) ? { side: comment.side || "additions" } : {}),
    };
  }
  function parseDiff(key: string, { oldFile, newFile }: Content) {
    let diff = parsedDiffs.get(key);
    if (!diff) {
      diff = parseDiffFromFile(oldFile, newFile);
      // Include the comparison even for additions/deletions with a missing side.
      diff.cacheKey = key;
      parsedDiffs.set(key, diff);
    }
    return diff;
  }
  const diffKey = (path: string) => JSON.stringify([allKey(), path]);
  const annotationsFor = (path: string) => comments()
    .filter((comment) => !comment.file && comment.path === path && matchesView(comment))
    .map((comment) => ({
      lineNumber: comment.end,
      side: comment.side || "additions",
      metadata: comment,
    }));
  // CodeView needs a new version when the same item gets new text or annotations.
  let versionCount = 0;
  const versionedContent = createMemo<unknown>(() => diffAll() ? undefined : content());
  const itemVersion = createMemo(on([comments, versionedContent], () => ++versionCount));
  // Unreviewed files first, then reviewed ones, each in file tree order.
  const order = createMemo(() => {
    if (!diffAll()) return [];
    const done = (path: string) => reviewedInView()?.includes(path) || false;
    const all = [...(hasMessage() ? [MESSAGE_PATH] : []), ...[...paths()].sort(compareTreePaths)];
    return [...all.filter((path) => !done(path)), ...all.filter(done)];
  });
  const noticeFor = (path: string) => {
    const content = allContents()?.[path];
    if (isMessage(path)) return undefined;
    if (!content) return failures()[path] || "Loading…";
    if (!content.oldFile && !content.newFile)
      return "File no longer exists. Refresh to update the file list.";
    return content.newFile?.notice || content.oldFile?.notice ||
      (!content.oldFile?.contents && !content.newFile?.contents ? "Empty file" : undefined);
  };
  const viewedSources = createMemo(() => [{ path: selected(), file: fileSource() }]);
  const searchPending = createMemo(() => searchAll()
    ? paths().filter((path) => !allContents()?.[path] && !failures()[path]).length : 0);
  // An explicit search loads the comparison with the same request limit.
  // Publish complete results together so arriving files cannot move the match
  // under the user's cursor or silently report a partial search as complete.
  const allSources = createMemo(on([allContents, order, messageContent, searchPending], ([contents, paths, message, pending]) =>
    !pending ? paths.flatMap<TextSearchSource>((path) => isMessage(path)
      ? [{ path, file: message?.newFile }]
      : !contents?.[path] || noticeFor(path) ? [] : [{ path, diff: parseDiff(diffKey(path), contents[path]) }])
      : []));
  const find = useTextSearch({
    sources: () => diffAll() ? allSources() : viewedSources(),
    split, expanded, viewerMode, selected, viewer,
    // Moving between files of the all-files diff keeps the search.
    contentKey: () => diffAll() ? allKey() : contentKey(),
  });
  // Hide incomplete results before effects can follow a cached partial match.
  createComputed(() => setSearchAll(diffAll() && find.open() && !!find.query()));
  // Keep item objects stable across unrelated updates: CodeView resets its
  // items when any item changes identity, which drops a pending scrollTo,
  // e.g. from J/K. Annotations follow comments through itemVersion.
  const itemCache = new Map<string, { content?: Content; version: number; notice?: string; item: CodeViewItem<Comment> }>();
  let itemCacheKey = "", nextItemVersion = 0;
  const allItems = createMemo(on(
    [diffAll, allKey, allContents, order, messageContent, itemVersion, diffErrors],
    ([all, key, contents, paths, message, version]) => {
      if (itemCacheKey !== key) {
        itemCache.clear();
        itemCacheKey = key;
      }
      return all ? paths.map((path) => {
        const source = isMessage(path) ? message : contents?.[path];
        const notice = noticeFor(path);
        const cached = itemCache.get(path);
        if (cached && cached.content === source && cached.version === version && cached.notice === notice)
          return cached.item;
        const shared = { id: path, annotations: annotationsFor(path), version: ++nextItemVersion };
        // Unloaded files reserve a header in the virtual list. Only mounted
        // headers, selected neighbors, and explicit Find request their diff.
        const item: CodeViewItem<Comment> = isMessage(path)
          ? { ...shared, type: "file", file: message!.newFile! }
          : notice
            ? { ...shared, type: "diff", collapsed: true,
                fileDiff: parseDiff(`placeholder:${diffKey(path)}`, { oldFile: null, newFile: { name: path, contents: "" } }) }
            : { ...shared, type: "diff", fileDiff: parseDiff(diffKey(path), source!) };
        itemCache.set(path, { content: source, version, notice, item });
        return item;
      }) : [];
    },
  ));
  const fileItems = createMemo(on(
    [diffAll, content, notice, fileSource, selected, singleSide, itemVersion],
    ([all, content, notice, file, path, , version]) => !all && content && !notice && file
      ? [{ type: "file", file, id: path, annotations: annotationsFor(path), version }]
      : [],
  ));
  const items = () => (diffAll() ? allItems() : fileItems()) as CodeViewItem<Comment>[];
  const highlightedRange = () => {
    const comment = highlight();
    return comment && matchesView(comment)
      ? comment.file ? null : commentRange(comment)
      : range();
  };
  const highlightedPath = () => {
    const comment = highlight();
    return comment && matchesView(comment) ? comment.path : rangePath();
  };
  // Full-file rendering has one column; side metadata is only for the comment.
  const selectedLines = createMemo(() => {
    const preview = linePreview();
    if (preview !== undefined) return preview;
    const value = highlightedRange();
    if (!value) return null;
    return {
      id: highlightedPath(),
      range: diffAll() ? value : { start: value.start, end: value.end },
    };
  });

  createEffect(on([content, loading, comparing, restoring, () => items().length, viewer], () => {
    if (
      viewerFocusRequest !== null && content() && !loading() && !comparing() &&
      !restoring() && items().length && viewer()
    ) {
      const request = viewerFocusRequest;
      viewerFocusRequest = null;
      if (request === interactionVersion) focusViewer();
    }
  }));

  const skipScrollRestore = useViewerScroll({
    root: untrack(info).root,
    scrollKey: viewerScrollKey,
    content,
    container: viewerContainer,
    interactionVersion: () => interactionVersion,
    disabled: diffAll,
  });

  // The all-files diff remembers each file's scroll offset relative to the
  // file, under the key its own diff used before diffs were combined.
  const fileScrollKey = (path: string) => JSON.stringify([
    "viewer", JSON.stringify([tab(), path, comparison().base, comparison().target]), "diff",
  ]);
  // Selection follows the file at the top only while the user scrolls the
  // diff: not after navigating to a file, which may be too short to reach the
  // top, and not when panels or wrapping change the layout.
  let scrollIntent = false;
  let lazyScroll: { key: string; path: string; offset: number } | undefined;
  {
    // Whether the latest interaction scrolls the diff.
    const track = (event: Event) => {
      const element = viewerContainer();
      scrollIntent = !!element && event.composedPath().includes(element) && (
        event.type === "wheel" || event.type === "touchstart" ||
        event instanceof KeyboardEvent && SCROLL_KEYS.includes(event.key) ||
        // Dragging the scrollbar.
        event instanceof PointerEvent && event.target === element &&
          event.offsetX >= element.clientWidth
      );
      if (scrollIntent || event.type === "pointerdown" && element && event.composedPath().includes(element))
        lazyScroll = undefined;
    };
    const types = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of types)
      document.addEventListener(type, track, { capture: true, passive: true });
    onCleanup(() => {
      for (const type of types) document.removeEventListener(type, track, true);
    });
  }
  // Set once the mounted all-files diff has scrolled to its initial file.
  let restoredKey = "";
  let lastScrollTop = 0;
  // The viewed file follows the current match of a search across files.
  const findMatch = createMemo(() => find.open() ? find.matches()[find.active()] : undefined);
  createEffect(on(find.open, (open) => { if (open) lazyScroll = undefined; }));
  createEffect(on(findMatch, (match) => {
    if (!diffAll() || !match || match.path === selected()) return;
    replaceURL = true;
    setSelected(match.path);
  }));
  function scrollToFile(path: string, offset = 0) {
    const instance = viewer();
    if (!instance || !order().includes(path)) return;
    scrollIntent = false;
    lazyScroll = { key: allKey(), path, offset };
    instance.scrollTo({ type: "item", id: path, align: "start", offset: -offset });
  }
  const onViewerScroll = (scrollTop: number, instance: CodeViewInstance<Comment>) => {
    if (restoredKey !== allKey()) return;
    let current = "";
    for (const path of order()) {
      const top = instance.getTopForItem(path);
      if (top === undefined || top > scrollTop + 1) break;
      current = path;
    }
    if (!current) return;
    rememberPosition(info().root, fileScrollKey(current), {
      top: scrollTop - (instance.getTopForItem(current) || 0),
      left: 0,
    });
    // Only scrolling moves the selection, not layout changes like Expand all.
    const scrolled = scrollTop !== lastScrollTop;
    lastScrollTop = scrollTop;
    if (
      !scrolled || !scrollIntent ||
      find.open() || current === selected()
    ) return;
    // The last files may be too short to reach the top: at the bottom, keep a
    // selected file that is still visible below the top one.
    const element = viewerContainer();
    const selectedTop = instance.getTopForItem(selected());
    if (
      element && selectedTop !== undefined &&
      element.scrollTop + element.clientHeight >= element.scrollHeight - 2 &&
      selectedTop > scrollTop && selectedTop < scrollTop + element.clientHeight
    ) return;
    replaceURL = true;
    setSelected(current);
  };
  const [scrollRequest, setScrollRequest] = createSignal<{ path: string }>();
  createEffect(on([scrollRequest, diffAll, allContents, loading, comparing, viewer], () => {
    if (!diffAll() || loading() || comparing() || !viewer()) return;
    if (restoredKey !== allKey()) {
      scrollIntent = false;
      // A pending comment scrolls to its own lines.
      const path = order().includes(selected()) ? selected() : order()[0];
      if (path && path !== selected()) {
        replaceURL = true;
        setSelected(path);
      }
      const ready = !path || isMessage(path) || allContents()?.[path] || failures()[path];
      if (ready) restoredKey = allKey();
      if (!pendingComment() && path)
        scrollToFile(path, ready ? scrollStore(info().root)[fileScrollKey(path)]?.top : 0);
    } else if (scrollRequest()) {
      scrollToFile(scrollRequest()!.path);
    }
    setScrollRequest(undefined);
  }));

  // A short destination can be clamped above its header while the preceding
  // files are placeholders. Keep the requested file anchored as they expand,
  // until the user scrolls or another interaction owns the destination.
  createEffect(on([allContents, viewer], () => {
    if (lazyScroll?.key !== allKey() || !diffAll() || pendingComment() || find.open()) return;
    const { path, offset } = lazyScroll;
    viewer()?.scrollTo({ type: "item", id: path, align: "start", offset: -offset });
  }));

  createEffect(on(
    [pendingComment, content, loading, comparing, viewerMode, viewerScrollKey, viewer],
    ([comment]) => {
      const instance = viewer();
      if (!comment || loading() || comparing() || !content() || !instance)
        return;
      skipScrollRestore();
      scrollIntent = false;
      lazyScroll = undefined;
      instance.scrollTo(comment.file ? {
        type: "item",
        id: comment.path,
        align: "start",
      } : {
        type: "range",
        id: comment.path,
        range: commentRange(comment),
        align: "center",
      });
      setPendingComment(null);
    },
  ));

  async function openComment(comment: Comment) {
    const id = ++comparisonRequest;
    const opened = batch(() => {
      setComparing(false);
      setRange(null);
      setLinePreview(undefined);
      setFileCommentPath("");
      setHighlight(comment);
      setError("");
      if (viewerMode() !== "diff" && comment.comparison && !comment.commit && !comment.file)
        setViewerMode(comment.side === "deletions" ? "old" : "new");
      if (matchesView(comment) || matchesScope(comment)) {
        setSelected(comment.path);
        setPendingComment(comment);
        return true;
      }
      return false;
    });
    if (opened) return;
    const refresh = ++viewRefresh;
    batch(() => {
      setContentRevision(refresh);
      setLoaded(undefined);
      setSearch("");
    });
    let nextInfo: Info;
    try {
      nextInfo = await refreshInfo();
      if (id !== comparisonRequest) return;
    } catch (e) {
      if (id === comparisonRequest) setError((e as Error).message);
      return;
    }
    if (!comment.comparison) {
      batch(() => {
        setTab("files");
        setComparing(false);
        setSelected(comment.path);
        setPendingComment(comment);
      });
      return;
    }
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
      if (id !== comparisonRequest) return;
      batch(() => {
        setComparison(result);
        setMode(nextMode);
        setFrom(result.base);
        setTo(result.target || nextInfo.commits[0]?.id || "");
        setTab("changes");
        setComparing(false);
        setSelected(comment.path);
        setPendingComment(comment);
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const saveComment = batched(() => {
    if (!draft().trim()) return;
    const id = editing();
    if (id) {
      setComments((items) =>
        items.map((item) =>
          item.id === id ? { ...item, text: draft().trim() } : item,
        ),
      );
    } else {
      const value = range();
      const filePath = fileCommentPath();
      const path = filePath || rangePath();
      if (!filePath && (!value || !path)) return;
      const comment: Comment = {
        id: crypto.randomUUID(),
        path,
        start: filePath ? 0 : start(),
        end: filePath ? 0 : end(),
        text: draft().trim(),
        ...(filePath ? { file: true } : { side: value?.side }),
        context: tab() === "files" ? "File" : compareLabel(),
        ...(tab() === "changes" ? {
          comparison: {
            mode: comparison().mode, base: comparison().base, target: comparison().target,
          },
        } : {}),
        ...(isMessage(path) ? { commit: comparison().target } : {}),
      };
      setComments((items) => [...items, comment]);
    }
    cancelComment();
    setCopied(false);
  });

  const saveGeneralComment = batched(() => {
    if (!generalDraft().trim()) return;
    setComments((items) => [...items, {
      id: crypto.randomUUID(),
      path: "",
      start: 0,
      end: 0,
      text: generalDraft().trim(),
      general: true,
      context: "General",
    }]);
    setGeneralDraft("");
    setCopied(false);
  });

  async function copyPrompt() {
    setCopyError("");
    // Never open a dialog on failure.
    try {
      await copyText(prompt());
      setCopied(true);
      setDialog("copied");
    } catch {
      setCopied(false);
      setCopyError(
        "Clipboard blocked by your browser. Use Preview to select and copy the text.",
      );
    }
  }

  const copyLabel = () => copied() ? "✓ Copied" : "Copy Prompt";

  const changeTab = batched((value: "files" | "changes", refresh = true) => {
    if (refresh) {
      comparisonRequest++;
      if (value === "files") setComparing(false);
      const request = ++viewRefresh;
      setContentRevision(request);
      void refreshInfo().catch((error) => {
        if (request === viewRefresh)
          setError((error as Error).message);
      });
    }
    setTab(value);
    setSearch("");
    clearSelection();
    if (
      value === "changes" &&
      !comparison().entries.some((entry) => entry.path === selected())
    )
      setSelected(
        comparison().mode === "commit"
          ? MESSAGE_PATH
          : comparison().entries[0]?.path || "",
      );
  });

  const resetReview = batched(() => {
    setComments([]);
    setReviewed({});
    reviewHistory = [];
    cancelComment();
    setGeneralDraft("");
    clearSelection();
    setCopied(false);
  });

  function clearReview() {
    if (!window.confirm(
      "Clear all comments and review progress? View settings will be kept. This cannot be undone.",
    )) return;
    resetReview();
  }

  const clearCopiedReview = batched(() => {
    closeDialog();
    resetReview();
  });

  const togglePathReviewed = batched((path: string, advance = false) => {
    if (!path || !(path === MESSAGE_PATH || paths().includes(path)) || loading() || comparing())
      return;
    const scope = reviewScope();
    const wasReviewed = reviewedInView()?.includes(path) || false;
    reviewHistory.push({
      scope,
      paths: [path],
      reviewed: wasReviewed,
    });
    if (advance && !wasReviewed) moveFile(1);
    // Follow a file moving back to the unreviewed section.
    else if (diffAll() && wasReviewed && path === selected()) setScrollRequest({ path });
    setReviewed((current) => ({
      ...current,
      [scope]: wasReviewed
        ? (current[scope] || []).filter((item) => item !== path)
        : [...(current[scope] || []), path],
    }));
  });

  const toggleDirectoryReviewed = batched((directory: string) => {
    if (loading() || comparing()) return;
    const files = paths().filter((path) => path.startsWith(directory));
    if (!files.length) return;
    const scope = reviewScope();
    const wasReviewed = files.every((path) => reviewedInView()?.includes(path));
    reviewHistory.push({
      scope,
      paths: files,
      reviewed: wasReviewed,
    });
    setReviewed((current) => ({
      ...current,
      [scope]: wasReviewed
        ? (current[scope] || []).filter(
            (item) => !files.includes(item),
          )
        : [...new Set([...(current[scope] || []), ...files])],
    }));
  });

  function toggleReviewed() {
    togglePathReviewed(selected(), true);
  }

  const undo = batched(() => {
    const action = reviewHistory.pop();
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
    if (action.scope === reviewScope()) {
      const restored = action.paths.find(
        (path) => path === MESSAGE_PATH || paths().includes(path),
      );
      if (restored) select(restored);
    }
  });

  function moveFile(offset: number) {
    const reviewItems = treeOrder.flat();
    if (!reviewItems.length) return;
    const current = reviewItems.indexOf(selected());
    const next = current < 0
      ? (offset > 0 ? 0 : reviewItems.length - 1)
      : (current + offset + reviewItems.length) % reviewItems.length;
    select(reviewItems[next]);
  }

  const pickLines = batched((start: number, end: number, side: "additions" | "deletions") => {
    const path = selected();
    const nextRange: SelectedLineRange = {
      start,
      end,
      ...(tab() === "changes" && !isMessage(path) ? { side } : {}),
    };
    const scrollRange = diffAll() && !isMessage(path) ? nextRange : { start, end };
    closeDialog();
    onSelection(nextRange, path);
    requestAnimationFrame(() => viewer()?.scrollTo({
      type: "range",
      id: path,
      range: scrollRange,
      align: "center",
    }));
  });

  const runCommand = batched((command: Command) => {
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
      viewerFocusRequest = interactionVersion;
      changeTab("files");
    } else if (command === "uncommitted") {
      changeTab("changes", false);
      void compare("working");
    } else if (command === "recent-commit") {
      if (latestCommitPending) return;
      latestCommitPending = true;
      const refresh = ++viewRefresh;
      setContentRevision(refresh);
      void refreshInfo()
        .then(async (nextInfo) => {
          if (refresh !== viewRefresh) return;
          const latest = nextInfo.commits[0]?.id;
          if (!latest) return;
          const comparing = batch(() => {
            setTo(latest);
            changeTab("changes", false);
            return compare("commit", { to: latest, info: nextInfo, refresh });
          });
          await comparing;
        })
        .catch((error) => setError((error as Error).message))
        .finally(() => {
          latestCommitPending = false;
        });
    } else if (command === "comment" && content() && !notice() && (diffAll() || fileSource())) {
      setDialog("line");
    } else if (command === "toggle-reviewed") toggleReviewed();
    else if (command === "undo") undo();
    else if (command === "save-comment") saveComment();
    else if (command === "copy-prompt" && comments().length) void copyPrompt();
    else if (command === "preview-prompt" && comments().length) setDialog("prompt");
    else if (command === "toggle-diff" && diffAll()) setSplit((value) => !value);
    else if (command === "toggle-wrap") setWrap((value) => !value);
    else if (command === "toggle-files") setShowFiles((value) => !value);
    else if (command === "toggle-comments") setShowComments((value) => !value);
    else if (command === "expand-diff" && diffAll()) setExpanded(true);
    else if (command === "collapse-diff" && diffAll()) setExpanded(false);
    else if (command === "refresh") location.reload();
    else if (command === "cancel") cancelComment();
  });

  useKeyboard({
    run: runCommand,
    escape: batched(() => {
      if (find.open()) {
        find.close();
        focusViewer();
      } else if (dialog()) closeDialog();
      else if (editing() || range() || fileCommentPath()) cancelComment();
      else return false;
      return true;
    }),
    dialogOpen: () => !!dialog(),
  });

  const summary = () => {
    const count = paths().length;
    const unreviewed = order().filter((path) => !reviewedInView()?.includes(path)).length;
    return `${count} ${count === 1 ? "file" : "files"} · ${unreviewed} unreviewed`;
  };
  const codeView = () => (
    <CodeView<Comment>
      ref={(instance) => {
        // A remounted all-files diff scrolls to its file again.
        if (!instance) restoredKey = "";
        setViewer(instance);
      }}
      class="code-view"
      items={items()}
      options={options()}
      selectedLines={selectedLines()}
      onSelectedLinesChange={(selection) => setLinePreview(selection)}
      onScroll={diffAll() ? onViewerScroll : undefined}
      onRenderedItemsChange={diffAll() ? (ids) => setVisibleDiffs((current) =>
        current.length === ids.length && current.every((id, index) => id === ids[index]) ? current : ids) : undefined}
      renderCustomHeader={diffAll() ? (item) => (
        <DiffFileHeader
          path={item.id}
          title={isMessage(item.id) ? `Commit message · ${comparison().target.slice(0, 7)}` : ""}
          href={fileHref(item.id)}
          stats={entries().find((entry) => entry.path === item.id)}
          notice={noticeFor(item.id)}
          onRetry={failures()[item.id] ? () => setDiffErrors((current) => ({
            key: allKey(), paths: Object.fromEntries(Object.entries(current?.paths || {}).filter(([path]) => path !== item.id)),
          })) : undefined}
          current={item.id === selected()}
          reviewed={reviewedInView()?.includes(item.id) || false}
          reviewDisabled={loading() || comparing()}
          onSelect={() => select(item.id)}
          onToggleReviewed={() => togglePathReviewed(item.id, item.id === selected())}
          onComment={() => openFileComment(item.id)}
        />
      ) : undefined}
      renderAnnotation={({ metadata: comment }) => (
        <button
          class="comment-marker"
          aria-label={`Open comment on ${reference(comment)}`}
          onClick={batched(() => {
            setShowComments(true);
            setHighlight(comment);
            requestAnimationFrame(() => {
              const card = document.getElementById(
                `comment-${comment.id}`,
              );
              card?.scrollIntoView({ block: "nearest" });
              card?.focus({ preventScroll: true });
            });
          })}
        >
          ▤ &nbsp; {reference(comment)} · {comment.text}
        </button>
      )}
    />
  );
  // Remounts the viewer with its view, as each view restores its own scroll.
  const paneKey = createMemo(() => diffAll()
    ? `${tab()}:${comparison().base}:${comparison().target}:${viewerMode()}`
    : `${tab()}:${selected()}:${comparison().base}:${comparison().target}:${viewerMode()}`);

  return (
    <div class="app">
      <header class="topbar">
        <span
          class="repo-name"
          title={info().root}
          style={{ "--repo-hue": String(nameHue(info().name)) }}
        >
          {info().name}
        </span>
        <Show when={info().branch}>
          <span class="branch">⑂ {info().branch}</span>
        </Show>
        <ReviewPalette
          tab={tab()}
          comparison={comparison()}
          mode={mode()}
          from={from()}
          to={to()}
          commits={info().commits}
          upstream={info().upstream}
          isGit={info().isGit}
          comparing={comparing()}
          onFiles={() => changeTab("files")}
          onWorking={batched(() => {
            changeTab("changes", false);
            void compare("working");
          })}
          onCommit={batched((value: string) => {
            setTo(value);
            changeTab("changes", false);
            void compare("commit", { to: value });
          })}
          onRangeDraft={batched((nextFrom: string, nextTo: string) => {
            setMode("range");
            setFrom(nextFrom);
            setTo(nextTo);
          })}
          onRange={batched(() => {
            changeTab("changes", false);
            void compare("range");
          })}
          openRequest={reviewPickerRequest()}
        />
        <button
          class="refresh"
          onClick={() => location.reload()}
          title="Reload files and commits; keep your view and saved comments"
        >
          ↻ <span>Refresh</span>
        </button>
        <div class="top-actions">
          <button
            class="finder-trigger"
            title="Find a file (F)"
            onClick={() => setDialog("finder")}
          >
            <span aria-hidden="true">⌕</span>
            Find file
            <kbd>F</kbd>
          </button>
          <button
            class="shortcut-trigger"
            aria-label="Command launcher"
            title="Command launcher (? or Cmd+K)"
            onClick={() => setDialog("commands")}
          >
            ?
          </button>
          <button class="clear" onClick={clearReview}>
            Clear
          </button>
          <button
            class="primary copy"
            disabled={!comments().length}
            onClick={copyPrompt}
          >
            {copyLabel()}
            <span class="count">{comments().length}</span>
          </button>
        </div>
      </header>
      <div
        class={`workspace${showFiles() ? "" : " hide-files"}${showComments() ? "" : " hide-comments"}`}
        style={{
          "--files-size": filesWidth() ? `${filesWidth()}px` : undefined,
          "--comments-size": commentsWidth() ? `${commentsWidth()}px` : undefined,
        }}
      >
        <div class="panel-rail files" hidden={showFiles()}>
          <button
            class="panel-toggle"
            aria-label="Show file browser"
            title="Show file browser"
            aria-controls="file-browser"
            onClick={() => setShowFiles(true)}
          >
            ›
          </button>
        </div>
        <Sidebar
          tab={tab()}
          paths={paths()}
          entries={entries()}
          refresh={contentRevision()}
          hasMessage={hasMessage()}
          reviewed={reviewedInView()}
          reviewScope={reviewScope()}
          selected={selected()}
          onSelect={select}
          fileHref={fileHref}
          root={info().root}
          search={search()}
          onSearch={setSearch}
          collapsed={collapsed()}
          onCollapsedChange={setCollapsed}
          onToggleReviewed={togglePathReviewed}
          onToggleDirectoryReviewed={toggleDirectoryReviewed}
          revealSelected={diffAll()}
          treeOrder={treeOrder}
          onHide={() => setShowFiles(false)}
          onResize={setFilesWidth}
          hidden={!showFiles()}
        />
        <main class="main">
          <Show when={find.open()}>
            <TextSearchBar
              search={find}
              status={searchAll() ? searchPending()
                ? `Searching ${searchPending()} remaining files…`
                : Object.keys(failures()).length ? `${Object.keys(failures()).length} files could not be searched` : undefined
                : undefined}
              onClose={batched(() => {
                find.close();
                focusViewer();
              })}
            />
          </Show>
          <FileHeading
            path={messageView() || paths().includes(selected()) ? selected() : ""}
            title={messageView() ? `Commit message · ${comparison().target.slice(0, 7)}` : ""}
            summary={diffAll() ? summary() : undefined}
            href={href}
            showModes={tab() === "changes" && !messageView()}
            viewerMode={viewerMode()}
            onViewerMode={changeViewerMode}
            diffView={diffAll()}
            split={split()}
            onSplit={setSplit}
            expandable={diffAll()}
            expanded={expanded()}
            onToggleExpanded={() => setExpanded((value) => !value)}
            wrap={wrap()}
            onToggleWrap={() => setWrap((value) => !value)}
            reviewed={selectedReviewed()}
            reviewDisabled={loading() || comparing()}
            onToggleReviewed={toggleReviewed}
            onComment={() => openFileComment(selected())}
          />
          <Show when={error()}>
            <div role="alert" class="error">
              {error()}
            </div>
          </Show>
          <Show when={paneKey()} keyed>
            <div
              class={`code-pane${diffAll() ? " all-files" : ""}`}
              onPointerCancel={() => setLinePreview(undefined)}
            >
              <Switch>
                <Match when={loading() || comparing() || restoring()}>
                  <div class="empty">
                    <p>Loading…</p>
                  </div>
                </Match>
                <Match when={!info().isGit && tab() === "changes"}>
                  <div class="empty">
                    <h2>Not a Git repository</h2>
                    <p>You can still browse files and leave comments.</p>
                  </div>
                </Match>
                <Match when={diffAll() ? !order().length : tab() === "changes" && !paths().length && !messageView()}>
                  <div class="empty">
                    <span class="empty-symbol">✓</span>
                    <h2>No changes to review</h2>
                    <p>
                      {compareLabel() === "Uncommitted changes"
                        ? "You have no uncommitted changes."
                        : "These revisions have no file differences."}
                      <br />
                      New changes appear when you refresh.
                    </p>
                  </div>
                </Match>
                <Match when={diffAll()}>
                  {codeView()}
                </Match>
                <Match when={!messageView() && (!selected() || !paths().includes(selected()))}>
                  <div class="empty">
                    <span class="empty-symbol">⌘</span>
                    <h2>A little space for a better review.</h2>
                    <p>
                      Choose a file on the left.
                      <br />
                      Select a line number to leave a comment.
                    </p>
                    <div class="empty-steps">
                      <span>01 &nbsp; Read</span>
                      <span>02 &nbsp; Comment</span>
                      <span>03 &nbsp; Copy</span>
                    </div>
                  </div>
                </Match>
                <Match when={notice()}>
                  <div class="empty">
                    <h2>Preview unavailable</h2>
                    <p>{notice()}</p>
                  </div>
                </Match>
                <Match when={content() && singleSide() && !fileSource()}>
                  <div class="empty">
                    <h2>File does not exist in the {viewerMode()} revision</h2>
                    <p>{viewerMode() === "old" ? "This file was added." : "This file was deleted."}</p>
                  </div>
                </Match>
                <Match when={content() && (content()!.newFile || content()!.oldFile)}>
                  {codeView()}
                  <Show when={!fileSource()?.contents}>
                    <p class="empty">Empty file</p>
                  </Show>
                </Match>
                <Match when={content()}>
                  <div class="empty">
                    <p>File no longer exists. Refresh to update the file list.</p>
                  </div>
                </Match>
              </Switch>
            </div>
          </Show>
          <div class="code-footer">
            <span>
              {tab() === "changes"
                ? compareLabel()
                : "Click + to comment · Drag + to select a range"}
            </span>
            <Show when={range()}>
              {(value) => (
                <span>
                  Ln {start()}
                  {end() !== start() ? `–${end()}` : ""}
                  {value().side === "deletions" ? " · old side" : ""}
                </span>
              )}
            </Show>
          </div>
        </main>
        <CommentsPanel
          comments={comments()}
          highlight={highlight()}
          onHighlight={setHighlight}
          onOpen={(comment) => void openComment(comment)}
          editing={editing()}
          draft={draft()}
          onDraftChange={setDraft}
          onEdit={batched((comment: Comment) => {
            setEditing(comment.id);
            setRange(null);
            setFileCommentPath("");
            setDraft(comment.text);
          })}
          onDelete={batched((comment: Comment) => {
            setComments((items) => items.filter((item) => item.id !== comment.id));
            if (editing() === comment.id) cancelComment();
            setCopied(false);
          })}
          onSave={saveComment}
          onCancel={cancelComment}
          generalDraft={generalDraft()}
          onGeneralDraftChange={setGeneralDraft}
          onSaveGeneral={saveGeneralComment}
          newComment={editing() ? null : fileCommentPath() ? {
            reference: fileCommentPath(),
            file: true,
            oldSide: false,
          } : range() && rangePath() ? {
            reference: reference({
              path: rangePath(),
              start: start(),
              end: end(),
              commit: isMessage(rangePath()) ? comparison().target : undefined,
            }),
            oldSide: range()!.side === "deletions",
          } : null}
          errors={[copyError(), storageError()]}
          onPreview={() => setDialog("prompt")}
          onHide={() => setShowComments(false)}
          onResize={setCommentsWidth}
          hidden={!showComments()}
        />
        <div class="panel-rail comments" hidden={showComments()}>
          <button
            class="panel-toggle"
            aria-label="Show comments"
            title="Show comments (M)"
            aria-controls="review-comments"
            onClick={() => setShowComments(true)}
          >
            ‹
          </button>
        </div>
      </div>
      <footer class="statusbar">
        <span>⑂ {info().branch || "Files"}</span>
        <span>{info().isGit ? "Git" : "Folder"} · read-only</span>
        <span class="status-right">
          No auto-refresh
          <span class="status-dot" />
          Refresh when you’re ready.
          <span class="status-dot" />
          rv {__RV_VERSION__}
        </span>
      </footer>
      <Switch>
        <Match when={dialog() === "prompt"}>
          <PromptDialog
            prompt={prompt()}
            copyLabel={copyLabel()}
            onCopy={copyPrompt}
            onClose={closeDialog}
          />
        </Match>
        <Match when={dialog() === "copied"}>
          <CopiedPromptDialog prompt={prompt()} onClear={clearCopiedReview} onClose={closeDialog} />
        </Match>
        <Match when={dialog() === "finder"}>
          <FileFinder
            paths={hasMessage() ? [MESSAGE_PATH, ...paths()] : paths()}
            reviewed={reviewedInView() || []}
            onSelect={select}
            fileHref={fileHref}
            onClose={closeDialog}
          />
        </Match>
        <Match when={dialog() === "commands"}>
          <CommandLauncher
            onClose={closeDialog}
            onChoose={batched((command: Command) => {
              closeDialog();
              runCommand(command);
            })}
          />
        </Match>
        <Match when={dialog() === "line"}>
          <LinePicker
            path={selected()}
            initialTarget={range() ? `${start()}${end() !== start() ? `-${end()}` : ""}` : ""}
            initialSide={singleSide() || (range()?.side === "deletions" ? "deletions" : "additions")}
            showSide={diffAll() && !isMessage(selected())}
            lineCount={(side) => {
              const source = side === "deletions" ? content()?.oldFile : content()?.newFile;
              return source?.contents ? source.contents.split("\n").length : 0;
            }}
            onPick={pickLines}
            onClose={closeDialog}
          />
        </Match>
      </Switch>
    </div>
  );
}
