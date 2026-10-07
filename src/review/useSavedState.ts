import { useEffect, useRef, useState } from "react";
import { patchState } from "../lib/api";
import type { SavedState } from "../types";

// Saves review state to the server-side disk cache, debounced. Send only
// changed sections: navigation or preferences in another tab must never write
// its stale copy of comments back over the shared review.
export function useSavedState(initial: SavedState, next: SavedState) {
  const [error, setError] = useState("");
  const saved = useRef(initial);
  const pending = useRef<SavedState>({});
  const dirty = useRef(false);
  const flush = useRef((keepalive = false) => {
    if (!dirty.current) return;
    dirty.current = false;
    const patch = pending.current;
    pending.current = {};
    patchState(patch, keepalive).catch(() => {
      pending.current = { ...patch, ...pending.current };
      dirty.current = true;
      setError("Could not save review state to disk. Copy your comments before closing.");
    });
  }).current;

  const serialized = JSON.stringify(next);
  useEffect(() => {
    for (const key of ["view", "reviewed", "comments"] as const) {
      if (JSON.stringify(next[key]) !== JSON.stringify(saved.current[key])) {
        pending.current = { ...pending.current, [key]: next[key] };
        dirty.current = true;
      }
    }
    saved.current = next;
    const timer = setTimeout(() => flush(), 250);
    return () => clearTimeout(timer);
  }, [serialized]);
  useEffect(() => {
    const flushOnHide = () => flush(true);
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, []);

  // Write a section immediately, ahead of the debounced save.
  const saveNow = (patch: SavedState) => {
    pending.current = { ...pending.current, ...patch };
    dirty.current = true;
    flush();
  };
  return { error, saveNow };
}
