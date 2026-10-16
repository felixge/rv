import { createSignal, onCleanup, onMount } from "solid-js";

export function PanelResizeHandle(props: {
  side: "files" | "comments";
  onResize: (width: number) => void;
}) {
  let handle!: HTMLDivElement;
  let drag: { x: number; width: number } | null = null;
  const [width, setWidth] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const minimum = () => props.side === "files" ? 160 : 220;
  const maximum = () => Math.min(520, window.innerWidth * 0.35);
  const direction = () => props.side === "files" ? 1 : -1;
  const resize = (next: number) =>
    props.onResize(Math.round(Math.max(minimum(), Math.min(maximum(), next))));
  onMount(() => {
    const panel = handle.parentElement!;
    const observer = new ResizeObserver(() => {
      if (panel.clientWidth) setWidth(panel.getBoundingClientRect().width);
    });
    observer.observe(panel);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div
      ref={handle}
      class={`resize-handle ${props.side}${dragging() ? " dragging" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={`Resize ${props.side === "files" ? "file browser" : "comments"}`}
      aria-orientation="vertical"
      aria-controls={props.side === "files" ? "file-browser" : "review-comments"}
      aria-valuemin={minimum()}
      aria-valuemax={Math.floor(maximum())}
      aria-valuenow={Math.round(width())}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag = { x: event.clientX, width: width() };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag)
          resize(drag.width + direction() * (event.clientX - drag.x));
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          resize(width() + direction() * (event.key === "ArrowRight" ? 20 : -20));
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          resize(event.key === "Home" ? minimum() : maximum());
        }
      }}
    />
  );
}
