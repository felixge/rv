import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js";

// Modified clicks keep the browser's link behavior (new tab, window, download).
export function onPlainClick(action: () => void = () => {}) {
  return (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    action();
  };
}

export function onCmdEnter(action: () => void) {
  return (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      action();
    }
  };
}

// Whether a pointer is pressed, from pointerdown until pointerup.
let pressing = false;
addEventListener("pointerdown", () => {
  pressing = true;
}, true);
for (const type of ["pointerup", "pointercancel"])
  addEventListener(type, () => {
    pressing = false;
  }, true);

// Use as ref={autofocus}: focuses the element once it is mounted. An element
// mounted by a pointerdown would lose focus to the mousedown that follows, so
// it keeps focus until that press ends.
export function autofocus(element: HTMLElement) {
  onMount(() => {
    element.focus();
    if (!pressing) return;
    const refocus = (event: FocusEvent) => {
      if (event.target === element) return;
      stop();
      element.focus();
    };
    const stop = () => {
      document.removeEventListener("focusin", refocus);
      removeEventListener("pointerup", stop, true);
      removeEventListener("pointercancel", stop, true);
    };
    document.addEventListener("focusin", refocus);
    addEventListener("pointerup", stop, true);
    addEventListener("pointercancel", stop, true);
    onCleanup(stop);
  });
}

// Arrow keys move through a filtered list and Enter chooses the active item.
export function useListNavigation<T>(
  items: Accessor<T[]>,
  choose: (item: T) => void,
  wrap = true,
) {
  const [active, setActive] = createSignal(0);
  const onKeyDown = (event: KeyboardEvent) => {
    const list = items();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!list.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => wrap
        ? (current + step + list.length) % list.length
        : Math.max(0, Math.min(list.length - 1, current + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (list[active()]) choose(list[active()]);
    }
  };
  return { active, setActive, onKeyDown };
}

export function useOutsidePointerDown(
  element: () => HTMLElement | undefined,
  active: Accessor<boolean>,
  onOutside: () => void,
) {
  createEffect(on(active, (isActive) => {
    if (!isActive) return;
    const dismiss = (event: PointerEvent) => {
      if (!element()?.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  }));
}

export function isTyping(target: EventTarget | null) {
  return (target as HTMLElement).matches("input, textarea, select, [contenteditable=true]");
}
