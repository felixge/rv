import { useEffect, useRef, useState } from "react";
import { useOutsidePointerDown } from "../lib/events";
import { commitAge } from "../lib/format";
import type { Comparison, Info } from "../types";
import { CommitPicker } from "./CommitPicker";

export function ReviewPalette({
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
  const matches = (value: string) => value.toLowerCase().includes(search);
  const choices = commits.filter((commit) => matches(`${commit.id} ${commit.subject}`));
  const scopes = [
    {
      title: "File Browser",
      detail: "Browse the repository at HEAD",
      available: true,
      selected: tab === "files",
      run: () => choose(onFiles),
    },
    {
      title: "Uncommitted changes",
      detail: "Review uncommitted changes",
      available: isGit,
      selected: tab === "changes" && !comparison.target,
      run: () => choose(onWorking),
    },
    {
      title: "Compare a range…",
      detail: "Choose base and target revisions",
      available: commits.length > 0,
      selected: tab === "changes" && !!comparison.target && comparison.message === undefined,
      run: () => setRangeOpen(true),
    },
  ];
  const visibleScopes = scopes.filter((scope) =>
    scope.available && matches(`${scope.title.replace("…", "")} ${scope.detail}`));
  const customRef = search &&
    !commits.some((commit) => commit.id === query.trim() || commit.short === query.trim()) &&
    !scopes.some((scope) => matches(scope.title)) ? query.trim() : "";

  useOutsidePointerDown(root, open, () => setOpen(false));
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
                    if (visibleScopes[0]) visibleScopes[0].run();
                    else if (choices[0]) choose(() => onCommit(choices[0].id));
                    else if (customRef) choose(() => onCommit(customRef));
                  }}
                />
              </div>
              <div className="review-options" role="listbox" aria-label="Review scopes">
                {visibleScopes.map((scope) => (
                  <button
                    type="button"
                    role="option"
                    key={scope.title}
                    aria-selected={scope.selected}
                    onClick={scope.run}
                  >
                    <span className="option-check">{scope.selected ? "✓" : ""}</span>
                    <span><strong>{scope.title}</strong><small>{scope.detail}</small></span>
                  </button>
                ))}
                {(!!choices.length || customRef) && <h2>Recent commits</h2>}
                {choices.map((commit) => {
                  const selected = tab === "changes" && comparison.message !== undefined &&
                    comparison.target === commit.id;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={commit.id}
                      onClick={() => choose(() => onCommit(commit.id))}
                    >
                      <span className="option-check">{selected ? "✓" : ""}</span>
                      <span className="commit-subject">{commit.subject}</span>
                      <code>{commit.short}</code>
                      <time dateTime={commit.date} title={commit.date.replace("T", " ")}>{commitAge(commit.date)}</time>
                    </button>
                  );
                })}
                {customRef && (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => choose(() => onCommit(customRef))}
                  >
                    <span className="option-check" />
                    <span><strong>Review commit {customRef}</strong><small>Use this Git ref</small></span>
                  </button>
                )}
                {!visibleScopes.length && !choices.length && !customRef &&
                  <p>No matching review scope.</p>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
