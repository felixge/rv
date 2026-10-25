import type { Comparison, ViewerMode } from "../types";

const preferenceDefaults = {
  search: "",
  wrap: true,
  showFiles: true,
  showComments: true,
  filesWidth: 0,
  commentsWidth: 0,
  collapsed: [] as string[],
};

// Preferences are shared through the disk cache.
export function readPreferences(stored: unknown) {
  return { ...preferenceDefaults, ...stored as Partial<typeof preferenceDefaults> };
}

// Navigation belongs to this tab's URL. The same query parameters serve CLI
// entry points and in-app navigation.
export function readLocation() {
  const params = new URLSearchParams(location.search);
  // Without a mode, Review opens on uncommitted changes, else the latest
  // commit, else the File Browser.
  const urlMode = params.get("mode") ?? "auto";
  const changes = ["working", "commit", "range", "auto"].includes(urlMode);
  const from = (changes && params.get("from")) || "";
  const to = (changes && params.get("to")) || (urlMode === "commit" ? "HEAD" : "");
  const view = params.get("view");
  return {
    tab: changes ? "changes" : "files",
    mode: changes ? urlMode : "working",
    // Draft range picker values, defaulted once the review menu loads
    // commits; base/target are the applied comparison.
    from,
    to,
    base: from,
    target: to,
    // Match the in-app pickers, which always open on the first change.
    selected: params.get("path") ?? "",
    viewerMode: (view === "old" || view === "new" ? view : "diff") as ViewerMode,
    split: params.get("split") === "true",
    expanded: params.get("expanded") === "true",
  };
}

export type ViewLocation = {
  tab: string;
  comparison: Comparison;
  path: string;
  viewerMode: ViewerMode;
  split: boolean;
  expanded: boolean;
};

export function viewHref({ tab, comparison, path, viewerMode, split, expanded }: ViewLocation) {
  const url = new URL(location.href);
  for (const key of ["mode", "from", "to", "path", "view", "split", "expanded"])
    url.searchParams.delete(key);
  const mode = tab === "files" ? "files" : comparison.mode;
  url.searchParams.set("mode", mode);
  if (tab === "changes") url.searchParams.set("view", viewerMode);
  if (tab === "changes" && comparison.target) {
    if (mode === "range") url.searchParams.set("from", comparison.base);
    const recent = mode === "commit" ? comparison.recent ?? -1 : -1;
    url.searchParams.set("to", recent < 0
      ? comparison.target
      : recent === 0 ? "HEAD" : `HEAD~${recent}`);
  }
  if (path) url.searchParams.set("path", path);
  if (split) url.searchParams.set("split", "true");
  if (expanded) url.searchParams.set("expanded", "true");
  return `${url.pathname}${url.search}${url.hash}`;
}
