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
import { CodeView, WorkerPoolContextProvider, type CodeViewHandle } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  parseDiffFromFile,
  type CodeViewItem,
  type FileDiffMetadata,
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
type Source = { name: string; contents: string; notice?: string; cacheKey?: string } | null;
type Info = {
  root: string;
  name: string;
  isGit: boolean;
  branch: string;
  files: string[];
  lineCounts: Record<string, number | null>;
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
// The server-side disk cache, loaded once and saved back debounced.
type SavedState = {
  view?: Record<string, unknown>;
  reviewed?: Record<string, string[]>;
  comments?: Comment[];
};

type Shortcut = {
  keys: string[];
  label: string;
  category: "Navigate" | "Review" | "View" | "General";
};
const shortcuts: Shortcut[] = [
  { keys: ["?"], label: "Show keyboard shortcuts", category: "General" },
  { keys: ["F"], label: "Find a file", category: "Navigate" },
  { keys: ["/"], label: "Search files", category: "Navigate" },
  { keys: ["J"], label: "Next file", category: "Navigate" },
  { keys: ["K"], label: "Previous file", category: "Navigate" },
  { keys: ["G", "F"], label: "Open File Browser", category: "Navigate" },
  { keys: ["G", "C"], label: "Review most recent commit", category: "Navigate" },
  { keys: ["G", "U"], label: "Review uncommitted changes", category: "Navigate" },
  { keys: ["G", "R"], label: "Open review palette", category: "Navigate" },
  { keys: ["L"], label: "Comment on a line or range", category: "Review" },
  { keys: ["R"], label: "Toggle reviewed", category: "Review" },
  { keys: ["U"], label: "Undo last action", category: "Review" },
  { keys: ["⌘/Ctrl", "Enter"], label: "Save comment", category: "Review" },
  { keys: ["Y"], label: "Copy review prompt", category: "Review" },
  { keys: ["P"], label: "Preview review prompt", category: "Review" },
  { keys: ["V"], label: "Toggle unified / split diff", category: "View" },
  { keys: ["W"], label: "Toggle long line wrapping", category: "View" },
  { keys: ["B"], label: "Toggle file browser", category: "View" },
  { keys: ["C"], label: "Toggle comments", category: "View" },
  { keys: ["Shift", "R"], label: "Refresh repository", category: "General" },
  { keys: ["Esc"], label: "Close or cancel", category: "General" },
];
function compareTreeSegments(left: string, right: string) {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  const leftTokens = leftLower.match(/\d+|\D+/g) || [];
  const rightTokens = rightLower.match(/\d+|\D+/g) || [];
  for (let index = 0; index < Math.min(leftTokens.length, rightTokens.length); index++) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === rightToken) continue;
    const leftNumber = /^\d+$/.test(leftToken);
    const rightNumber = /^\d+$/.test(rightToken);
    if (leftNumber && rightNumber) {
      const comparison = Number(leftToken) - Number(rightToken);
      if (comparison) return comparison;
      continue;
    }
    return leftToken < rightToken ? -1 : 1;
  }
  if (leftTokens.length !== rightTokens.length)
    return leftTokens.length - rightTokens.length;
  if (leftLower !== rightLower) return leftLower < rightLower ? -1 : 1;
  return left < right ? -1 : left === right ? 0 : 1;
}

function compareTreePaths(left: string, right: string) {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const sharedDepth = Math.min(leftParts.length, rightParts.length);
  for (let depth = 0; depth < sharedDepth; depth++) {
    const leftPart = leftParts[depth];
    const rightPart = rightParts[depth];
    if (leftPart === rightPart) continue;
    const leftIsDirectory = depth < leftParts.length - 1;
    const rightIsDirectory = depth < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    const comparison = compareTreeSegments(leftPart, rightPart);
    if (comparison) return comparison;
    return leftPart < rightPart ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

function treeOrdered(paths: string[]) {
  return [...paths].sort(compareTreePaths);
}

function fuzzyScore(path: string, query: string) {
  const candidate = path.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let score = 0;
  let previous = -1;
  for (const character of needle) {
    const index = candidate.indexOf(character, previous + 1);
    if (index < 0) return null;
    score += index - previous - 1;
    if (previous >= 0 && index === previous + 1) score -= 2;
    previous = index;
  }
  const filename = candidate.slice(candidate.lastIndexOf("/") + 1);
  if (filename.startsWith(needle)) score -= 8;
  else if (filename.includes(needle)) score -= 4;
  return score;
}

function FileFinder({
  paths,
  reviewed,
  onSelect,
  onClose,
}: {
  paths: string[];
  reviewed: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = useMemo(
    () => paths
      .map((path, order) => ({ path, order, score: fuzzyScore(path, query) }))
      .filter((match): match is { path: string; order: number; score: number } =>
        match.score !== null,
      )
      .sort((left, right) =>
        left.score - right.score ||
        compareTreePaths(left.path, right.path) ||
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
              <button
                key={match.path}
                className={index === active ? "active" : ""}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(match.path)}
              >
                <span className="finder-path">{match.path}</span>
                <span className={`finder-state${done ? " reviewed" : ""}`}>
                  {done ? "✓ Reviewed" : "Unreviewed"}
                </span>
              </button>
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

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const matches = shortcuts.filter((shortcut) =>
    `${shortcut.label} ${shortcut.category} ${shortcut.keys.join(" ")}`
      .toLowerCase()
      .includes(normalized),
  );
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="shortcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcut-heading">
          <div>
            <h2 id="shortcut-title">Keyboard shortcuts</h2>
            <p>Keep your hands on the keyboard.</p>
          </div>
          <button onClick={onClose} aria-label="Close keyboard shortcuts">✕</button>
        </div>
        <div className="shortcut-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoFocus
            aria-label="Search keyboard shortcuts"
            placeholder="Search shortcuts…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="shortcut-list">
          {matches.map((shortcut) => (
            <div className="shortcut-row" key={shortcut.label}>
              <span className="shortcut-label">
                {shortcut.label}
                <small>{shortcut.category}</small>
              </span>
              <span className="shortcut-keys">
                {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              </span>
            </div>
          ))}
          {!matches.length && <p className="shortcut-empty">No shortcuts found.</p>}
        </div>
        <p className="shortcut-note">Shortcuts are paused while you type in a field.</p>
      </section>
    </div>
  );
}

function readView(info: Info, stored: unknown) {
  const defaults = {
    tab: "files",
    mode: "working",
    from: info.commits[1]?.id || info.commits[0]?.id || "",
    to: info.commits[0]?.id || "",
    selected: "",
    search: "",
    split: false,
    wrap: false,
    showFiles: true,
    showComments: true,
    filesWidth: 0,
    commentsWidth: 0,
    collapsed: [] as string[],
    // The applied comparison is distinct from unsubmitted range picker values.
    appliedMode: "working",
    base: "",
    target: "",
  };
  try {
    const view: any = stored || {};
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      if (typeof view?.[key] !== typeof defaults[key]) continue;
      if (
        key === "collapsed" &&
        (!Array.isArray(view[key]) ||
          !view[key].every((path: unknown) => typeof path === "string"))
      ) continue;
      if (key === "tab" && !["files", "changes"].includes(view[key])) continue;
      if (
        (key === "mode" || key === "appliedMode") &&
        !["working", "commit", "range"].includes(view[key])
      ) continue;
      Object.assign(defaults, { [key]: view[key] });
    }
  } catch {
    // Missing, obsolete or malformed saved state falls back to current defaults.
  }
  // CLI options arrive as query params and override the saved view on first load.
  const params = new URLSearchParams(location.search);
  const urlMode = params.get("mode") || "";
  if (["working", "commit", "range"].includes(urlMode)) {
    Object.assign(defaults, {
      tab: "changes",
      mode: urlMode,
      from: params.get("from") || "",
      to: params.get("to") || "",
      // Match the in-app pickers, which always open on the first change.
      selected:
        urlMode === "working" ? info.working.entries[0]?.path || "" : "",
      appliedMode: urlMode,
      base: params.get("from") || "",
      target: params.get("to") || "",
    });
  }
  return defaults;
}

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
      fetch(url, { headers: { "X-Rv": "1" } })
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

async function sendState(method: "PUT" | "DELETE", state?: SavedState) {
  const response = await fetch("/api/state", {
    method,
    headers: { "X-Rv": "1" },
    body: method === "PUT" ? JSON.stringify(state) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
}

// One-time upgrade: older builds kept review state in the browser, which is
// lost whenever the origin (port, URL, browser) changes.
function legacyState(root: string): SavedState | null {
  try {
    const comments = localStorage.getItem(`rv:comments:${root}`);
    const reviewed = localStorage.getItem(`rv:reviewed:${root}`);
    const view = localStorage.getItem(`rv:view:${root}`);
    if (!comments && !reviewed && !view) return null;
    return {
      comments: comments ? JSON.parse(comments) : [],
      reviewed: reviewed ? JSON.parse(reviewed) : {},
      view: view ? JSON.parse(view) : {},
    };
  } catch {
    return null;
  }
}

async function loadFile(path: string, ref: string, refresh: number): Promise<Source> {
  const file = await api<Source>("file", { path, ref, refresh: String(refresh) });
  return file && { ...file, cacheKey: JSON.stringify([refresh, ref, path]) };
}

const workerPoolOptions = { workerFactory: () => new DiffWorker(), poolSize: 2 };
const highlighterOptions = { theme: "light-plus" as const };

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
const inactiveTreeStyle = {
  ...treeStyle,
  "--trees-focus-ring-color-override": "transparent",
} as CSSProperties;

function directoryPaths(paths: string[]) {
  return [...new Set(
    paths.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(0, -1).map((_, i) =>
        parts.slice(0, i + 1).join("/") + "/",
      );
    }),
  )];
}

function BrowserTree({
  paths,
  entries,
  selected,
  onSelect,
  reviewed,
  onToggleReviewed,
  onToggleDirectoryReviewed,
  search,
  collapsed,
  onCollapse,
}: {
  paths: string[];
  entries: Entry[];
  selected: string;
  onSelect: (path: string) => void;
  reviewed: boolean;
  onToggleReviewed: (path: string) => void;
  onToggleDirectoryReviewed: (directory: string) => void;
  search: string;
  collapsed: string[];
  onCollapse: (path: string, closed: boolean) => void;
}) {
  const selectRef = useRef(onSelect);
  const toggleReviewedRef = useRef(onToggleReviewed);
  const toggleDirectoryRef = useRef(onToggleDirectoryReviewed);
  const collapseRef = useRef(onCollapse);
  const collapsedRef = useRef(collapsed);
  const searchRef = useRef(search);
  toggleReviewedRef.current = onToggleReviewed;
  toggleDirectoryRef.current = onToggleDirectoryReviewed;
  collapseRef.current = onCollapse;
  collapsedRef.current = collapsed;
  searchRef.current = search;
  const syncingSelection = useRef(false);
  const syncingExpansion = useRef(false);
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
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "button",
        buttonVisibility: "when-needed",
        onOpen: (item, context) => {
          context.close({ restoreFocus: false });
          if (item.kind === "file") toggleReviewedRef.current(item.path);
          else if (item.kind === "directory")
            toggleDirectoryRef.current(item.path);
        },
      },
    },
    unsafeCSS: `
      :host(:not([data-file-review-action])) [data-type="context-menu-anchor"] {
        display: none !important;
      }
      [data-type="context-menu-trigger"] svg { display: none; }
      [data-type="context-menu-trigger"]::before {
        content: "${reviewed ? "↩" : "✓"}";
        font-size: 13px;
        font-weight: 600;
      }
    `,
    gitStatus: entries.map((entry) => ({
      path: entry.path,
      status: statuses[entry.status] || "modified",
    })),
  });
  useEffect(() => {
    const directories = directoryPaths(paths);
    return model.subscribe(() => {
      if (searchRef.current && !model.getSearchValue()) {
        queueMicrotask(() => {
          if (!searchRef.current || model.getSearchValue()) return;
          syncingExpansion.current = true;
          model.setSearch(searchRef.current);
          syncingExpansion.current = false;
        });
        return;
      }
      // Searching temporarily expands matches; it must not overwrite user choices.
      if (syncingExpansion.current || model.getSearchValue()) return;
      for (const path of directories) {
        const item = model.getItem(path);
        if (!item || !("isExpanded" in item)) continue;
        const closed = !item.isExpanded();
        if (closed === collapsedRef.current.includes(path)) continue;
        collapseRef.current(path, closed);
      }
    });
  }, [model]);
  useEffect(() => {
    syncingExpansion.current = true;
    model.setSearch(search);
    if (!search) {
      for (const path of directoryPaths(paths)) {
        const item = model.getItem(path);
        if (!item || !("collapse" in item)) continue;
        if (collapsed.includes(path)) item.collapse();
        else item.expand();
      }
    }
    syncingExpansion.current = false;
  }, [model, search, collapsed]);
  useEffect(() => {
    syncingSelection.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== selected) model.getItem(path)?.deselect();
    }
    const item = model.getItem(selected);
    if (item && !item.isSelected()) item.select();
    syncingSelection.current = false;
  }, [model, selected, paths]);
  useEffect(() => {
    let observer: MutationObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const host = model.getFileTreeContainer();
      const root = host?.shadowRoot;
      if (!host || !root) return;
      const label = reviewed ? "Mark unreviewed" : "Mark reviewed";
      const updateAction = () => {
        const hovered = root.querySelector(
          '[data-type="item"][data-item-context-hover="true"]',
        );
        const type = hovered?.getAttribute("data-item-type");
        host.toggleAttribute(
          "data-file-review-action",
          type === "file" || type === "folder",
        );
        const trigger = root.querySelector('[data-type="context-menu-trigger"]');
        trigger?.setAttribute("aria-label", label);
        trigger?.setAttribute("title", label);
        trigger?.removeAttribute("aria-haspopup");
      };
      observer = new MutationObserver(updateAction);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-item-context-hover"],
      });
      updateAction();
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [model, reviewed]);
  return (
    <FileTree
      model={model}
      className="file-tree"
      style={selected ? treeStyle : inactiveTreeStyle}
    />
  );
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
          event.stopPropagation();
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

function ReviewPalette({
  tab,
  comparison,
  mode,
  from,
  to,
  commits,
  isGit,
  comparing,
  onFiles,
  onWorking,
  onCommit,
  onRangeDraft,
  onRange,
  openRequest,
}: {
  tab: string;
  comparison: Comparison;
  mode: string;
  from: string;
  to: string;
  commits: Info["commits"];
  isGit: boolean;
  comparing: boolean;
  onFiles: () => void;
  onWorking: () => void;
  onCommit: (value: string) => void;
  onRangeDraft: (from: string, to: string) => void;
  onRange: () => void;
  openRequest: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedCommit = commits.find((commit) => commit.id === comparison.target);
  const current = tab === "files"
    ? "File Browser"
    : !comparison.target
      ? "Uncommitted changes"
      : comparison.message !== undefined
        ? selectedCommit?.subject || `Commit ${comparison.target.slice(0, 7)}`
        : `${comparison.base.slice(0, 7)} → ${comparison.target.slice(0, 7)}`;
  const search = query.trim().toLowerCase();
  const choices = commits.filter((commit) =>
    `${commit.id} ${commit.subject}`.toLowerCase().includes(search),
  );
  const scopeMatches = (value: string) =>
    !search || value.toLowerCase().includes(search);
  const customRef = query.trim() &&
    !commits.some((commit) =>
      commit.id === query.trim() || commit.short === query.trim()
    ) &&
    !["file browser", "uncommitted changes", "compare a range"].some((label) =>
      label.includes(search),
    );

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (!openRequest) return;
    setOpen(true);
    setRangeOpen(false);
    setQuery("");
  }, [openRequest]);

  function choose(action: () => void) {
    action();
    setOpen(false);
    setRangeOpen(false);
    setQuery("");
    trigger.current?.focus();
  }

  return (
    <div
      className="review-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          setRangeOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="review-trigger"
        aria-label="Review scope"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(!open);
          setRangeOpen(mode === "range" && tab === "changes");
          setQuery("");
        }}
      >
        <span>Review:</span>
        <strong>{current}</strong>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="review-popover" role="dialog" aria-label="Choose review scope">
          {rangeOpen ? (
            <form
              className="review-range"
              onSubmit={(event) => {
                event.preventDefault();
                choose(onRange);
              }}
            >
              <button
                type="button"
                className="review-back"
                onClick={() => setRangeOpen(false)}
              >
                ← Review scopes
              </button>
              <h2>Compare a range</h2>
              <p>Choose base and target revisions.</p>
              <CommitPicker
                label="Base"
                commits={commits}
                value={from}
                onChange={(value) => onRangeDraft(value, to)}
              />
              <span className="range-arrow" aria-hidden="true">↓</span>
              <CommitPicker
                label="Target"
                commits={commits}
                value={to}
                onChange={(value) => onRangeDraft(from, value)}
              />
              <button className="primary" disabled={comparing}>Compare</button>
            </form>
          ) : (
            <>
              <div className="review-search">
                <span aria-hidden="true">⌕</span>
                <input
                  autoFocus
                  aria-label="Search review scopes"
                  placeholder="File, commit, branch, tag, or range…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (scopeMatches("File Browser Browse the repository at HEAD"))
                      choose(onFiles);
                    else if (isGit && scopeMatches("Uncommitted changes Review uncommitted changes"))
                      choose(onWorking);
                    else if (commits.length && scopeMatches("Compare a range Choose base and target revisions"))
                      setRangeOpen(true);
                    else if (choices[0]) choose(() => onCommit(choices[0].id));
                    else if (customRef) choose(() => onCommit(query.trim()));
                  }}
                />
              </div>
              <div className="review-options" role="listbox" aria-label="Review scopes">
                {scopeMatches("File Browser Browse the repository at HEAD") && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={tab === "files"}
                    onClick={() => choose(onFiles)}
                  >
                    <span className="option-check">{tab === "files" ? "✓" : ""}</span>
                    <span><strong>File Browser</strong><small>Browse the repository at HEAD</small></span>
                  </button>
                )}
                {isGit && scopeMatches("Uncommitted changes Review uncommitted changes") && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={tab === "changes" && !comparison.target}
                    onClick={() => choose(onWorking)}
                  >
                    <span className="option-check">{tab === "changes" && !comparison.target ? "✓" : ""}</span>
                    <span><strong>Uncommitted changes</strong><small>Review uncommitted changes</small></span>
                  </button>
                )}
                {!!commits.length && scopeMatches("Compare a range Choose base and target revisions") && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={tab === "changes" && !!comparison.target && comparison.message === undefined}
                    onClick={() => setRangeOpen(true)}
                  >
                    <span className="option-check">{tab === "changes" && !!comparison.target && comparison.message === undefined ? "✓" : ""}</span>
                    <span><strong>Compare a range…</strong><small>Choose base and target revisions</small></span>
                  </button>
                )}
                {(!!choices.length || customRef) && <h2>Recent commits</h2>}
                {choices.map((commit) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={tab === "changes" && comparison.message !== undefined && comparison.target === commit.id}
                    key={commit.id}
                    onClick={() => choose(() => onCommit(commit.id))}
                  >
                    <span className="option-check">{tab === "changes" && comparison.target === commit.id ? "✓" : ""}</span>
                    <span className="commit-subject">{commit.subject}</span>
                    <code>{commit.short}</code>
                    <time dateTime={commit.date} title={commit.date.replace("T", " ")}>{commitAge(commit.date)}</time>
                  </button>
                ))}
                {customRef && (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => choose(() => onCommit(query.trim()))}
                  >
                    <span className="option-check" />
                    <span><strong>Review commit {query.trim()}</strong><small>Use this Git ref</small></span>
                  </button>
                )}
                {!scopeMatches("File Browser Browse the repository at HEAD") &&
                  !scopeMatches("Uncommitted changes Review uncommitted changes") &&
                  !scopeMatches("Compare a range Choose base and target revisions") &&
                  !choices.length && !customRef && <p>No matching review scope.</p>}
              </div>
            </>
          )}
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
  const [loaded, setLoaded] = useState<{ info: Info; state: SavedState }>();
  const [error, setError] = useState("");
  const infoRequest = useRef(0);
  useEffect(() => {
    Promise.all([
      api<Info>("info"),
      // An unavailable cache still opens the review; saving errors surface later.
      api<SavedState>("state").catch(() => ({})),
    ])
      .then(([info, state]) => {
        const legacy = Object.keys(state).length ? null : legacyState(info.root);
        if (legacy) void sendState("PUT", legacy).catch(() => {});
        setLoaded({ info, state: legacy || state });
      })
      .catch((e) => setError(e.message));
  }, []);
  if (!loaded)
    return (
      <div className="startup">
        <span className="brand-mark">r/</span>
        <h1>rv</h1>
        <p role="status">{error || "Opening your repository…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </div>
    );
  return (
    <Review
      info={loaded.info}
      state={loaded.state}
      refreshInfo={async () => {
        const request = ++infoRequest.current;
        const info = await api<Info>("info", { refresh: crypto.randomUUID() });
        if (request === infoRequest.current)
          setLoaded((current) => current ? { ...current, info } : current);
        return info;
      }}
    />
  );
}

function Review({
  info,
  state,
  refreshInfo,
}: {
  info: Info;
  state: SavedState;
  refreshInfo: () => Promise<Info>;
}) {
  const [saved] = useState(() => readView(info, state.view));
  const [restoring, setRestoring] = useState(saved.appliedMode !== "working");
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
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
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
  const viewer = useRef<CodeViewHandle<Comment, undefined>>(null);
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
  useEffect(() => {
    if (saved.appliedMode !== "working")
      void compare(saved.appliedMode, saved.target, saved.base, true).finally(
        () => setRestoring(false),
      );
  }, []);
  // Review state is saved to the server's disk cache, debounced because
  // changes fire in bursts. stateRef always holds the complete state, so a
  // save during a compare (which freezes the view) still includes the last
  // stable view. The flush uses keepalive and is also triggered from pagehide,
  // so a change is never lost to closing or reloading mid-debounce.
  const stateRef = useRef<SavedState>(state);
  const stateDirty = useRef(false);
  const stateFlush = useRef<(keepalive?: boolean) => void>(() => {});
  useEffect(() => {
    if (!restoring && !comparing) {
      // Persist navigation inputs, never fetched files, diffs or derived labels.
      stateRef.current = {
        ...stateRef.current,
        view: {
          tab, mode, from, to, selected, search, split, wrap,
          showFiles, showComments, filesWidth, commentsWidth, collapsed,
          appliedMode: !comparison.target
            ? "working"
            : comparison.message !== undefined ? "commit" : "range",
          base: comparison.target ? comparison.base : "",
          target: comparison.target,
        },
      };
    }
    // Mutable views are only reviewed for this page snapshot.
    stateRef.current = {
      ...stateRef.current,
      reviewed: Object.fromEntries(
        Object.entries(reviewed).filter(
          ([scope]) => scope !== "files" && scope !== "working",
        ),
      ),
      comments,
    };
    stateDirty.current = true;
    const timer = setTimeout(() => stateFlush.current(), 250);
    return () => clearTimeout(timer);
  }, [
    restoring, comparing, tab, mode, from, to, selected, search, split, wrap,
    showFiles, showComments, filesWidth, commentsWidth, collapsed, comparison,
    reviewed, comments,
  ]);
  useEffect(() => {
    const flush = (keepalive = false) => {
      if (!stateDirty.current) return;
      stateDirty.current = false;
      fetch("/api/state", {
        method: "PUT",
        headers: { "X-Rv": "1" },
        body: JSON.stringify(stateRef.current),
        keepalive,
      })
        .then(async (response) => {
          if (response.ok) return;
          throw new Error((await response.json()).error);
        })
        .catch(() => {
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
    if (restoring) return;
    if (messageView) {
      setLoaded({
        key: contentKey,
        content: {
          oldFile: null,
          newFile: {
            name: "COMMIT_MESSAGE.txt",
            contents: comparison.message!,
            cacheKey: contentKey,
          },
        },
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
  }, [selected, paths, tab, comparison, messageView, restoring, contentKey, contentRevision]);

  async function compare(
    nextMode: string,
    nextTo = to,
    nextFrom = from,
    restore = false,
    refreshedInfo?: Info,
    refresh = restore ? 0 : ++viewRefresh.current,
  ) {
    const id = ++comparisonRequest.current;
    if (!restore) setContentRevision(refresh);
    if (!restore) {
      setMode(nextMode);
      setSearch("");
    }
    setComparing(true);
    setError("");
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
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
      setSelected((current) =>
        restore && (tab === "files" ||
          result.entries.some((entry) => entry.path === current))
          ? current
          : nextMode === "commit"
            ? MESSAGE_PATH
            : result.entries.some((entry) => entry.path === current)
              ? current
              : result.entries[0]?.path || "",
      );
    } catch (e) {
      if (id === comparisonRequest.current) {
        if (restore) setSelected("");
        setError((e as Error).message);
      }
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
      overflow: wrap ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
    }),
    [split, wrap, onSelection],
  );
  const prompt = formatPrompt(comments);
  const notice = content?.newFile?.notice || content?.oldFile?.notice;
  const start = range ? Math.min(range.start, range.end) : 1;
  const end = range ? Math.max(range.start, range.end) : 1;

  function matchesScope(comment: Comment) {
    return (
      (tab === "files"
        ? comment.context === "File"
        : comment.comparison
          ? comment.comparison.base === comparison.base &&
            comment.comparison.target === comparison.target
          : comment.context === compareLabel)
    );
  }
  function matchesView(comment: Comment) {
    return comment.path === selected && matchesScope(comment);
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
  const fileDiff = useMemo(() => {
    if (!content || tab !== "changes" || messageView || notice ||
        !(content.oldFile || content.newFile)) return null;
    let diff = parsedDiffs.current.get(contentKey);
    if (!diff) {
      diff = parseDiffFromFile(content.oldFile, content.newFile);
      // Include the comparison even for additions/deletions with a missing side.
      diff.cacheKey = contentKey;
      parsedDiffs.current.set(contentKey, diff);
    }
    return diff;
  }, [content, contentKey, tab, notice, messageView]);
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
  const sidebarAdditions = entries.reduce(
    (sum, entry) => sum + (entry.additions || 0),
    0,
  );
  const sidebarDeletions = entries.reduce(
    (sum, entry) => sum + (entry.deletions || 0),
    0,
  );
  const sidebarLines = paths.reduce(
    (sum, path) => sum + (info.lineCounts[path] || 0),
    0,
  );

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

  function clearReview() {
    if (!window.confirm(
      "Clear all comments and review progress? View settings will be kept. This cannot be undone.",
    )) return;
    setComments([]);
    setReviewed({});
    reviewHistory.current = [];
    setEditing(undefined);
    setDraft("");
    setRange(null);
    setHighlight(null);
    setPendingComment(null);
    setCopied(false);
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

  const reviewItems = useMemo(() => {
    const query = search.trim().replaceAll("\\", "/").toLowerCase();
    const matchingUnreviewed = unreviewedPaths.filter((path) =>
      path.toLowerCase().includes(query),
    );
    const matchingReviewed = reviewedPaths.filter((path) =>
      path.toLowerCase().includes(query),
    );
    return [
      ...(hasMessage && !messageReviewed && "commit message".includes(query)
        ? [MESSAGE_PATH]
        : []),
      ...treeOrdered(matchingUnreviewed),
      ...(hasMessage && messageReviewed && "commit message".includes(query)
        ? [MESSAGE_PATH]
        : []),
      ...treeOrdered(matchingReviewed),
    ];
  }, [search, hasMessage, messageReviewed, unreviewedPaths, reviewedPaths]);
  function moveFile(offset: number) {
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
    const source = lineSide === "deletions" ? content?.oldFile : content?.newFile;
    const lineCount = source?.contents ? source.contents.split("\n").length : 0;
    if (first < 1 || last < 1 || first > lineCount || last > lineCount) {
      setLineError(`Choose a line between 1 and ${lineCount}.`);
      return;
    }
    const nextRange: SelectedLineRange = {
      start: Math.min(first, last),
      end: Math.max(first, last),
      ...(tab === "changes" && !messageView ? { side: lineSide } : {}),
    };
    setShowLinePicker(false);
    setShowComments(true);
    setLineError("");
    onSelection(nextRange);
    requestAnimationFrame(() => viewer.current?.scrollTo({
      type: "range",
      id: selected,
      range: nextRange,
      align: "center",
    }));
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.matches("input, textarea, select, [contenteditable=true]");
      const modifier = event.metaKey || event.ctrlKey || event.altKey;

      if (event.key === "Escape") {
        if (showShortcuts || showFinder || showLinePicker || showPrompt) {
          event.preventDefault();
          setShowShortcuts(false);
          setShowFinder(false);
          setShowLinePicker(false);
          setShowPrompt(false);
        } else if (editing || range) {
          event.preventDefault();
          setEditing(undefined);
          setRange(null);
          setDraft("");
        }
        return;
      }
      if (typing || modifier || showShortcuts || showFinder || showLinePicker || showPrompt)
        return;

      const key = event.key.toLowerCase();
      if (keySequence.current === "g") {
        keySequence.current = "";
        window.clearTimeout(keySequenceTimer.current);
        if (["f", "c", "u", "r"].includes(key)) {
          event.preventDefault();
          if (key === "r") setReviewPickerRequest((value) => value + 1);
          else if (key === "f") changeTab("files");
          else if (key === "u") {
            changeTab("changes", false);
            void compare("working");
          } else {
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
                await compare("commit", latest, from, false, nextInfo, refresh);
              })
              .catch((error) => setError((error as Error).message))
              .finally(() => {
                latestCommitPending.current = false;
              });
          }
        }
        return;
      }
      if (key === "g") {
        event.preventDefault();
        keySequence.current = "g";
        keySequenceTimer.current = window.setTimeout(() => {
          keySequence.current = "";
        }, 1000);
        return;
      }

      const handled = ["?", "f", "/", "j", "k", "l", "r", "u", "y", "p", "v", "w", "b", "c"];
      if (!handled.includes(key)) return;
      event.preventDefault();
      if (key === "?") setShowShortcuts(true);
      else if (key === "f") setShowFinder(true);
      else if (key === "/") {
        setShowFiles(true);
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('[aria-label="Find a file"]')?.focus(),
        );
      } else if (key === "j") moveFile(1);
      else if (key === "k") moveFile(-1);
      else if (key === "l" && content && !notice) {
        setLineTarget(range ? `${start}${end !== start ? `-${end}` : ""}` : "");
        setLineSide(range?.side === "deletions" ? "deletions" : "additions");
        setLineError("");
        setShowLinePicker(true);
      } else if (key === "r" && event.shiftKey) location.reload();
      else if (key === "r") toggleReviewed();
      else if (key === "u") undo();
      else if (key === "y" && comments.length) void copyPrompt();
      else if (key === "p" && comments.length) setShowPrompt(true);
      else if (key === "v" && tab === "changes" && !messageView) setSplit((value) => !value);
      else if (key === "w") setWrap((value) => !value);
      else if (key === "b") setShowFiles((value) => !value);
      else if (key === "c") setShowComments((value) => !value);
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
        <div className="brand">
          <span className="brand-mark">r/</span>rv
        </div>
        <span className="divider" />
        <span className="repo-name" title={info.root}>
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
            void compare("commit", value);
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
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            onClick={() => setShowShortcuts(true)}
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
            {copied ? "✓ Copied" : "Copy Prompt"}
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
            <span className="line-stats" aria-label={
              tab === "files"
                ? `${sidebarLines.toLocaleString("en-US")} total lines of code`
                : `${sidebarAdditions} lines added, ${sidebarDeletions} lines removed`
            }>
              {tab === "files" ? (
                <span className="lines-total">{sidebarLines.toLocaleString("en-US")} lines</span>
              ) : (
                <>
                  <span className="lines-added">+{sidebarAdditions}</span>
                  <span className="lines-removed">−{sidebarDeletions}</span>
                </>
              )}
            </span>
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
            // The explorer lists current files, not changes: show their total
            // size in lines instead of +/− change stats.
            const explorer = tab === "files";
            const totalLines = groupPaths.reduce(
              (sum, path) => sum + (info.lineCounts[path] || 0),
              0,
            );
            const missingLines = groupPaths.some(
              (path) => info.lineCounts[path] == null,
            );
            return (
              <section
                key={String(done)}
                className={`file-section${groupPaths.length ? "" : " no-files"}`}
                aria-label={done ? "Reviewed" : "Unreviewed"}
              >
                {done && <div className="sidebar-caption">
                  <span className="section-label">
                    Reviewed
                    <span className="file-count">
                      {reviewedCount}
                    </span>
                  </span>
                  <span
                    className="line-stats"
                    aria-label={
                      explorer
                        ? `${totalLines.toLocaleString("en-US")} total lines of code`
                        : `${additions} lines added, ${deletions} lines removed`
                    }
                    title={
                      explorer
                        ? `Total lines of code${missingLines ? "; excludes binary or unpreviewable files" : ""}`
                        : `Lines changed${unavailable ? "; excludes files with unavailable line counts (binary or unpreviewable text)" : ""}`
                    }
                  >
                    {explorer ? (
                      <span className="lines-total">
                        {totalLines.toLocaleString("en-US")} lines
                      </span>
                    ) : (
                      <>
                        <span className="lines-added">+{additions}</span>
                        <span className="lines-removed">−{deletions}</span>
                      </>
                    )}
                  </span>
                </div>}
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
                    selected={groupPaths.includes(selected) ? selected : ""}
                    onSelect={select}
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
          <div className="file-heading">
            <span className="file-path">
              {messageView
                ? `Commit message · ${comparison.target.slice(0, 7)}`
                : selected && paths.includes(selected)
                  ? selected
                  : "No file selected"}
            </span>
            <div className="view-controls">
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
            key={`${tab}:${selected}:${comparison.base}:${comparison.target}`}
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
          </div>
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
      {showFinder && (
        <FileFinder
          paths={paths}
          reviewed={reviewedInView || []}
          onSelect={select}
          onClose={() => setShowFinder(false)}
        />
      )}
      {showShortcuts && <ShortcutHelp onClose={() => setShowShortcuts(false)} />}
      {showLinePicker && (
        <div className="modal-backdrop" onClick={() => setShowLinePicker(false)}>
          <form
            className="line-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="line-dialog-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              selectLineTarget();
            }}
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
              {tab === "changes" && !messageView && (
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
          </form>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <WorkerPoolContextProvider
    poolOptions={workerPoolOptions}
    highlighterOptions={highlighterOptions}
  >
    <App />
  </WorkerPoolContextProvider>,
);
