import { createSignal, For, Show } from "solid-js";
import { LineStats } from "../components/LineStats";
import { copyText } from "../lib/clipboard";
import { onPlainClick } from "../lib/events";
import type { ViewLocation } from "../lib/location";
import type { Entry, ViewerMode } from "../types";

// The viewed file's path, change stats, view controls and review toggle. The
// all-files diff shows a summary here instead; each file has a DiffFileHeader.
export function FileHeading(props: {
  // The selected file or commit message; empty when nothing is shown.
  path: string;
  // Replaces the path, for the commit message.
  title: string;
  // Replaces the path and review toggle, for the all-files diff.
  summary?: string;
  href: (overrides?: Partial<ViewLocation>) => string;
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
  onComment: () => void;
}) {
  return (
    <div class="file-heading">
      <Show
        when={props.summary}
        fallback={
          <a class="file-path" href={props.path ? props.href() : undefined} onClick={onPlainClick()}>
            {props.title || props.path || "No file selected"}
          </a>
        }
      >
        <span class="files-summary">{props.summary}</span>
      </Show>
      <Show when={props.path && !props.title && !props.summary}>
        <CopyPathButton path={props.path} />
      </Show>
      <div class="view-controls">
        <Show when={props.showModes}>
          <div class="viewer-modes" role="group" aria-label="File view">
            <For each={["diff", "old", "new"] as const}>
              {(value) => (
                <a
                  href={props.href({ viewerMode: value })}
                  aria-label={`View ${value}`}
                  aria-current={props.viewerMode === value ? "true" : undefined}
                  onClick={onPlainClick(() => props.onViewerMode(value))}
                >
                  {value === "diff" ? "Diff" : value === "old" ? "Old" : "New"}
                </a>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.diffView}>
          <div class="segmented" role="group" aria-label="Diff layout">
            <For each={[false, true]}>
              {(value) => (
                <a
                  href={props.href({ split: value })}
                  aria-current={props.split === value ? "true" : undefined}
                  onClick={onPlainClick(() => props.onSplit(value))}
                >
                  {value ? "Split" : "Unified"}
                </a>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.expandable}>
          <a
            class="expand-all"
            href={props.href({ expanded: !props.expanded })}
            aria-current={props.expanded ? "true" : undefined}
            title={props.expanded ? "Collapse unchanged lines (C)" : "Expand all hidden lines (E)"}
            onClick={onPlainClick(props.onToggleExpanded)}
          >
            {props.expanded ? "Collapse all" : "Expand all"}
          </a>
        </Show>
        <button
          class="wrap-toggle"
          aria-label="Wrap long lines"
          aria-pressed={props.wrap}
          title="Wrap long lines (W)"
          onClick={props.onToggleWrap}
        >
          Wrap
        </button>
      </div>
      <Show when={props.path && !props.summary}>
        <div class="file-actions">
          <Show when={!props.title}>
            <FileCommentButton path={props.path} disabled={props.reviewDisabled} onClick={props.onComment} />
          </Show>
          <ReviewToggle
            reviewed={props.reviewed}
            disabled={props.reviewDisabled}
            onToggle={props.onToggleReviewed}
          />
        </div>
      </Show>
    </div>
  );
}

// A file's sticky header in the all-files diff. Its background shows whether
// the file is in the unreviewed or the reviewed section.
export function DiffFileHeader(props: {
  path: string;
  // Replaces the path, for the commit message.
  title: string;
  href: string;
  stats?: Entry;
  notice?: string;
  onRetry?: () => void;
  current: boolean;
  reviewed: boolean;
  reviewDisabled: boolean;
  onSelect: () => void;
  onToggleReviewed: () => void;
  onComment: () => void;
}) {
  return (
    <div
      class={`file-heading diff-file-heading${props.reviewed ? " reviewed" : ""}`}
      data-path={props.path}
      data-current={props.current ? "true" : undefined}
    >
      <a class="file-path" href={props.href} onClick={onPlainClick(() => props.onSelect())}>
        {props.title || props.path}
      </a>
      <Show when={!props.title}>
        <CopyPathButton path={props.path} />
      </Show>
      <Show when={props.stats?.additions != null && props.stats.deletions != null}>
        <LineStats
          class="file-diff-stats line-stats"
          additions={props.stats!.additions!}
          deletions={props.stats!.deletions!}
          title="Lines changed"
        />
      </Show>
      <Show when={props.notice}>
        <span class="file-notice">{props.notice}</span>
      </Show>
      <div class="file-actions">
        <Show when={props.onRetry}>
          <button onClick={() => props.onRetry?.()} aria-label={`Retry loading ${props.path}`}>Retry</button>
        </Show>
        <Show when={!props.title}>
          <FileCommentButton path={props.path} disabled={props.reviewDisabled} onClick={props.onComment} />
        </Show>
        <ReviewToggle
          reviewed={props.reviewed}
          disabled={props.reviewDisabled}
          onToggle={props.onToggleReviewed}
        />
      </div>
    </div>
  );
}

function FileCommentButton(props: {
  path: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      class="file-comment"
      aria-label={`Comment on file ${props.path}`}
      title="Comment on the whole file"
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      Comment
    </button>
  );
}

function ReviewToggle(props: {
  reviewed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      class={`review-toggle${props.reviewed ? " reviewed" : ""}`}
      aria-label={props.reviewed ? "Mark unreviewed" : "Mark reviewed"}
      aria-pressed={props.reviewed}
      disabled={props.disabled}
      title={props.reviewed ? "Move back to unreviewed" : "Move to Reviewed"}
      onClick={() => props.onToggle()}
    >
      {props.reviewed ? "✓ Reviewed" : "Mark reviewed"}
    </button>
  );
}

function CopyPathButton(props: { path: string }) {
  const [copiedPath, setCopiedPath] = createSignal<string>();
  const copied = () => copiedPath() === props.path;
  return (
    <button
      class="tree-action copy-path"
      aria-label={copied() ? "Copied file path" : "Copy file path"}
      title={copied() ? "Copied" : "Copy file path"}
      onClick={async () => {
        const path = props.path;
        try {
          await copyText(path);
        } catch {
          return;
        }
        setCopiedPath(path);
        setTimeout(() => setCopiedPath((current) => (current === path ? undefined : current)), 1500);
      }}
    >
      <Show
        when={copied()}
        fallback={
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
            <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
            <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" />
          </svg>
        }
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
          <path d="M3 7.5l2.5 2.5L11 4.5" />
        </svg>
      </Show>
    </button>
  );
}
