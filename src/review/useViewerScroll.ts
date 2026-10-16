import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js";
import { rememberScroll, restoreScroll, scrollStore } from "../lib/scroll";

// Each rendered view (file, comparison and viewer mode) remembers its scroll
// position. Returns a function that skips the next restore of the current
// view, for explicit navigation that owns the destination (e.g. comments).
export function useViewerScroll(options: {
  root: string;
  scrollKey: Accessor<string>;
  content: Accessor<unknown>;
  container: () => HTMLElement | undefined;
  interactionVersion: () => number;
  // The all-files diff restores positions itself, relative to each file.
  disabled: Accessor<boolean>;
}) {
  const { root, container, interactionVersion } = options;
  let explicitKey = "";
  createEffect(on([options.scrollKey, options.content, options.disabled], ([scrollKey, , disabled]) => {
    if (disabled) return;
    let scroller: HTMLElement | undefined;
    const save = () => {
      if (scroller && untrack(options.scrollKey) === scrollKey)
        rememberScroll(root, scrollKey, scroller);
    };
    const position = scrollStore(root)[scrollKey];
    const restoreInteraction = interactionVersion();
    let frame = 0;
    let listening = false;
    let attempts = 0;
    const restore = () => {
      scroller ||= container();
      if (!scroller) {
        if (attempts++ < 120) frame = requestAnimationFrame(restore);
        return;
      }
      // Syntax highlighting can finish after mount. Wait until the virtualized
      // content is tall enough instead of letting the browser clamp the saved
      // position to zero before those lines exist.
      if (
        position &&
        scroller.scrollHeight - scroller.clientHeight < position.top &&
        attempts++ < 120
      ) {
        frame = requestAnimationFrame(restore);
        return;
      }
      if (interactionVersion() !== restoreInteraction) {
        // Never override scrolling or focus movement performed while the
        // virtualized content was still finishing its initial render.
      } else if (explicitKey === scrollKey) explicitKey = "";
      else restoreScroll(root, scrollKey, scroller);
      scroller.addEventListener("scroll", save, { passive: true });
      listening = true;
    };
    frame = requestAnimationFrame(restore);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      if (listening && scroller) scroller.removeEventListener("scroll", save);
    });
  }));
  return () => {
    explicitKey = untrack(options.scrollKey);
  };
}
