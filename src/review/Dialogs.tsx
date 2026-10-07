import { useState } from "react";
import { Modal } from "../components/Modal";

export function PromptDialog({
  prompt,
  agent,
  copyLabel,
  sendLabel,
  submitting,
  onCopy,
  onSend,
  onClose,
}: {
  prompt: string;
  agent: boolean;
  copyLabel: string;
  sendLabel: string;
  submitting: boolean;
  onCopy: () => void;
  onSend: () => void;
  onClose: () => void;
}) {
  return (
    <Modal className="prompt-dialog" aria-label="Prompt preview" onClose={onClose}>
      <div className="panel-heading">
        <h2>Prompt preview</h2>
        <button autoFocus onClick={onClose} aria-label="Close preview">
          ✕
        </button>
      </div>
      <PromptText label="Prompt text" prompt={prompt} />
      <div className="dialog-footer">
        <span>Exactly what gets {agent ? "submitted" : "copied"}.</span>
        <div className="dialog-actions">
          {agent && <button onClick={onCopy}>{copyLabel}</button>}
          <button className="primary" disabled={submitting} onClick={onSend}>
            {sendLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CopiedPromptDialog({
  prompt,
  onClear,
  onClose,
}: {
  prompt: string;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      className="prompt-dialog copied-prompt-dialog"
      aria-labelledby="copied-prompt-title"
      onClose={onClose}
      onSubmit={onClear}
    >
      <div className="panel-heading copied-prompt-heading">
        <div>
          <span className="copied-prompt-check" aria-hidden="true">✓</span>
          <div>
            <h2 id="copied-prompt-title">Prompt copied to clipboard</h2>
            <p>You can clear this review or keep the comments for later.</p>
          </div>
        </div>
      </div>
      <PromptText label="Copied prompt" prompt={prompt} />
      <div className="dialog-footer">
        <span>Clear also resets review progress.</span>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Keep Comments
          </button>
          <button className="primary" type="submit" autoFocus>
            Clear
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PromptText({ label, prompt }: { label: string; prompt: string }) {
  return (
    <textarea
      aria-label={label}
      readOnly
      value={prompt}
      onFocus={(event) => event.target.select()}
    />
  );
}

type Side = "additions" | "deletions";

export function LinePicker({
  path,
  initialTarget,
  initialSide,
  showSide,
  lineCount,
  onPick,
  onClose,
}: {
  path: string;
  initialTarget: string;
  initialSide: Side;
  showSide: boolean;
  lineCount: (side: Side) => number;
  onPick: (start: number, end: number, side: Side) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(initialTarget);
  const [side, setSide] = useState(initialSide);
  const [error, setError] = useState("");
  const pick = () => {
    const match = target.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return setError("Enter a line number or range, such as 12 or 12-15.");
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    const count = lineCount(side);
    if (first < 1 || last < 1 || first > count || last > count)
      return setError(`Choose a line between 1 and ${count}.`);
    onPick(Math.min(first, last), Math.max(first, last), side);
  };
  return (
    <Modal
      className="line-dialog"
      aria-labelledby="line-dialog-title"
      onClose={onClose}
      onSubmit={pick}
    >
      <div className="panel-heading">
        <h2 id="line-dialog-title">Comment on a line</h2>
        <button type="button" onClick={onClose} aria-label="Close line picker">✕</button>
      </div>
      <div className="line-dialog-body">
        <label htmlFor="line-target">Line or range</label>
        <input
          id="line-target"
          autoFocus
          inputMode="numeric"
          placeholder="12 or 12-15"
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
            setError("");
          }}
        />
        {showSide && (
          <label className="line-side">
            Side
            <select value={side} onChange={(event) => setSide(event.target.value as Side)}>
              <option value="additions">New side</option>
              <option value="deletions">Old side</option>
            </select>
          </label>
        )}
        {error && <p role="alert" className="line-error">{error}</p>}
      </div>
      <div className="dialog-footer">
        <span>{path}</span>
        <button className="primary" disabled={!target.trim()}>Start comment</button>
      </div>
    </Modal>
  );
}
