import { createEffect, createMemo, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { FileTree, themeToTreeStyles, type GitStatus } from "@pierre/trees";
import { rememberScroll, restoreScroll } from "../lib/scroll";
import { compareTreePaths } from "../lib/sort";
import { MESSAGE_PATH, MESSAGE_TREE_PATH, type Entry } from "../types";

// The commit message has a reserved review path; the tree shows a label.
const toTree = (path: string) => path === MESSAGE_PATH ? MESSAGE_TREE_PATH : path;
const fromTree = (path: string) => path === MESSAGE_TREE_PATH ? MESSAGE_PATH : path;

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
} as JSX.CSSProperties;

type Stat = { additions: number; deletions: number };
const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

// Line change counts per file and summed per directory ("dir/" keys).
function diffStats(entries: Entry[]) {
  const stats = new Map<string, Stat>();
  for (const entry of entries) {
    const additions = entry.additions || 0, deletions = entry.deletions || 0;
    if (!additions && !deletions) continue;
    for (const key of [entry.path, ...directoryPaths([entry.path])]) {
      const stat = stats.get(key) || { additions: 0, deletions: 0 };
      stat.additions += additions;
      stat.deletions += deletions;
      stats.set(key, stat);
    }
  }
  return stats;
}

export function directoryPaths(paths: string[]) {
  return [...new Set(
    paths.flatMap((path) => {
      const parts = path.split("/");
      return parts.slice(0, -1).map((_, i) =>
        parts.slice(0, i + 1).join("/") + "/",
      );
    }),
  )];
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "file-tree-container": HTMLAttributes<HTMLElement>;
    }
  }
}

// Created with its paths: the parent remounts it when they change.
export function BrowserTree(props: {
  paths: string[];
  entries: Entry[];
  selected: string;
  includeMessage: boolean;
  onSelect: (path: string) => void;
  onOrderChange: (paths: string[]) => void;
  fileHref: (path: string) => string;
  scrollRoot: string;
  scrollKey: string;
  reviewed: boolean;
  onToggleReviewed: (path: string) => void;
  onToggleDirectoryReviewed: (directory: string) => void;
  search: string;
  collapsed: string[];
  onCollapse: (path: string, closed: boolean) => void;
  // Scroll the selected file into view, as the all-files diff scrolls.
  reveal: boolean;
}) {
  let host!: HTMLElement;
  // The tree calls back during its own (Preact) updates. Apply the change
  // afterwards: unmounting the tree mid-update leaks its listeners.
  const later = (action: () => void) => queueMicrotask(action);
  let syncingSelection = false;
  let syncingExpansion = false;
  const { paths, includeMessage, reviewed } = untrack(() => ({ ...props }));
  const treePaths = includeMessage ? [MESSAGE_TREE_PATH, ...paths] : paths;
  // Directories sum only this tree's files, not files in the other section.
  const ownPaths = new Set(paths);
  const stats = createMemo(() => diffStats(props.entries.filter((entry) => ownPaths.has(entry.path))));
  const model = new FileTree({
    paths: treePaths,
    sort: (left, right) =>
      left.path === MESSAGE_TREE_PATH ? -1 : right.path === MESSAGE_TREE_PATH ? 1 :
        compareTreePaths(left.path, right.path),
    initialExpansion: "open",
    density: "compact",
    icons: "standard",
    initialSelectedPaths: untrack(() => props.selected)
      ? [toTree(untrack(() => props.selected))]
      : [],
    onSelectionChange: (items) => {
      if (syncingSelection) return;
      const item = items.at(-1);
      if (item && treePaths.includes(item)) later(() => props.onSelect(fromTree(item)));
    },
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: "button",
        buttonVisibility: "when-needed",
        onOpen: (item, context) => {
          context.close({ restoreFocus: false });
          if (item.kind === "file")
            later(() => props.onToggleReviewed(fromTree(item.path)));
          else if (item.kind === "directory")
            later(() => props.onToggleDirectoryReviewed(item.path));
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
      [data-item-section="decoration"] { flex: 1 0 auto; }
      [data-item-section="decoration"] > span {
        gap: 4px;
        overflow: visible;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      [data-item-section="decoration"] > span > span:empty { display: none; }
      [data-item-type="folder"] > [data-item-section="decoration"] { opacity: 0.55; }
    `,
    renderRowDecoration: ({ row }) => {
      const stat = stats().get(
        row.kind === "directory" ? row.path.replace(/\/?$/, "/") : row.path,
      );
      if (!stat) return null;
      return {
        text: "",
        title: `${stat.additions} lines added, ${stat.deletions} lines removed`,
        parts: [
          { text: stat.additions ? `+${compact(stat.additions)}` : "", color: "#287541" },
          { text: stat.deletions ? `−${compact(stat.deletions)}` : "", color: "#b33a3a" },
        ],
      };
    },
    gitStatus: untrack(() => props.entries).map((entry) => ({
      path: entry.path,
      status: statuses[entry.status] || "modified",
    })),
  });
  onMount(() => {
    model.render({ fileTreeContainer: host });
    onCleanup(() => model.cleanUp());
  });
  onMount(() => {
    const updateOrder = () => {
      props.onOrderChange(
        model.getVisibleRows(0, model.getVisibleCount())
          .filter((row) => row.kind === "file")
          .map((row) => fromTree(row.path)),
      );
    };
    const unsubscribe = model.subscribe(updateOrder);
    updateOrder();
    onCleanup(() => {
      unsubscribe();
      props.onOrderChange([]);
    });
  });
  onMount(() => {
    const directories = directoryPaths(paths);
    onCleanup(model.subscribe(() => {
      if (props.search && !model.getSearchValue()) {
        queueMicrotask(() => {
          if (!props.search || model.getSearchValue()) return;
          syncingExpansion = true;
          model.setSearch(props.search);
          syncingExpansion = false;
        });
        return;
      }
      // Searching temporarily expands matches; it must not overwrite user choices.
      if (syncingExpansion || model.getSearchValue()) return;
      for (const path of directories) {
        const item = model.getItem(path);
        if (!item || !("isExpanded" in item)) continue;
        const closed = !item.isExpanded();
        if (closed === props.collapsed.includes(path)) continue;
        later(() => props.onCollapse(path, closed));
      }
    }));
  });
  createEffect(on([() => props.search, () => props.collapsed], ([search, collapsed]) => {
    syncingExpansion = true;
    model.setSearch(search);
    if (!search) {
      for (const path of directoryPaths(paths)) {
        const item = model.getItem(path);
        if (!item || !("collapse" in item)) continue;
        if (collapsed.includes(path)) item.collapse();
        else item.expand();
      }
    }
    syncingExpansion = false;
  }));
  createEffect(on([() => props.selected, () => props.reveal], ([selected, reveal]) => {
    const treeSelected = toTree(selected);
    syncingSelection = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== treeSelected) model.getItem(path)?.deselect();
    }
    const item = model.getItem(treeSelected);
    if (item && !item.isSelected()) item.select();
    syncingSelection = false;
    if (item && reveal) model.scrollToPath(treeSelected, { offset: "nearest" });
  }));
  onMount(() => {
    // Pierre renders rows as buttons, with no link renderer. Intercept before
    // its selection handler so opening a tab leaves this tab untouched.
    const openTab = (event: MouseEvent) => {
      if (event.type === "auxclick" ? event.button !== 1
        : event.button !== 0 || !(event.metaKey || event.ctrlKey)) return;
      const row = event.composedPath().find((node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.type === "item");
      if (row?.dataset.itemType !== "file" || !row.dataset.itemPath) return;
      event.preventDefault();
      event.stopPropagation();
      window.open(props.fileHref(fromTree(row.dataset.itemPath)), "_blank", "noopener");
    };
    host.addEventListener("click", openTab, true);
    host.addEventListener("auxclick", openTab, true);
    onCleanup(() => {
      host.removeEventListener("click", openTab, true);
      host.removeEventListener("auxclick", openTab, true);
    });
  });
  createEffect(on([() => props.scrollRoot, () => props.scrollKey], ([scrollRoot, scrollKey]) => {
    let scroller: HTMLElement | null | undefined;
    const frame = requestAnimationFrame(() => {
      scroller = host.shadowRoot?.querySelector(
        '[data-file-tree-virtualized-scroll="true"]',
      );
      if (!scroller) return;
      restoreScroll(scrollRoot, scrollKey, scroller);
      scroller.addEventListener("scroll", save, { passive: true });
    });
    const save = () => {
      if (scroller) rememberScroll(scrollRoot, scrollKey, scroller);
    };
    onCleanup(() => {
      cancelAnimationFrame(frame);
      save();
      scroller?.removeEventListener("scroll", save);
    });
  }));
  onMount(() => {
    let observer: MutationObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const root = host.shadowRoot;
      if (!root) return;
      const label = reviewed ? "Mark unreviewed" : "Mark reviewed";
      const updateAction = () => {
        const message = root.querySelector(
          `[data-type="item"][data-item-path=${JSON.stringify(MESSAGE_TREE_PATH)}]`,
        );
        if (message) {
          message.setAttribute("aria-label", "Commit message");
          const content = message.querySelector('[data-item-section="content"]');
          if (content && content.textContent !== "Commit message")
            content.textContent = "Commit message";
        }
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
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    });
  });
  return (
    <file-tree-container
      ref={host}
      class="file-tree"
      style={props.selected ? treeStyle as JSX.CSSProperties : inactiveTreeStyle}
    />
  );
}
