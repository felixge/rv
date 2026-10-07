import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { onCmdEnter } from "../lib/events";
import { reference } from "../prompt.js";
import type { Comment } from "../types";

export function CommentsPanel({
  comments,
  highlight,
  onHighlight,
  onOpen,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onDelete,
  onSave,
  onCancel,
  generalDraft,
  onGeneralDraftChange,
  onSaveGeneral,
  newComment,
  selecting,
  errors,
  agent,
  onPreview,
  onHide,
  onResize,
  hidden,
}: {
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
  // The composer for a new comment on the selected lines.
  newComment: { reference: string; oldSide: boolean } | null;
  selecting: boolean;
  errors: string[];
  agent: boolean;
  onPreview: () => void;
  onHide: () => void;
  onResize: (width: number) => void;
  hidden: boolean;
}) {
  return (
    <aside
      className="comments-panel"
      id="review-comments"
      aria-label="Review comments"
      hidden={hidden}
    >
      <PanelResizeHandle side="comments" onResize={onResize} />
      <div className="panel-heading">
        <h2>
          Review comments <span>{comments.length}</span>
        </h2>
        <button
          className="panel-toggle"
          aria-label="Hide comments"
          title="Hide comments (M)"
          aria-controls="review-comments"
          onClick={onHide}
        >
          ›
        </button>
      </div>
      <div className="comment-actions">
        <button
          className="text-button"
          disabled={!comments.length}
          onClick={onPreview}
        >
          Preview
        </button>
      </div>
      <form
        className="general-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSaveGeneral();
        }}
      >
        <label htmlFor="general-comment-text">General comment</label>
        <textarea
          id="general-comment-text"
          placeholder="Add feedback not tied to a file…"
          value={generalDraft}
          onChange={(event) => onGeneralDraftChange(event.target.value)}
          onKeyDown={onCmdEnter(onSaveGeneral)}
        />
        <div className="composer-actions">
          <button className="primary" disabled={!generalDraft.trim()}>
            Add general comment
          </button>
        </div>
      </form>
      <div className="comments-body">
        {errors.filter(Boolean).map((message) => (
          <p role="alert" className="error" key={message}>{message}</p>
        ))}
        {!comments.length && !selecting && (
          <div className="comment-empty">
            <span className="comment-icon">▤</span>
            <h3>Your thoughts, ready for an agent.</h3>
            <p>
              Select a line in the code to add a comment. Collect your
              feedback here, then {agent ? "submit" : "copy"} it as one prompt.
            </p>
          </div>
        )}
        {comments.map((comment, index) => (
          <article
            className={`comment${comment.general ? " general" : ""}${highlight?.id === comment.id ? " highlighted" : ""}`}
            key={comment.id}
            id={`comment-${comment.id}`}
            tabIndex={comment.general ? undefined : 0}
            aria-label={comment.general ? "General comment" : `Comment on ${reference(comment)}`}
            onMouseEnter={() => !comment.general && onHighlight(comment)}
            onMouseLeave={() => !comment.general && onHighlight(null)}
            onFocus={() => !comment.general && onHighlight(comment)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                onHighlight(null);
            }}
            onClick={comment.general ? undefined : (event) => {
              if (!(event.target as HTMLElement).closest("button, textarea"))
                onOpen(comment);
            }}
            onKeyDown={comment.general ? undefined : (event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                onOpen(comment);
              }
            }}
          >
            <div className="comment-top">
              <span className="comment-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <code>{reference(comment)}</code>
            </div>
            {editing === comment.id ? (
              <div className="inline-edit">
                <textarea
                  aria-label="Edit comment"
                  autoFocus
                  value={draft}
                  onChange={(event) => onDraftChange(event.target.value)}
                  onKeyDown={onCmdEnter(onSave)}
                />
                <button onClick={onCancel}>
                  Cancel edit
                </button>
                <button
                  className="primary"
                  disabled={!draft.trim()}
                  onClick={onSave}
                >
                  Save comment
                </button>
              </div>
            ) : (
              <p>{comment.text}</p>
            )}
            <div className="comment-bottom">
              <span>
                {comment.context}
                {comment.side === "deletions" ? " · old side" : ""}
              </span>
              <button
                onClick={() => onEdit(comment)}
              >
                Edit
              </button>
              <button
                aria-label={`Delete comment ${index + 1}`}
                onClick={() => onDelete(comment)}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
        {newComment && (
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <label htmlFor="comment-text">New comment</label>
            <code>{newComment.reference}</code>
            {newComment.oldSide && (
              <small>Old side · line numbers before the change</small>
            )}
            <textarea
              id="comment-text"
              autoFocus
              placeholder="What should the agent change?"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={onCmdEnter(onSave)}
            />
            <div className="composer-actions">
              <button
                type="button"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button className="primary" disabled={!draft.trim()}>
                Add comment
              </button>
            </div>
          </form>
        )}
      </div>
    </aside>
  );
}
