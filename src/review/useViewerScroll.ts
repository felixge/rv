import { useEffect, useRef, type RefObject } from "react";
import { rememberScroll, restoreScroll, scrollStore } from "../lib/scroll";

// Each rendered view (file, comparison and viewer mode) remembers its scroll
// position. Returns a function that skips the next restore of the current
// view, for explicit navigation that owns the destination (e.g. comments).
export function useViewerScroll({
  root,
  scrollKey,
  content,
  container,
  interactionVersion,
}: {
  root: string;
  scrollKey: string;
  content: unknown;
  container: RefObject<HTMLElement | null>;
  interactionVersion: RefObject<number>;
}) {
  const activeKey = useRef(scrollKey);
  activeKey.current = scrollKey;
  const explicitKey = useRef("");
  useEffect(() => {
    let scroller: HTMLElement | null = null;
    const save = () => {
      if (scroller && activeKey.current === scrollKey)
        rememberScroll(root, scrollKey, scroller);
    };
    const position = scrollStore(root)[scrollKey];
    const restoreInteraction = interactionVersion.current;
    let frame = 0;
    let listening = false;
    let attempts = 0;
    const restore = () => {
      scroller ||= container.current;
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
      if (interactionVersion.current !== restoreInteraction) {
        // Never override scrolling or focus movement performed while the
        // virtualized content was still finishing its initial render.
      } else if (explicitKey.current === scrollKey) explicitKey.current = "";
      else restoreScroll(root, scrollKey, scroller);
      scroller.addEventListener("scroll", save, { passive: true });
      listening = true;
    };
    frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      if (listening && scroller) scroller.removeEventListener("scroll", save);
    };
  }, [root, scrollKey, content]);
  return () => {
    explicitKey.current = scrollKey;
  };
}
