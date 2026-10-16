import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { patchState } from "../lib/api";
import type { SavedState } from "../types";

// Saves review state to the server-side disk cache, debounced. Send only
// changed sections: navigation or preferences in another tab must never write
// its stale copy of comments back over the shared review.
export function useSavedState(initial: SavedState, next: () => SavedState) {
  const [error, setError] = createSignal("");
  let saved = initial;
  let pending: SavedState = {};
  let dirty = false;
  const flush = (keepalive = false) => {
    if (!dirty) return;
    dirty = false;
    const patch = pending;
    pending = {};
    patchState(patch, keepalive).catch(() => {
      pending = { ...patch, ...pending };
      dirty = true;
      setError("Could not save review state to disk. Copy your comments before closing.");
    });
  };

  const serialized = createMemo(() => JSON.stringify(next()));
  createEffect(on(serialized, () => {
    const current = next();
    for (const key of ["view", "reviewed", "comments"] as const) {
      if (JSON.stringify(current[key]) !== JSON.stringify(saved[key])) {
        pending = { ...pending, [key]: current[key] };
        dirty = true;
      }
    }
    saved = current;
    const timer = setTimeout(() => flush(), 250);
    onCleanup(() => clearTimeout(timer));
  }));
  const flushOnHide = () => flush(true);
  window.addEventListener("pagehide", flushOnHide);
  onCleanup(() => window.removeEventListener("pagehide", flushOnHide));
  return error;
}
