import { useState } from "react";
import { LineStats } from "../components/LineStats";
import { copyText } from "../lib/clipboard";
import { onPlainClick } from "../lib/events";
import type { ViewLocation } from "../lib/location";
import type { Entry, ViewerMode } from "../types";

// The viewed file's path, change stats, view controls and review toggle.
export function FileHeading({
  path,
  title,
  href,
  stats,
  showModes,
  viewerMode,
  onViewerMode,
  diffView,
  split,
  onSplit,
  expandable,
  expanded,
  onToggleExpanded,
  wrap,
  onToggleWrap,
  reviewed,
  reviewDisabled,
  onToggleReviewed,
}: {
  // The selected file or commit message; empty when nothing is shown.
  path: string;
  // Replaces the path, for the commit message.
  title: string;
  href: (overrides?: Partial<ViewLocation>) => string;
  stats?: Entry;
  showModes: boolean;
  viewerMode: ViewerMode;
  onViewerMode: (mode: ViewerMode) => void;
  diffView: boolean;
  split: boolean;
  onSplit: (split: boolean) => void;
  expandable: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  reviewed: boolean;
  reviewDisabled: boolean;
  onToggleReviewed: () => void;
}) {
  return (
    <div className="file-heading">
      <a className="file-path" href={path ? href() : undefined} onClick={onPlainClick()}>
        {title || path || "No file selected"}
      </a>
      {path && !title && <CopyPathButton path={path} />}
      {stats?.additions != null && stats.deletions != null && (
        <LineStats
          className="file-diff-stats line-stats"
          additions={stats.additions}
          deletions={stats.deletions}
          title="Lines changed"
        />
      )}
      <div className="view-controls">
        {showModes && (
          <div className="viewer-modes" role="group" aria-label="File view">
            {(["diff", "old", "new"] as const).map((value) => (
              <a
                key={value}
                href={href({ viewerMode: value })}
                aria-label={`View ${value}`}
                aria-current={viewerMode === value ? "true" : undefined}
                onClick={onPlainClick(() => onViewerMode(value))}
              >
                {value === "diff" ? "Diff" : value === "old" ? "Old" : "New"}
              </a>
            ))}
          </div>
        )}
        {diffView && (
          <div className="segmented" role="group" aria-label="Diff layout">
            {[false, true].map((value) => (
              <a
                key={String(value)}
                href={href({ split: value })}
                aria-current={split === value ? "true" : undefined}
                onClick={onPlainClick(() => onSplit(value))}
              >
                {value ? "Split" : "Unified"}
              </a>
            ))}
          </div>
        )}
        {expandable && (
          <a
            className="expand-all"
            href={href({ expanded: !expanded })}
            aria-current={expanded ? "true" : undefined}
            title={expanded ? "Collapse unchanged lines (C)" : "Expand all hidden lines (E)"}
            onClick={onPlainClick(onToggleExpanded)}
          >
            {expanded ? "Collapse all" : "Expand all"}
          </a>
        )}
        <button
          className="wrap-toggle"
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          title="Wrap long lines (W)"
          onClick={onToggleWrap}
        >
          Wrap
        </button>
      </div>
      {path && (
        <button
          className={`review-toggle${reviewed ? " reviewed" : ""}`}
          aria-label={reviewed ? "Mark unreviewed" : "Mark reviewed"}
          aria-pressed={reviewed}
          disabled={reviewDisabled}
          title={reviewed ? "Move back to unreviewed" : "Move to Reviewed"}
          onClick={onToggleReviewed}
        >
          {reviewed ? "✓ Reviewed" : "Mark reviewed"}
        </button>
      )}
    </div>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copiedPath, setCopiedPath] = useState<string>();
  const copied = copiedPath === path;
  return (
    <button
      className="tree-action copy-path"
      aria-label={copied ? "Copied file path" : "Copy file path"}
      title={copied ? "Copied" : "Copy file path"}
      onClick={async () => {
        try {
          await copyText(path);
        } catch {
          return;
        }
        setCopiedPath(path);
        setTimeout(() => setCopiedPath((current) => (current === path ? undefined : current)), 1500);
      }}
    >
      {copied ? (
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
          <path d="M3 7.5l2.5 2.5L11 4.5" />
        </svg>
      ) : (
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
          <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" />
        </svg>
      )}
    </button>
  );
}
