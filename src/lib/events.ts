import { useEffect, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";

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

// Arrow keys move through a filtered list and Enter chooses the active item.
export function useListNavigation<T>(
  items: T[],
  choose: (item: T) => void,
  wrap = true,
) {
  const [active, setActive] = useState(0);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => wrap
        ? (current + step + items.length) % items.length
        : Math.max(0, Math.min(items.length - 1, current + step)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (items[active]) choose(items[active]);
    }
  };
  return { active, setActive, onKeyDown };
}

export function useOutsidePointerDown(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onOutside: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [active]);
}
