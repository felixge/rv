import { createMemo, createResource, createSignal, For, Show, type Setter } from "solid-js";
import { BrowserTree, directoryPaths } from "../components/BrowserTree";
import { LineStats } from "../components/LineStats";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { api } from "../lib/api";
import { MESSAGE_PATH, type Entry } from "../types";

// The file browser: unreviewed and reviewed trees with search and line stats.
export function Sidebar(props: {
  tab: string;
  paths: string[];
  entries: Entry[];
  loading: boolean;
  refresh: number;
  hasMessage: boolean;
  reviewed?: string[];
  reviewScope: string;
  selected: string;
  onSelect: (path: string) => void;
  fileHref: (path: string) => string;
  root: string;
  search: string;
  onSearch: (search: string) => void;
  collapsed: string[];
  onCollapsedChange: Setter<string[]>;
  onToggleReviewed: (path: string) => void;
  onToggleDirectoryReviewed: (directory: string) => void;
  revealSelected: boolean;
  // Visible file order of the unreviewed and reviewed trees, for J/K.
  treeOrder: [string[], string[]];
  onHide: () => void;
  onResize: (width: number) => void;
  hidden: boolean;
}) {
  // Reading the whole checkout is optional, never a prerequisite for browsing.
  // A refresh invalidates the totals without starting another scan.
  const [countRequest, setCountRequest] = createSignal<number>();
  const [counts, { refetch }] = createResource(
    () => countRequest() === undefined ? false : String(countRequest()),
    (refresh) => api<Record<string, number | null>>("line-counts", { refresh }),
  );
  const currentCounts = () => countRequest() === props.refresh && !counts.error && !counts.loading
    ? counts() : undefined;
  const counting = () => countRequest() === props.refresh && counts.loading;
  const reviewed = () => props.reviewed || [];
  const groups = createMemo(() => [
    props.paths.filter((path) => !reviewed().includes(path)),
    props.paths.filter((path) => reviewed().includes(path)),
  ]);
  const messageReviewed = () => reviewed().includes(MESSAGE_PATH);
  const reviewedCount = () => groups()[1].length + (props.hasMessage && messageReviewed() ? 1 : 0);
  // The explorer lists current files, not changes: show their total size in
  // lines instead of +/− change stats. Stats follow the file search.
  function groupStats(groupPaths: string[]) {
    const fileSearch = props.search.trim().replaceAll("\\", "/").toLowerCase();
    const visible = groupPaths.filter((path) => path.toLowerCase().includes(fileSearch));
    if (props.tab === "files") {
      const totals = currentCounts();
      if (!totals) return undefined;
      const missing = visible.some((path) => totals[path] == null);
      return {
        lines: visible.reduce((sum, path) => sum + (totals[path] || 0), 0),
        title: `Total lines of code${missing ? "; excludes binary or unpreviewable files" : ""}`,
      };
    }
    const changes = props.entries.filter((entry) => visible.includes(entry.path));
    const missing = changes.some((entry) => entry.additions == null || entry.deletions == null);
    return {
      additions: changes.reduce((sum, entry) => sum + (entry.additions || 0), 0),
      deletions: changes.reduce((sum, entry) => sum + (entry.deletions || 0), 0),
      title: `Lines changed${missing ? "; excludes files with unavailable line counts (binary or unpreviewable text)" : ""}`,
    };
  }
  const unreviewedStats = createMemo(() => groupStats(groups()[0]));

  return (
    <aside
      class="sidebar"
      id="file-browser"
      aria-label="File browser"
      hidden={props.hidden}
    >
      <PanelResizeHandle side="files" onResize={props.onResize} />
      <div class="sidebar-header">
        <strong>{props.tab === "files" ? "Repository files" : "Changed files"}</strong>
        <span class="file-count">
          {props.paths.length + (props.hasMessage ? 1 : 0)}
        </span>
        <Show when={unreviewedStats()} fallback={
          <button
            class="text-button line-stats"
            title={counts.error ? "Line count failed. Click to retry." : "Read all repository files to count lines"}
            disabled={counting()}
            onClick={() => countRequest() === props.refresh ? refetch() : setCountRequest(props.refresh)}
          >
            {counting() ? "Counting…" : counts.error ? "Retry count" : "Count lines"}
          </button>
        }>
          {(stats) => <LineStats {...stats()} />}
        </Show>
        <button
          class="panel-toggle"
          aria-label="Hide file browser"
          title="Hide file browser"
          aria-controls="file-browser"
          onClick={props.onHide}
        >
          ‹
        </button>
      </div>
      <div class="tree-toolbar">
        <div class="search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Find a file"
            placeholder="Find a file…"
            value={props.search}
            onInput={(event) => props.onSearch(event.currentTarget.value)}
          />
        </div>
        <button
          class="tree-action"
          aria-label="Collapse all directories"
          title="Collapse all directories"
          onClick={() => props.onCollapsedChange(directoryPaths(props.paths))}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
            <path d="M2 3.5h3l1 1h6v6.5H2z" />
            <path d="M4.5 7.75h5" />
          </svg>
        </button>
        <button
          class="tree-action"
          aria-label="Expand all directories"
          title="Expand all directories"
          onClick={() => props.onCollapsedChange([])}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
            <path d="M2 3.5h3l1 1h6v6.5H2z" />
            <path d="M4.5 7.75h5 M7 5.25v5" />
          </svg>
        </button>
      </div>
      <For each={[false, true]}>
        {(done) => {
          const groupPaths = () => groups()[done ? 1 : 0];
          const includeMessage = () => props.hasMessage && messageReviewed() === done &&
            "commit message".includes(props.search.toLowerCase());
          const hasFiles = () => !!groupPaths().length || includeMessage();
          // The tree is created with its paths; a new key mounts a new tree.
          const treeKey = () => hasFiles() &&
            `${props.reviewScope}:${includeMessage()}:${JSON.stringify(groupPaths())}`;
          return (
            <Show when={!done || reviewedCount()}>
              <section
                class={`file-section${hasFiles() ? "" : " no-files"}`}
                aria-label={done ? "Reviewed" : "Unreviewed"}
              >
                <Show when={done}>
                  <div class="sidebar-caption">
                    <span class="section-label">
                      Reviewed
                      <span class="file-count">
                        {reviewedCount()}
                      </span>
                    </span>
                    <Show when={groupStats(groupPaths())}>
                      {(stats) => <LineStats {...stats()} />}
                    </Show>
                  </div>
                </Show>
                <Show when={treeKey()} keyed>
                  <BrowserTree
                    paths={groupPaths()}
                    entries={props.entries}
                    selected={groupPaths().includes(props.selected) ||
                      includeMessage() && props.selected === MESSAGE_PATH ? props.selected : ""}
                    includeMessage={includeMessage()}
                    onSelect={props.onSelect}
                    onOrderChange={(order) => {
                      props.treeOrder[done ? 1 : 0] = order;
                    }}
                    fileHref={props.fileHref}
                    scrollRoot={props.root}
                    scrollKey={JSON.stringify(["explorer", props.reviewScope, done])}
                    reviewed={done}
                    onToggleReviewed={props.onToggleReviewed}
                    onToggleDirectoryReviewed={props.onToggleDirectoryReviewed}
                    search={props.search}
                    collapsed={props.collapsed}
                    reveal={props.revealSelected}
                    onCollapse={(path, closed) =>
                      props.onCollapsedChange((current) => closed
                        ? [...new Set([...current, path])]
                        : current.filter((item) => item !== path))
                    }
                  />
                </Show>
                <Show when={!done && !hasFiles()}>
                  <p class="sidebar-empty">
                    {props.loading
                      ? "Loading files…"
                      : reviewedCount()
                      ? "All reviewed."
                      : props.tab === "files"
                        ? "No files yet."
                        : "No changed files."}
                  </p>
                </Show>
              </section>
            </Show>
          );
        }}
      </For>
    </aside>
  );
}
