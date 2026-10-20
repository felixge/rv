import { For, Show } from "solid-js";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { autofocus, onCmdEnter } from "../lib/events";
import { reference } from "../prompt.js";
import type { Comment } from "../types";

export function CommentsPanel(props: {
  comments: Comment[];
  highlight: Comment | null;
  onHighlight: (comment: Comment | null) => void;
  onOpen: (comment: Comment) => void;
  editing?: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onEdit: (comment: Comment) => void;
  onDelete: (comment: Comment) => void;
  onSave: () => void;
  onCancel: () => void;
  generalDraft: string;
  onGeneralDraftChange: (draft: string) => void;
  onSaveGeneral: () => void;
  // The composer for a new comment on a file or selected lines.
  newComment: { reference: string; file?: boolean; oldSide: boolean } | null;
  errors: string[];
  onPreview: () => void;
  onHide: () => void;
  onResize: (width: number) => void;
  hidden: boolean;
}) {
  return (
    <aside
      class="comments-panel"
      id="review-comments"
      aria-label="Review comments"
      hidden={props.hidden}
    >
      <PanelResizeHandle side="comments" onResize={props.onResize} />
      <div class="panel-heading">
        <h2>
          Review comments <span>{props.comments.length}</span>
        </h2>
        <button
          class="panel-toggle"
          aria-label="Hide comments"
          title="Hide comments (M)"
          aria-controls="review-comments"
          onClick={() => props.onHide()}
        >
          ›
        </button>
      </div>
      <div class="comment-actions">
        <button
          class="text-button"
          disabled={!props.comments.length}
          onClick={() => props.onPreview()}
        >
          Preview
        </button>
      </div>
      <form
        class="general-composer"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSaveGeneral();
        }}
      >
        <label for="general-comment-text">General comment</label>
        <textarea
          id="general-comment-text"
          placeholder="Add feedback not tied to a file…"
          value={props.generalDraft}
          onInput={(event) => props.onGeneralDraftChange(event.currentTarget.value)}
          onKeyDown={onCmdEnter(() => props.onSaveGeneral())}
        />
        <div class="composer-actions">
          <button class="primary" disabled={!props.generalDraft.trim()}>
            Add general comment
          </button>
        </div>
      </form>
      <div class="comments-body">
        <For each={props.errors.filter(Boolean)}>
          {(message) => <p role="alert" class="error">{message}</p>}
        </For>
        <For each={props.comments}>
          {(comment, index) => (
            <article
              class={`comment${comment.general ? " general" : ""}${props.highlight?.id === comment.id ? " highlighted" : ""}`}
              id={`comment-${comment.id}`}
              tabIndex={comment.general ? undefined : 0}
              aria-label={comment.general ? "General comment" : `Comment on ${reference(comment)}`}
              onMouseEnter={() => !comment.general && props.onHighlight(comment)}
              onMouseLeave={() => !comment.general && props.onHighlight(null)}
              onFocusIn={() => !comment.general && props.onHighlight(comment)}
              onFocusOut={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  props.onHighlight(null);
              }}
              onKeyDown={comment.general ? undefined : (event) => {
                if (
                  event.target === event.currentTarget &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  props.onOpen(comment);
                }
              }}
            >
              <div
                class="comment-top"
                onClick={comment.general ? undefined : () => props.onOpen(comment)}
              >
                <span class="comment-index">
                  {String(index() + 1).padStart(2, "0")}
                </span>
                <code>{reference(comment)}</code>
              </div>
              <Show
                when={props.editing === comment.id}
                fallback={
                  <p
                    onClick={() => {
                      // Selecting text to copy it shouldn't start an edit.
                      if (getSelection()?.isCollapsed !== false) props.onEdit(comment);
                    }}
                  >
                    {comment.text}
                  </p>
                }
              >
                <div class="inline-edit">
                  <textarea
                    aria-label="Edit comment"
                    ref={autofocus}
                    value={props.draft}
                    onInput={(event) => props.onDraftChange(event.currentTarget.value)}
                    onKeyDown={onCmdEnter(() => props.onSave())}
                  />
                  <button onClick={() => props.onCancel()}>
                    Cancel edit
                  </button>
                  <button
                    class="primary"
                    disabled={!props.draft.trim()}
                    onClick={() => props.onSave()}
                  >
                    Save comment
                  </button>
                </div>
              </Show>
              <div class="comment-bottom">
                <span>
                  {comment.context}
                  {comment.file ? " · whole file" : comment.side === "deletions" ? " · old side" : ""}
                </span>
                <button
                  onClick={() => props.onEdit(comment)}
                >
                  Edit
                </button>
                <button
                  aria-label={`Delete comment ${index() + 1}`}
                  onClick={() => props.onDelete(comment)}
                >
                  Delete
                </button>
              </div>
            </article>
          )}
        </For>
        <Show when={props.newComment}>
          {(newComment) => (
            <form
              class="composer"
              onSubmit={(event) => {
                event.preventDefault();
                props.onSave();
              }}
            >
              <label for="comment-text">{newComment().file ? "New file comment" : "New comment"}</label>
              <code>{newComment().reference}</code>
              <Show when={newComment().oldSide}>
                <small>Old side · line numbers before the change</small>
              </Show>
              <textarea
                id="comment-text"
                ref={autofocus}
                placeholder="What should the agent change?"
                value={props.draft}
                onInput={(event) => props.onDraftChange(event.currentTarget.value)}
                onKeyDown={onCmdEnter(() => props.onSave())}
              />
              <div class="composer-actions">
                <button
                  type="button"
                  onClick={() => props.onCancel()}
                >
                  Cancel
                </button>
                <button class="primary" disabled={!props.draft.trim()}>
                  Add comment
                </button>
              </div>
            </form>
          )}
        </Show>
      </div>
    </aside>
  );
}
