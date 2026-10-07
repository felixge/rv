import { useEffect, useId, useRef, useState } from "react";
import { useListNavigation, useOutsidePointerDown } from "../lib/events";
import { commitAge } from "../lib/format";
import type { Info } from "../types";

export function CommitPicker({
  label,
  value,
  commits,
  onChange,
}: {
  label: string;
  value: string;
  commits: Info["commits"];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = commits.find((commit) => commit.id === value);
  const search = query.trim();
  const isKnown = commits.some((commit) => commit.id === search || commit.short === search);
  const options: { value: string; title: string; detail: string; date?: string }[] = [
    ...commits
      .filter((commit) => `${commit.id} ${commit.subject}`.toLowerCase().includes(search.toLowerCase()))
      .map((commit) => ({ value: commit.id, title: commit.subject, detail: commit.short, date: commit.date })),
    ...(search && !isKnown ? [{ value: search, title: `Use ref: ${search}`, detail: "Git ref" }] : []),
  ];
  function choose(next: string) {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  }
  const { active, setActive, onKeyDown } =
    useListNavigation(options, (option) => choose(option.value), false);
  useOutsidePointerDown(root, open, () => setOpen(false));
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);
  return (
    <div
      className="commit-picker"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="commit-trigger"
        aria-label={`${label} revision`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          selected
            ? `${selected.subject} (${selected.short}) · ${selected.date.replace("T", " ")}`
            : value
        }
        onClick={() => {
          setQuery("");
          setActive(0);
          setOpen(!open);
        }}
      >
        <span className="revision-label">{label}</span>
        <span className="revision-value">
          {selected?.subject || value || "Choose commit"}
        </span>
        {selected && <code>{selected.short}</code>}
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className="commit-popover"
          role="dialog"
          aria-label={`Choose ${label.toLowerCase()} revision`}
        >
          <input
            autoFocus
            role="combobox"
            aria-label={`Search ${label.toLowerCase()} commits`}
            aria-expanded="true"
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={
              options[active] ? `${id}-${active}` : undefined
            }
            placeholder="Search commits or enter a Git ref…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div
            className="commit-options"
            id={id}
            role="listbox"
            aria-label={`${label} commits`}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${id}-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                className={index === active ? "active" : ""}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(option.value)}
              >
                <span>{option.title}</span>
                <code>{option.detail}</code>
                {option.date && (
                  <time
                    className="commit-time"
                    dateTime={option.date}
                    title={option.date.replace("T", " ")}
                  >
                    {commitAge(option.date)}
                  </time>
                )}
              </button>
            ))}
          </div>
          <p>Search by message or hash · Or enter a branch, tag, or HEAD~2</p>
        </div>
      )}
    </div>
  );
}
