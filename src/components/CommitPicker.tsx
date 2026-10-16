import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { autofocus, useListNavigation, useOutsidePointerDown } from "../lib/events";
import { commitAge } from "../lib/format";
import type { Info } from "../types";

export function CommitPicker(props: {
  label: string;
  value: string;
  commits: Info["commits"];
  onChange: (value: string) => void;
}) {
  const id = createUniqueId();
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const selected = () => props.commits.find((commit) => commit.id === props.value);
  const options = createMemo(() => {
    const search = query().trim();
    const isKnown = props.commits.some((commit) => commit.id === search || commit.short === search);
    return [
      ...props.commits
        .filter((commit) => `${commit.id} ${commit.subject}`.toLowerCase().includes(search.toLowerCase()))
        .map((commit) => ({ value: commit.id, title: commit.subject, detail: commit.short, date: commit.date as string | undefined })),
      ...(search && !isKnown ? [{ value: search, title: `Use ref: ${search}`, detail: "Git ref", date: undefined }] : []),
    ];
  });
  function choose(next: string) {
    props.onChange(next);
    setOpen(false);
    trigger.focus();
  }
  const { active, setActive, onKeyDown } =
    useListNavigation(options, (option) => choose(option.value), false);
  useOutsidePointerDown(() => root, open, () => setOpen(false));
  createEffect(on([active, open], () => {
    if (open())
      document
        .getElementById(`${id}-${active()}`)
        ?.scrollIntoView({ block: "nearest" });
  }));
  return (
    <div
      class="commit-picker"
      ref={root}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      // Native, so stopping propagation keeps Escape from global shortcuts.
      on:keydown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        class="commit-trigger"
        aria-label={`${props.label} revision`}
        aria-expanded={open()}
        aria-haspopup="dialog"
        title={(() => {
          const commit = selected();
          return commit
            ? `${commit.subject} (${commit.short}) · ${commit.date.replace("T", " ")}`
            : props.value;
        })()}
        onClick={() => {
          setQuery("");
          setActive(0);
          setOpen(!open());
        }}
      >
        <span class="revision-label">{props.label}</span>
        <span class="revision-value">
          {selected()?.subject || props.value || "Choose commit"}
        </span>
        <Show when={selected()}>{(commit) => <code>{commit().short}</code>}</Show>
        <span aria-hidden="true">⌄</span>
      </button>
      <Show when={open()}>
        <div
          class="commit-popover"
          role="dialog"
          aria-label={`Choose ${props.label.toLowerCase()} revision`}
        >
          <input
            ref={autofocus}
            role="combobox"
            aria-label={`Search ${props.label.toLowerCase()} commits`}
            aria-expanded="true"
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={
              options()[active()] ? `${id}-${active()}` : undefined
            }
            placeholder="Search commits or enter a Git ref…"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div
            class="commit-options"
            id={id}
            role="listbox"
            aria-label={`${props.label} commits`}
          >
            <For each={options()}>
              {(option, index) => (
                <button
                  id={`${id}-${index()}`}
                  type="button"
                  role="option"
                  aria-selected={option.value === props.value}
                  tabIndex={-1}
                  class={index() === active() ? "active" : ""}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(option.value)}
                >
                  <span>{option.title}</span>
                  <code>{option.detail}</code>
                  <Show when={option.date}>
                    {(date) => (
                      <time
                        class="commit-time"
                        datetime={date()}
                        title={date().replace("T", " ")}
                      >
                        {commitAge(date())}
                      </time>
                    )}
                  </Show>
                </button>
              )}
            </For>
          </div>
          <p>Search by message or hash · Or enter a branch, tag, or HEAD~2</p>
        </div>
      </Show>
    </div>
  );
}
