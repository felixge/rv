import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles, type GitStatus } from "@pierre/trees";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  parseDiffFromFile,
  type CodeViewItem,
  type SelectedLineRange,
} from "@pierre/diffs";
import { formatPrompt, reference } from "./prompt.js";
import "./style.css";

type Entry = {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
};
type Comparison = {
  base: string;
  target: string;
  entries: Entry[];
  message?: string;
};
const MESSAGE_PATH = "\0commit-message";
type Source = { name: string; contents: string; notice?: string } | null;
type Info = {
  root: string;
  name: string;
  isGit: boolean;
  branch: string;
  files: string[];
  working: Comparison;
  commits: { id: string; short: string; subject: string; date: string }[];
};
type Comment = {
  id: string;
  path: string;
  start: number;
  end: number;
  text: string;
  side?: string;
  context: string;
  comparison?: Comparison;
  commit?: string;
};
type Content = { oldFile: Source; newFile: Source };

// Deliberately no polling, focus revalidation, websocket, or filesystem watcher.
const requests = new Map<string, Promise<unknown>>();
function api<T>(
  route: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = `/api/${route}?${new URLSearchParams(params)}`;
  if (!requests.has(url))
    requests.set(
      url,
      fetch(url, { headers: { "X-Difflet": "1" } })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            requests.delete(url);
            throw new Error(data.error);
          }
          return data;
        })
        .catch((error) => {
          requests.delete(url);
          throw error;
        }),
    );
  return requests.get(url) as Promise<T>;
}

const statuses: Record<string, GitStatus> = {
  M: "modified",
  A: "added",
  D: "deleted",
  U: "untracked",
  T: "modified",
};
const treeStyle = themeToTreeStyles({
  type: "light",
  bg: "#f6f7f8",
  fg: "#424750",
  colors: {
    "sideBar.background": "#f6f7f8",
    "list.activeSelectionBackground": "#e1edfa",
    "list.activeSelectionForeground": "#125eaa",
  },
});

function BrowserTree({
  paths,
  entries,
  selected,
  onSelect,
  search,
}: {
  paths: string[];
  entries: Entry[];
  selected: string;
  onSelect: (path: string) => void;
  search: string;
}) {
  const selectRef = useRef(onSelect);
  const syncingSelection = useRef(false);
  selectRef.current = (path) => {
    if (paths.includes(path)) onSelect(path);
  };
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    density: "compact",
    icons: "standard",
    initialSelectedPaths: selected ? [selected] : [],
    onSelectionChange: (items) => {
      if (syncingSelection.current) return;
      const item = items.at(-1);
      if (item) selectRef.current(item);
    },
    gitStatus: entries.map((entry) => ({
      path: entry.path,
      status: statuses[entry.status] || "modified",
    })),
  });
  useEffect(() => {
    model.setSearch(search);
  }, [model, search]);
  useEffect(() => {
    syncingSelection.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selected) model.getItem(path)?.deselect();
    }
    model.getItem(selected)?.select();
    syncingSelection.current = false;
  }, [model, selected, paths]);
  return <FileTree model={model} className="file-tree" style={treeStyle} />;
}

// Keep relative ages stable for this page snapshot; there is no refresh timer.
const reviewTime = Date.now();
const relativeTime = new Intl.RelativeTimeFormat("en", { style: "narrow" });
function commitAge(date: string) {
  const seconds = (new Date(date).getTime() - reviewTime) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size)
      return relativeTime.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

function CommitPicker({
  label,
  value,
  commits,
  onChange,
}: {
  label: string;
  value: string;
  commits: Info["commits"];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = commits.find((commit) => commit.id === value);
  const search = query.trim();
  const choices = commits.filter((commit) =>
    `${commit.id} ${commit.subject}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const options: {
    value: string;
    title: string;
    detail: string;
    date?: string;
  }[] = choices.map((commit) => ({
    value: commit.id,
    title: commit.subject,
    detail: commit.short,
    date: commit.date,
  }));
  if (
    search &&
    !commits.some((commit) => commit.id === search || commit.short === search)
  ) {
    options.push({
      value: search,
      title: `Use ref: ${search}`,
      detail: "Git ref",
    });
  }
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);
  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <div
      className="commit-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="commit-trigger"
        aria-label={`${label} revision`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          selected
            ? `${selected.subject} (${selected.short}) · ${selected.date.replace("T", " ")}`
            : value
        }
        onClick={() => {
          setQuery("");
          setActive(0);
          setOpen(!open);
        }}
      >
        <span className="revision-label">{label}</span>
        <span className="revision-value">
          {selected?.subject || value || "Choose commit"}
        </span>
        {selected && <code>{selected.short}</code>}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className="commit-popover"
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()} revision`}
        >
          <input
            autoFocus
            role="combobox"
            aria-label={
              label === "Commit"
                ? "Search commits"
                : `Search ${label.toLowerCase()} commits`
            }
            aria-expanded="true"
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={
              options[active] ? `${id}-${active}` : undefined
            }
            placeholder="Search commits or enter a Git ref…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) =>
                  Math.max(
                    0,
                    Math.min(
                      options.length - 1,
                      current + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (options[active]) choose(options[active].value);
              }
            }}
          />
          <div
            className="commit-options"
            id={id}
            role="listbox"
            aria-label={`${label} commits`}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${id}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                className={index === active ? "active" : ""}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span>{option.title}</span>
                <code>{option.detail}</code>
                {option.date && (
                  <time
                    className="commit-time"
                    dateTime={option.date}
                    title={option.date.replace("T", " ")}
                  >
                    {commitAge(option.date)}
                  </time>
                )}
              </button>
            ))}
          </div>
          <p>Search by message or hash · Or enter a branch, tag, or HEAD~2</p>
        </div>
      )}
    </div>
  );
}

function PanelResizeHandle({
  side,
  onResize,
}: {
  side: "files" | "comments";
  onResize: (width: number) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const minimum = side === "files" ? 160 : 220;
  const maximum = Math.min(520, window.innerWidth * 0.35);
  const direction = side === "files" ? 1 : -1;
  const resize = (next: number) =>
    onResize(Math.round(Math.max(minimum, Math.min(maximum, next))));
  useEffect(() => {
    const panel = handle.current!.parentElement!;
    const observer = new ResizeObserver(() => {
      if (panel.clientWidth) setWidth(panel.getBoundingClientRect().width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={handle}
      className={`resize-handle ${side}${dragging ? " dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${side === "files" ? "file browser" : "comments"}`}
      aria-orientation="vertical"
      aria-controls={side === "files" ? "file-browser" : "review-comments"}
      aria-valuemin={minimum}
      aria-valuemax={Math.floor(maximum)}
      aria-valuenow={Math.round(width)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current)
          resize(
            drag.current.width + direction * (event.clientX - drag.current.x),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          resize(width + direction * (event.key === "ArrowRight" ? 20 : -20));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          resize(event.key === "Home" ? minimum : maximum);
        }
      }}
    />
  );
}

function App() {
  const [info, setInfo] = useState<Info>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<Info>("info")
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, []);
  if (!info)
    return (
      <div className="startup">
        <span className="brand-mark">d/</span>
        <h1>difflet</h1>
        <p role="status">{error || "Opening your repository…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  return <Review info={info} />;
}

function Review({ info }: { info: Info }) {
  const storageKey = `difflet:comments:${info.root}`;
  const reviewedStorageKey = `difflet:reviewed:${info.root}`;
  const [reviewed, setReviewed] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem(reviewedStorageKey) || "{}");
    } catch {
      return {};
    }
  });
  const [search, setSearch] = useState("");
  const [comments, setComments] = useState<Comment[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "[]");
    } catch {
      return [];
    }
  });
  const [storageError, setStorageError] = useState("");
  const [clearedComments, setClearedComments] = useState<Comment[] | null>(
    null,
  );
  useEffect(() => {
    try {
      // Mutable views are only reviewed for this page snapshot.
      localStorage.setItem(
        reviewedStorageKey,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(reviewed).filter(
              ([scope]) => scope !== "files" && scope !== "working",
            ),
          ),
        ),
      );
    } catch {
      setStorageError(
        "Browser storage is unavailable. Review progress will not survive refresh.",
      );
    }
  }, [reviewed, reviewedStorageKey]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(comments));
    } catch {
      setStorageError(
        "Browser storage is unavailable. Copy your comments before closing.",
      );
    }
  }, [comments, storageKey]);
  const [tab, setTab] = useState<"files" | "changes">("files");
  const [mode, setMode] = useState("working");
  const [from, setFrom] = useState(
    info.commits[1]?.id || info.commits[0]?.id || "",
  );
  const [to, setTo] = useState(info.commits[0]?.id || "");
  const [comparison, setComparison] = useState<Comparison>(info.working);
  const [compareLabel, setCompareLabel] = useState("Working tree");
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState<Content>();
  const [loading, setLoading] = useState(false);
  const [split, setSplit] = useState(false);
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const [showComments, setShowComments] = useState(true);
  const [filesWidth, setFilesWidth] = useState<number>();
  const [commentsWidth, setCommentsWidth] = useState<number>();
  const [highlight, setHighlight] = useState<Comment | null>(null);
  const [pendingComment, setPendingComment] = useState<Comment | null>(null);
  const viewer = useRef<CodeViewHandle<Comment, undefined>>(null);
  const comparisonRequest = useRef(0);
  const paths = useMemo(
    () =>
      tab === "files"
        ? info.files
        : comparison.entries.map((entry) => entry.path),
    [tab, info.files, comparison],
  );
  const entries = tab === "files" ? info.working.entries : comparison.entries;
  const messageView =
    tab === "changes" &&
    selected === MESSAGE_PATH &&
    comparison.message !== undefined;
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
  useEffect(() => setSearch(""), [reviewScope]);
  const select = useCallback(
    (path: string) => {
      if (path === selected) return;
      setSelected(path);
      setRange(null);
      setHighlight(null);
      setPendingComment(null);
    },
    [selected],
  );

  useEffect(() => {
    if (messageView) {
      setContent({
        oldFile: null,
        newFile: { name: "COMMIT_MESSAGE.txt", contents: comparison.message! },
      });
      setLoading(false);
      setError("");
      return;
    }
    if (!selected || !paths.includes(selected)) {
      setContent(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    setContent(undefined);
    const load =
      tab === "files"
        ? api<Source>("file", { path: selected, ref: "" }).then((newFile) => ({
            oldFile: null,
            newFile,
          }))
        : Promise.all([
            api<Source>("file", { path: selected, ref: comparison.base }),
            api<Source>("file", { path: selected, ref: comparison.target }),
          ]).then(([oldFile, newFile]) => ({ oldFile, newFile }));
    load
      .then((value) => {
        if (active) setContent(value);
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
  }, [selected, paths, tab, comparison, messageView]);

  async function compare(nextMode: string, nextTo = to) {
    const id = ++comparisonRequest.current;
    setMode(nextMode);
    setComparing(true);
    setError("");
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
    try {
      const result =
        nextMode === "working"
          ? info.working
          : await api<Comparison>("compare", {
              mode: nextMode,
              from,
              to: nextTo,
            });
      if (id !== comparisonRequest.current) return;
      setComparison(result);
      setCompareLabel(
        nextMode === "working"
          ? "Working tree"
          : nextMode === "commit"
            ? `Commit ${result.target.slice(0, 7)}`
            : `${result.base.slice(0, 7)} → ${result.target.slice(0, 7)}`,
      );
      setSelected((current) =>
        nextMode === "commit"
          ? MESSAGE_PATH
          : result.entries.some((entry) => entry.path === current)
            ? current
            : result.entries[0]?.path || "",
      );
    } catch (e) {
      if (id === comparisonRequest.current) setError((e as Error).message);
    } finally {
      if (id === comparisonRequest.current) setComparing(false);
    }
  }

  const onSelection = useCallback((value: SelectedLineRange | null) => {
    setHighlight(null);
    if (value) setShowComments(true);
    // A reference must use one file-side's coordinates, never mixed old/new numbers.
    setRange(
      value?.endSide && value.endSide !== value.side
        ? { ...value, end: value.start, endSide: value.side }
        : value,
    );
  }, []);
  const options = useMemo(
    () => ({
      theme: "light-plus" as const,
      themeType: "light" as const,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      enableLineSelection: true,
      onLineSelected: onSelection,
      itemMetrics: { lineHeight: 23 },
      pointerEventsOnScroll: true,
      overflow: "scroll" as const,
      disableFileHeader: true,
    }),
    [split, onSelection],
  );
  const prompt = formatPrompt(comments);
  const notice = content?.newFile?.notice || content?.oldFile?.notice;
  const start = range ? Math.min(range.start, range.end) : 1;
  const end = range ? Math.max(range.start, range.end) : 1;

  function matchesView(comment: Comment) {
    return (
      comment.path === selected &&
      (tab === "files"
        ? comment.context === "File"
        : comment.comparison
          ? comment.comparison.base === comparison.base &&
            comment.comparison.target === comparison.target
          : comment.context === compareLabel)
    );
  }
  function commentRange(comment: Comment): SelectedLineRange {
    return {
      start: comment.start,
      end: comment.end,
      ...(tab === "changes" && !messageView
        ? {
            side:
              comment.side === "deletions"
                ? ("deletions" as const)
                : ("additions" as const),
          }
        : {}),
    };
  }
  const fileDiff = useMemo(
    () =>
      content &&
      tab === "changes" &&
      !messageView &&
      !notice &&
      (content.oldFile || content.newFile)
        ? parseDiffFromFile(content.oldFile, content.newFile)
        : null,
    [content, tab, notice, messageView],
  );
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
      ? (tab === "files" || messageView) && content.newFile
        ? [
            {
              type: "file",
              id: selected,
              file: content.newFile,
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

  useEffect(() => {
    if (!pendingComment || loading || comparing || !content || !viewer.current)
      return;
    viewer.current.scrollTo({
      type: "range",
      id: pendingComment.path,
      range: commentRange(pendingComment),
      align: "center",
    });
    setPendingComment(null);
  }, [pendingComment, content, loading, comparing]);

  async function openComment(comment: Comment) {
    const id = ++comparisonRequest.current;
    setComparing(false);
    setRange(null);
    setHighlight(comment);
    setError("");
    if (matchesView(comment)) {
      setPendingComment(comment);
      return;
    }
    setContent(undefined);
    if (comment.context === "File") {
      setTab("files");
      setComparing(false);
    } else {
      try {
        const nextMode =
          comment.context === "Working tree"
            ? "working"
            : comment.context.startsWith("Commit ")
              ? "commit"
              : "range";
        const [base, target] = comment.context.split(" → ");
        const result =
          comment.comparison ||
          (nextMode === "working"
            ? info.working
            : await api<Comparison>("compare", {
                mode: nextMode,
                from: base,
                to: nextMode === "commit" ? comment.context.slice(7) : target,
              }));
        if (id !== comparisonRequest.current) return;
        setComparison(result);
        setCompareLabel(comment.context);
        setMode(nextMode);
        setFrom(result.base);
        setTo(result.target || info.commits[0]?.id || "");
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

  async function copyPrompt() {
    setCopyError("");
    // Synchronous copy also works when the async clipboard API is blocked by
    // an embedding page's permissions policy. Never open a dialog on failure.
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    textarea.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(textarea);
    const focused = document.activeElement as HTMLElement | null;
    textarea.select();
    let success = false;
    try {
      success = document.execCommand("copy");
    } catch {
      /* Try Clipboard API below. */
    }
    textarea.remove();
    focused?.focus({ preventScroll: true });
    try {
      if (!success) await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(
        "Clipboard blocked by your browser. Use Preview to select and copy the text.",
      );
    }
  }

  function changeTab(value: "files" | "changes") {
    setTab(value);
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">d/</span>difflet
        </div>
        <span className="divider" />
        <span className="repo-name" title={info.root}>
          {info.name}
        </span>
        {info.branch && <span className="branch">⑂ {info.branch}</span>}
        <div className="top-actions">
          <span className="local-label">
            <i /> local review
          </span>
          <button
            className="primary copy"
            disabled={!comments.length}
            onClick={copyPrompt}
          >
            {copied ? "✓ Copied" : "Copy Prompt"}
            <span className="count">{comments.length}</span>
          </button>
        </div>
      </header>
      <div
        className={`workspace${showFiles ? "" : " hide-files"}${showComments ? "" : " hide-comments"}`}
        style={
          {
            "--files-size": filesWidth && `${filesWidth}px`,
            "--comments-size": commentsWidth && `${commentsWidth}px`,
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
          <nav className="tabs">
            <button
              className={tab === "files" ? "active" : ""}
              onClick={() => changeTab("files")}
            >
              Files <span>{info.files.length}</span>
            </button>
            <button
              className={tab === "changes" ? "active" : ""}
              onClick={() => changeTab("changes")}
            >
              Changes <span>{comparison.entries.length}</span>
            </button>
            <button
              className="panel-toggle"
              aria-label="Hide file browser"
              title="Hide file browser"
              aria-controls="file-browser"
              onClick={() => setShowFiles(false)}
            >
              ‹
            </button>
          </nav>
          <div className="search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Find a file"
              placeholder="Find a file…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {[false, true].map((done) => {
            if (done && !reviewedCount) return null;
            const groupPaths = done ? reviewedPaths : unreviewedPaths;
            const groupEntries = entries.filter((entry) =>
              groupPaths.includes(entry.path),
            );
            const additions = groupEntries.reduce(
              (sum, entry) => sum + (entry.additions || 0),
              0,
            );
            const deletions = groupEntries.reduce(
              (sum, entry) => sum + (entry.deletions || 0),
              0,
            );
            const unavailable = groupEntries.some(
              (entry) => entry.additions == null || entry.deletions == null,
            );
            return (
              <section
                key={String(done)}
                className={`file-section${groupPaths.length ? "" : " no-files"}`}
                aria-label={done ? "Reviewed" : "Unreviewed"}
              >
                <div className="sidebar-caption">
                  <span className="section-label">
                    {done
                      ? "Reviewed"
                      : tab === "files"
                        ? "Explorer"
                        : "Changed files"}
                    <span className="file-count">
                      {done
                        ? reviewedCount
                        : groupPaths.length +
                          (hasMessage && !messageReviewed ? 1 : 0)}
                    </span>
                  </span>
                  <span
                    className="line-stats"
                    aria-label={`${additions} lines added, ${deletions} lines removed`}
                    title={`Lines changed${unavailable ? "; excludes files with unavailable line counts (binary or unpreviewable text)" : ""}`}
                  >
                    <span className="lines-added">+{additions}</span>
                    <span className="lines-removed">−{deletions}</span>
                  </span>
                </div>
                {hasMessage &&
                  messageReviewed === done &&
                  "commit message".includes(search.toLowerCase()) && (
                    <button
                      className={`message-nav${messageView ? " active" : ""}`}
                      aria-pressed={messageView}
                      onClick={() => select(MESSAGE_PATH)}
                    >
                      <svg
                        aria-hidden="true"
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinejoin="round"
                      >
                        <path d="M9.5 1.5h-6v13h9v-10z M9.5 1.5v3h3 M5.5 7.5h5 M5.5 10.5h5" />
                      </svg>
                      Commit message
                    </button>
                  )}
                {!!groupPaths.length && (
                  <BrowserTree
                    key={`${reviewScope}:${JSON.stringify(groupPaths)}`}
                    paths={groupPaths}
                    entries={entries}
                    selected={selected}
                    onSelect={select}
                    search={search}
                  />
                )}
                {!done &&
                  !groupPaths.length &&
                  !(hasMessage && !messageReviewed) && (
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
          <div className="review-toolbar">
            {tab === "changes" ? (
              <>
                <select
                  aria-label="Review source"
                  value={mode}
                  disabled={!info.isGit}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "range") setMode(value);
                    else void compare(value);
                  }}
                >
                  <option value="working">Working tree</option>
                  <option value="commit" disabled={!info.commits.length}>
                    Recent commit
                  </option>
                  <option value="range" disabled={!info.commits.length}>
                    Commit range
                  </option>
                </select>
                {mode === "commit" && (
                  <CommitPicker
                    label="Commit"
                    commits={info.commits}
                    value={to}
                    onChange={(value) => {
                      setTo(value);
                      void compare("commit", value);
                    }}
                  />
                )}
                {mode === "range" && (
                  <form
                    className="range-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void compare("range");
                    }}
                  >
                    <CommitPicker
                      label="Base"
                      commits={info.commits}
                      value={from}
                      onChange={setFrom}
                    />
                    <span aria-hidden="true">→</span>
                    <CommitPicker
                      label="Target"
                      commits={info.commits}
                      value={to}
                      onChange={setTo}
                    />
                    <button disabled={comparing}>Compare</button>
                  </form>
                )}
              </>
            ) : (
              <span className="toolbar-label">Repository files</span>
            )}
            <button
              className="refresh"
              onClick={() => location.reload()}
              title="Reload files and commits; keep saved comments"
            >
              ↻ <span>Refresh</span>
            </button>
          </div>
          <div className="file-heading">
            <span className="file-path">
              {messageView
                ? `Commit message · ${comparison.target.slice(0, 7)}`
                : selected && paths.includes(selected)
                  ? selected
                  : "No file selected"}
            </span>
            {tab === "changes" && !messageView && (
              <div className="segmented">
                <button aria-pressed={!split} onClick={() => setSplit(false)}>
                  Unified
                </button>
                <button aria-pressed={split} onClick={() => setSplit(true)}>
                  Split
                </button>
              </div>
            )}
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
                onClick={() =>
                  setReviewed((current) => ({
                    ...current,
                    [reviewScope]: selectedReviewed
                      ? (current[reviewScope] || []).filter(
                          (path) => path !== selected,
                        )
                      : [...(current[reviewScope] || []), selected],
                  }))
                }
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
            key={`${tab}:${selected}:${comparison.base}:${comparison.target}`}
          >
            {loading || comparing ? (
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
                  {compareLabel === "Working tree"
                    ? "Your working tree is clean."
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
            ) : content && (content.newFile || content.oldFile) ? (
              <>
                <CodeView
                  ref={viewer}
                  className="code-view"
                  items={items}
                  options={options}
                  selectedLines={
                    highlightedRange
                      ? { id: selected, range: highlightedRange }
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
                {!(content.newFile?.contents || content.oldFile?.contents) && (
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
              title="Hide comments"
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
            <button
              className="text-button"
              disabled={!comments.length}
              onClick={() => {
                setClearedComments(comments);
                setComments([]);
                setHighlight(null);
                setPendingComment(null);
                setCopied(false);
                if (editing) {
                  setEditing(undefined);
                  setDraft("");
                }
              }}
            >
              Clear Comments
            </button>
          </div>
          {clearedComments && (
            <div className="clear-notice" role="status">
              Comments cleared.
              <button
                className="text-button"
                onClick={() => {
                  setComments((items) => [...clearedComments, ...items]);
                  setClearedComments(null);
                  setCopied(false);
                }}
              >
                Undo
              </button>
            </div>
          )}
          <div className="comments-body">
            {copyError && (
              <p role="alert" className="error">
                {copyError}
              </p>
            )}
            {storageError && (
              <p role="alert" className="error">
                {storageError}
              </p>
            )}
            {!comments.length && !range && (
              <div className="comment-empty">
                <span className="comment-icon">▤</span>
                <h3>Your thoughts, ready for an agent.</h3>
                <p>
                  Select a line in the code to add a comment. Collect your
                  feedback here, then copy it as one prompt.
                </p>
              </div>
            )}
            {comments.map((comment, index) => (
              <article
                className={`comment${highlight?.id === comment.id ? " highlighted" : ""}`}
                key={comment.id}
                id={`comment-${comment.id}`}
                tabIndex={0}
                aria-label={`Comment on ${reference(comment)}`}
                onMouseEnter={() => setHighlight(comment)}
                onMouseLeave={() => setHighlight(null)}
                onFocus={() => setHighlight(comment)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setHighlight(null);
                }}
                onClick={(event) => {
                  if (
                    !(event.target as HTMLElement).closest("button, textarea")
                  )
                    void openComment(comment);
                }}
                onKeyDown={(event) => {
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
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      saveComment();
                    }
                  }}
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
            title="Show comments"
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
        </span>
      </footer>
      {showPrompt && (
        <div className="modal-backdrop" onClick={() => setShowPrompt(false)}>
          <section
            className="prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Prompt preview"
            onClick={(event) => event.stopPropagation()}
          >
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
              <span>Exactly what gets copied.</span>
              <button className="primary" onClick={copyPrompt}>
                {copied ? "✓ Copied" : "Copy Prompt"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
