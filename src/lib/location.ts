import type { Comparison, Info, ViewerMode } from "../types";

const preferenceDefaults = {
  search: "",
  wrap: false,
  showFiles: true,
  showComments: true,
  filesWidth: 0,
  commentsWidth: 0,
  collapsed: [] as string[],
};

// Preferences are shared through the disk cache. Obsolete or malformed values
// fall back to the defaults.
export function readPreferences(stored: unknown) {
  const view = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const preferences = { ...preferenceDefaults };
  for (const key of Object.keys(preferences) as (keyof typeof preferences)[]) {
    const value = view[key];
    const valid = key === "collapsed"
      ? Array.isArray(value) && value.every((path) => typeof path === "string")
      : typeof value === typeof preferences[key];
    if (valid) Object.assign(preferences, { [key]: value });
  }
  return preferences;
}

// Navigation belongs to this tab's URL. The same query parameters serve CLI
// entry points and in-app navigation.
export function readLocation(info: Info) {
  const params = new URLSearchParams(location.search);
  const urlMode = params.get("mode") || "";
  const changes = ["working", "commit", "range"].includes(urlMode);
  const from = (changes && params.get("from")) || "";
  const to = (changes && params.get("to")) || "";
  const view = params.get("view");
  return {
    tab: changes ? "changes" : "files",
    mode: changes ? urlMode : "working",
    // Draft range picker values; base/target are the applied comparison.
    from: from || info.commits[1]?.id || info.commits[0]?.id || "",
    to: to || info.commits[0]?.id || "",
    base: from,
    target: to,
    // Match the in-app pickers, which always open on the first change.
    selected: params.get("path") ??
      (urlMode === "working" ? info.working.entries[0]?.path || "" : ""),
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
  commits: Info["commits"];
};

export function viewHref({ tab, comparison, path, viewerMode, split, expanded, commits }: ViewLocation) {
  const url = new URL(location.href);
  for (const key of ["mode", "from", "to", "path", "view", "split", "expanded"])
    url.searchParams.delete(key);
  const mode = tab === "files" ? "files" : comparison.mode;
  url.searchParams.set("mode", mode);
  if (tab === "changes") url.searchParams.set("view", viewerMode);
  if (tab === "changes" && comparison.target) {
    if (mode === "range") url.searchParams.set("from", comparison.base);
    const recent = mode === "commit"
      ? commits.findIndex((commit) => commit.id === comparison.target)
      : -1;
    url.searchParams.set("to", recent < 0
      ? comparison.target
      : recent === 0 ? "HEAD" : `HEAD~${recent}`);
  }
  if (path) url.searchParams.set("path", path);
  if (split) url.searchParams.set("split", "true");
  if (expanded) url.searchParams.set("expanded", "true");
  return `${url.pathname}${url.search}${url.hash}`;
}
