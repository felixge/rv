import { Show } from "solid-js";

// Line totals for repository files, or +/− change counts for diffs.
export function LineStats(props: {
  lines?: number;
  additions?: number;
  deletions?: number;
  title?: string;
  class?: string;
}) {
  const total = () => props.lines?.toLocaleString("en-US");
  const additions = () => props.additions || 0;
  const deletions = () => props.deletions || 0;
  return (
    <span
      class={props.class || "line-stats"}
      title={props.title}
      aria-label={total() !== undefined
        ? `${total()} total lines of code`
        : `${additions()} lines added, ${deletions()} lines removed`}
    >
      <Show
        when={total() !== undefined}
        fallback={
          <>
            <span class="lines-added">+{additions()}</span>
            <span class="lines-removed">−{deletions()}</span>
          </>
        }
      >
        <span class="lines-total">{total()} lines</span>
      </Show>
    </span>
  );
}
