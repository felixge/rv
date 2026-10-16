import { createSignal, Show } from "solid-js";
import { Modal } from "../components/Modal";
import { autofocus } from "../lib/events";

export function PromptDialog(props: {
  prompt: string;
  copyLabel: string;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <Modal class="prompt-dialog" aria-label="Prompt preview" onClose={props.onClose}>
      <div class="panel-heading">
        <h2>Prompt preview</h2>
        <button ref={autofocus} onClick={() => props.onClose()} aria-label="Close preview">
          ✕
        </button>
      </div>
      <PromptText label="Prompt text" prompt={props.prompt} />
      <div class="dialog-footer">
        <span>Exactly what gets copied.</span>
        <button class="primary" onClick={() => props.onCopy()}>
          {props.copyLabel}
        </button>
      </div>
    </Modal>
  );
}

export function CopiedPromptDialog(props: {
  prompt: string;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      class="prompt-dialog copied-prompt-dialog"
      aria-labelledby="copied-prompt-title"
      onClose={props.onClose}
      onSubmit={props.onClear}
    >
      <div class="panel-heading copied-prompt-heading">
        <div>
          <span class="copied-prompt-check" aria-hidden="true">✓</span>
          <div>
            <h2 id="copied-prompt-title">Prompt copied to clipboard</h2>
            <p>You can clear this review or keep the comments for later.</p>
          </div>
        </div>
      </div>
      <PromptText label="Copied prompt" prompt={props.prompt} />
      <div class="dialog-footer">
        <span>Clear also resets review progress.</span>
        <div class="dialog-actions">
          <button type="button" onClick={() => props.onClose()}>
            Keep Comments
          </button>
          <button class="primary" type="submit" ref={autofocus}>
            Clear
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PromptText(props: { label: string; prompt: string }) {
  return (
    <textarea
      aria-label={props.label}
      readOnly
      value={props.prompt}
      onFocus={(event) => event.currentTarget.select()}
    />
  );
}

type Side = "additions" | "deletions";

export function LinePicker(props: {
  path: string;
  initialTarget: string;
  initialSide: Side;
  showSide: boolean;
  lineCount: (side: Side) => number;
  onPick: (start: number, end: number, side: Side) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = createSignal(props.initialTarget);
  const [side, setSide] = createSignal(props.initialSide);
  const [error, setError] = createSignal("");
  const pick = () => {
    const match = target().trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return setError("Enter a line number or range, such as 12 or 12-15.");
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    const count = props.lineCount(side());
    if (first < 1 || last < 1 || first > count || last > count)
      return setError(`Choose a line between 1 and ${count}.`);
    props.onPick(Math.min(first, last), Math.max(first, last), side());
  };
  return (
    <Modal
      class="line-dialog"
      aria-labelledby="line-dialog-title"
      onClose={props.onClose}
      onSubmit={pick}
    >
      <div class="panel-heading">
        <h2 id="line-dialog-title">Comment on a line</h2>
        <button type="button" onClick={() => props.onClose()} aria-label="Close line picker">✕</button>
      </div>
      <div class="line-dialog-body">
        <label for="line-target">Line or range</label>
        <input
          id="line-target"
          ref={autofocus}
          inputMode="numeric"
          placeholder="12 or 12-15"
          value={target()}
          onInput={(event) => {
            setTarget(event.currentTarget.value);
            setError("");
          }}
        />
        <Show when={props.showSide}>
          <label class="line-side">
            Side
            <select value={side()} onChange={(event) => setSide(event.currentTarget.value as Side)}>
              <option value="additions">New side</option>
              <option value="deletions">Old side</option>
            </select>
          </label>
        </Show>
        <Show when={error()}>
          <p role="alert" class="line-error">{error()}</p>
        </Show>
      </div>
      <div class="dialog-footer">
        <span>{props.path}</span>
        <button class="primary" disabled={!target().trim()}>Start comment</button>
      </div>
    </Modal>
  );
}
