import { useEffect, useRef, useState } from "react";

export function PanelResizeHandle({
  side,
  onResize,
}: {
  side: "files" | "comments";
  onResize: (width: number) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const minimum = side === "files" ? 160 : 220;
  const maximum = Math.min(520, window.innerWidth * 0.35);
  const direction = side === "files" ? 1 : -1;
  const resize = (next: number) =>
    onResize(Math.round(Math.max(minimum, Math.min(maximum, next))));
  useEffect(() => {
    const panel = handle.current!.parentElement!;
    const observer = new ResizeObserver(() => {
      if (panel.clientWidth) setWidth(panel.getBoundingClientRect().width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={handle}
      className={`resize-handle ${side}${dragging ? " dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${side === "files" ? "file browser" : "comments"}`}
      aria-orientation="vertical"
      aria-controls={side === "files" ? "file-browser" : "review-comments"}
      aria-valuemin={minimum}
      aria-valuemax={Math.floor(maximum)}
      aria-valuenow={Math.round(width)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current)
          resize(
            drag.current.width + direction * (event.clientX - drag.current.x),
          );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          resize(width + direction * (event.key === "ArrowRight" ? 20 : -20));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          resize(event.key === "Home" ? minimum : maximum);
        }
      }}
    />
  );
}
