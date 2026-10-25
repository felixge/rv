import { batch, createEffect, createSignal, For, on, Show } from "solid-js";
import { autofocus, useOutsidePointerDown } from "../lib/events";
import { commitAge } from "../lib/format";
import type { Commit, Comparison } from "../types";
import { CommitPicker } from "./CommitPicker";

export function ReviewPalette(props: {
  tab: string;
  comparison: Comparison;
  mode: string;
  from: string;
  to: string;
  // Undefined until the review menu has loaded them.
  commits: Commit[] | undefined;
  upstream: string;
  isGit: boolean;
  // Opening the menu loads its commits.
  onOpen: () => void;
  comparing: boolean;
  onFiles: () => void;
  onWorking: () => void;
  onCommit: (value: string) => void;
  onRangeDraft: (from: string, to: string) => void;
  onRange: () => void;
  openRequest: number;
}) {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  const [rangeOpen, setRangeOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const commits = () => props.commits || [];
  const current = () => {
    const { comparison } = props;
    return props.tab === "files"
      ? "File Browser"
      : comparison.mode === "working"
        ? "Uncommitted changes"
        : comparison.mode === "commit"
          // Git's subject: the first paragraph on one line.
          ? comparison.message?.trim().split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ") ||
            `Commit ${comparison.target.slice(0, 7)}`
          : `${comparison.base.slice(0, 7)} → ${comparison.target.slice(0, 7)}`;
  };
  const matches = (value: string) => value.toLowerCase().includes(query().trim().toLowerCase());
  const choices = () => commits().filter((commit) => matches(`${commit.id} ${commit.subject}`));
  // The newest pushed commit is where the remote branch points.
  const remoteTip = () => commits().find((commit) => commit.pushed)?.id;
  const scopes = () => [
    {
      title: "File Browser",
      detail: "Browse the repository at HEAD",
      available: true,
      selected: props.tab === "files",
      run: () => choose(props.onFiles),
    },
    {
      title: "Uncommitted changes",
      detail: "Review uncommitted changes",
      available: props.isGit,
      selected: props.tab === "changes" && props.comparison.mode === "working",
      run: () => choose(props.onWorking),
    },
    {
      title: "Compare a range…",
      detail: "Choose base and target revisions",
      available: props.isGit,
      selected: props.tab === "changes" && props.comparison.mode === "range",
      run: () => setRangeOpen(true),
    },
  ];
  const visibleScopes = () => scopes().filter((scope) =>
    scope.available && matches(`${scope.title.replace("…", "")} ${scope.detail}`));
  const customRef = () => {
    const ref = query().trim();
    return ref &&
      !commits().some((commit) => commit.id === ref || commit.short === ref) &&
      !scopes().some((scope) => matches(scope.title)) ? ref : "";
  };

  function submit() {
    const scope = visibleScopes()[0];
    const commit = choices()[0];
    const ref = customRef();
    if (scope) scope.run();
    else if (commit) choose(() => props.onCommit(commit.id));
    else if (ref) choose(() => props.onCommit(ref));
  }
  // Enter before the first commits arrive must still match their subjects.
  let submitWhenLoaded = false;
  createEffect(on(() => props.commits, (loaded) => {
    if (!loaded || !submitWhenLoaded) return;
    submitWhenLoaded = false;
    if (open()) submit();
  }));

  useOutsidePointerDown(() => root, open, () => setOpen(false));
  createEffect(on(() => props.openRequest, (request) => {
    if (!request) return;
    props.onOpen();
    setOpen(true);
    setRangeOpen(false);
    setQuery("");
  }));

  function choose(action: () => void) {
    action();
    setOpen(false);
    setRangeOpen(false);
    setQuery("");
    trigger.focus();
  }

  return (
    <div
      class="review-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          setRangeOpen(false);
          trigger.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        class="review-trigger"
        aria-label="Review scope"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => batch(() => {
          if (!open()) props.onOpen();
          setOpen(!open());
          setRangeOpen(props.mode === "range" && props.tab === "changes");
          setQuery("");
        })}
      >
        <span>Review:</span>
        <strong>{current()}</strong>
        <span aria-hidden="true">⌄</span>
      </button>
      <Show when={open()}>
        <div class="review-popover" role="dialog" aria-label="Choose review scope">
          <Show
            when={rangeOpen()}
            fallback={
              <>
                <div class="review-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    ref={autofocus}
                    aria-label="Search review scopes"
                    placeholder="File, commit, branch, tag, or range…"
                    value={query()}
                    onInput={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      if (props.isGit && !props.commits) submitWhenLoaded = true;
                      else submit();
                    }}
                  />
                </div>
                <div class="review-options" role="listbox" aria-label="Review scopes">
                  <For each={visibleScopes()}>
                    {(scope) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={scope.selected}
                        onClick={scope.run}
                      >
                        <span class="option-check">{scope.selected ? "✓" : ""}</span>
                        <span><strong>{scope.title}</strong><small>{scope.detail}</small></span>
                      </button>
                    )}
                  </For>
                  <Show when={choices().length || customRef()}><h2>Recent commits</h2></Show>
                  <Show when={props.isGit && !props.commits}><p>Loading commits…</p></Show>
                  <For each={choices()}>
                    {(commit) => {
                      const selected = () => props.tab === "changes" &&
                        props.comparison.mode === "commit" &&
                        props.comparison.target === commit.id;
                      const state = commit.pushed ? "Pushed" : "Not pushed";
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected()}
                          classList={{ commit: true, unpushed: commit.pushed === false }}
                          title={commit.pushed === undefined ? undefined : `${state} to ${props.upstream}`}
                          onClick={() => choose(() => props.onCommit(commit.id))}
                        >
                          <span class="option-check">{selected() ? "✓" : ""}</span>
                          <Show when={commit.pushed !== undefined}>
                            <span class="push-rail" role="img" aria-label={state}>
                              <svg
                                viewBox="0 0 16 16"
                                width="15"
                                height="15"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.4"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              >
                                {commit.pushed ? (
                                  // Globe: on the remote.
                                  <>
                                    <circle cx="8" cy="8" r="6" />
                                    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
                                    <path d="M2 8h12" />
                                  </>
                                ) : (
                                  // Laptop: only on this machine.
                                  <>
                                    <rect x="3.5" y="4" width="9" height="6.5" rx="1" />
                                    <path d="M2 12.5h12" />
                                  </>
                                )}
                              </svg>
                            </span>
                          </Show>
                          <span class="commit-subject">{commit.subject}</span>
                          <Show when={commit.id === remoteTip()}>
                            <span class="remote-ref">{props.upstream}</span>
                          </Show>
                          <code>{commit.short}</code>
                          <time datetime={commit.date} title={commit.date.replace("T", " ")}>{commitAge(commit.date)}</time>
                        </button>
                      );
                    }}
                  </For>
                  <Show when={customRef()}>
                    {(ref) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected="false"
                        onClick={() => choose(() => props.onCommit(ref()))}
                      >
                        <span class="option-check" />
                        <span><strong>Review commit {ref()}</strong><small>Use this Git ref</small></span>
                      </button>
                    )}
                  </Show>
                  <Show when={props.commits && !visibleScopes().length && !choices().length && !customRef()}>
                    <p>No matching review scope.</p>
                  </Show>
                </div>
              </>
            }
          >
            <form
              class="review-range"
              onSubmit={(event) => {
                event.preventDefault();
                choose(props.onRange);
              }}
            >
              <button
                type="button"
                class="review-back"
                onClick={() => setRangeOpen(false)}
              >
                ← Review scopes
              </button>
              <h2>Compare a range</h2>
              <p>Choose base and target revisions.</p>
              <CommitPicker
                label="Base"
                commits={commits()}
                value={props.from}
                onChange={(value) => props.onRangeDraft(value, props.to)}
              />
              <span class="range-arrow" aria-hidden="true">↓</span>
              <CommitPicker
                label="Target"
                commits={commits()}
                value={props.to}
                onChange={(value) => props.onRangeDraft(props.from, value)}
              />
              <button class="primary" disabled={props.comparing}>Compare</button>
            </form>
          </Show>
        </div>
      </Show>
    </div>
  );
}
