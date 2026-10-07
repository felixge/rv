import type { Comparison, Info, ViewerMode } from "../types";

export function readView(info: Info, stored: unknown) {
  const defaults = {
    tab: "files",
    mode: "working",
    from: info.commits[1]?.id || info.commits[0]?.id || "",
    to: info.commits[0]?.id || "",
    selected: "",
    search: "",
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
      // Navigation belongs to this tab's URL, not the shared disk cache.
      if (["tab", "mode", "from", "to", "selected", "appliedMode", "base", "target"].includes(key)) continue;
      if (typeof view?.[key] !== typeof defaults[key]) continue;
      if (
        key === "collapsed" &&
        (!Array.isArray(view[key]) ||
          !view[key].every((path: unknown) => typeof path === "string"))
      ) continue;
      Object.assign(defaults, { [key]: view[key] });
    }
  } catch {
    // Missing, obsolete or malformed saved state falls back to current defaults.
  }
  // The same query parameters serve CLI entry points and in-app navigation.
  const params = new URLSearchParams(location.search);
  const urlMode = params.get("mode") || "";
  if (["working", "commit", "range"].includes(urlMode)) {
    Object.assign(defaults, {
      tab: "changes",
      mode: urlMode,
      from: params.get("from") || defaults.from,
      to: params.get("to") || defaults.to,
      // Match the in-app pickers, which always open on the first change.
      selected:
        urlMode === "working" ? info.working.entries[0]?.path || "" : "",
      appliedMode: urlMode,
      base: params.get("from") || "",
      target: params.get("to") || "",
    });
  }
  if (params.has("path")) defaults.selected = params.get("path")!;
  const view = params.get("view");
  const viewerMode: ViewerMode = view === "old" || view === "new" ? view : "diff";
  return {
    ...defaults,
    viewerMode,
    split: params.get("split") === "true",
    expanded: params.get("expanded") === "true",
  };
}

export function viewHref(
  tab: string,
  comparison: Comparison,
  path: string,
  viewerMode: ViewerMode,
  split: boolean,
  expanded: boolean,
  commits: Info["commits"],
) {
  const url = new URL(location.href);
  for (const key of ["mode", "from", "to", "path", "view", "split", "expanded"])
    url.searchParams.delete(key);
  const mode = tab === "files" ? "files" : !comparison.target
    ? "working" : comparison.message !== undefined ? "commit" : "range";
  url.searchParams.set("mode", mode);
  if (tab === "changes") url.searchParams.set("view", viewerMode);
  if (tab === "changes" && comparison.target) {
    if (comparison.message === undefined) url.searchParams.set("from", comparison.base);
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
