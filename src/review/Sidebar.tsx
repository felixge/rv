import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";
import { BrowserTree, directoryPaths } from "../components/BrowserTree";
import { LineStats } from "../components/LineStats";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { MESSAGE_PATH, type Entry } from "../types";

// The file browser: unreviewed and reviewed trees with search and line stats.
export function Sidebar({
  tab,
  paths,
  entries,
  lineCounts,
  hasMessage,
  reviewed = [],
  reviewScope,
  selected,
  onSelect,
  fileHref,
  root,
  search,
  onSearch,
  collapsed,
  onCollapsedChange,
  onToggleReviewed,
  onToggleDirectoryReviewed,
  treeOrder,
  onHide,
  onResize,
  hidden,
}: {
  tab: string;
  paths: string[];
  entries: Entry[];
  lineCounts: Record<string, number | null>;
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
  onCollapsedChange: Dispatch<SetStateAction<string[]>>;
  onToggleReviewed: (path: string) => void;
  onToggleDirectoryReviewed: (directory: string) => void;
  // Visible file order of the unreviewed and reviewed trees, for J/K.
  treeOrder: RefObject<[string[], string[]]>;
  onHide: () => void;
  onResize: (width: number) => void;
  hidden: boolean;
}) {
  const [unreviewedPaths, reviewedPaths] = useMemo(
    () => [
      paths.filter((path) => !reviewed.includes(path)),
      paths.filter((path) => reviewed.includes(path)),
    ],
    [paths, reviewed],
  );
  const messageReviewed = reviewed.includes(MESSAGE_PATH);
  const reviewedCount = reviewedPaths.length + (hasMessage && messageReviewed ? 1 : 0);
  const setUnreviewedOrder = useCallback((order: string[]) => {
    treeOrder.current[0] = order;
  }, [treeOrder]);
  const setReviewedOrder = useCallback((order: string[]) => {
    treeOrder.current[1] = order;
  }, [treeOrder]);
  const fileSearch = search.trim().replaceAll("\\", "/").toLowerCase();
  // The explorer lists current files, not changes: show their total size in
  // lines instead of +/− change stats. Stats follow the file search.
  function groupStats(groupPaths: string[]) {
    const visible = groupPaths.filter((path) => path.toLowerCase().includes(fileSearch));
    if (tab === "files") {
      const missing = visible.some((path) => lineCounts[path] == null);
      return {
        lines: visible.reduce((sum, path) => sum + (lineCounts[path] || 0), 0),
        title: `Total lines of code${missing ? "; excludes binary or unpreviewable files" : ""}`,
      };
    }
    const changes = entries.filter((entry) => visible.includes(entry.path));
    const missing = changes.some((entry) => entry.additions == null || entry.deletions == null);
    return {
      additions: changes.reduce((sum, entry) => sum + (entry.additions || 0), 0),
      deletions: changes.reduce((sum, entry) => sum + (entry.deletions || 0), 0),
      title: `Lines changed${missing ? "; excludes files with unavailable line counts (binary or unpreviewable text)" : ""}`,
    };
  }

  return (
    <aside
      className="sidebar"
      id="file-browser"
      aria-label="File browser"
      hidden={hidden}
    >
      <PanelResizeHandle side="files" onResize={onResize} />
      <div className="sidebar-header">
        <strong>{tab === "files" ? "Repository files" : "Changed files"}</strong>
        <span className="file-count">
          {paths.length + (hasMessage ? 1 : 0)}
        </span>
        <LineStats {...groupStats(unreviewedPaths)} />
        <button
          className="panel-toggle"
          aria-label="Hide file browser"
          title="Hide file browser"
          aria-controls="file-browser"
          onClick={onHide}
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
            onChange={(event) => onSearch(event.target.value)}
          />
        </div>
        <button
          className="tree-action"
          aria-label="Collapse all directories"
          title="Collapse all directories"
          onClick={() => onCollapsedChange(directoryPaths(paths))}
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
          onClick={() => onCollapsedChange([])}
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
        const includeMessage = hasMessage && messageReviewed === done &&
          "commit message".includes(search.toLowerCase());
        return (
          <section
            key={String(done)}
            className={`file-section${groupPaths.length || includeMessage ? "" : " no-files"}`}
            aria-label={done ? "Reviewed" : "Unreviewed"}
          >
            {done && <div className="sidebar-caption">
              <span className="section-label">
                Reviewed
                <span className="file-count">
                  {reviewedCount}
                </span>
              </span>
              <LineStats {...groupStats(groupPaths)} />
            </div>}
            {(!!groupPaths.length || includeMessage) && (
              <BrowserTree
                key={`${reviewScope}:${includeMessage}:${JSON.stringify(groupPaths)}`}
                paths={groupPaths}
                entries={entries}
                selected={groupPaths.includes(selected) ||
                  includeMessage && selected === MESSAGE_PATH ? selected : ""}
                includeMessage={includeMessage}
                onSelect={onSelect}
                onOrderChange={done ? setReviewedOrder : setUnreviewedOrder}
                fileHref={fileHref}
                scrollRoot={root}
                scrollKey={JSON.stringify(["explorer", reviewScope, done])}
                reviewed={done}
                onToggleReviewed={onToggleReviewed}
                onToggleDirectoryReviewed={onToggleDirectoryReviewed}
                search={search}
                collapsed={collapsed}
                onCollapse={(path, closed) =>
                  onCollapsedChange((current) => closed
                    ? [...new Set([...current, path])]
                    : current.filter((item) => item !== path))
                }
              />
            )}
            {!done &&
              !groupPaths.length &&
              !includeMessage && (
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
  );
}
