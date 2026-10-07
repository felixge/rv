import { useEffect, useRef, useState } from "react";
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
