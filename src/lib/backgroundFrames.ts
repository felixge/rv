export {};

if (document.hidden) {
  // Pierre batches highlighted DOM updates in animation frames. Browsers pause
  // those frames when a link starts in a background tab, so use timers only for
  // that initial load and restore native scheduling before any interaction.
  const requestFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  const backgroundFrames = new Map<number, number>();
  let nextBackgroundFrame = -1;
  window.requestAnimationFrame = (callback) => {
    const frame = nextBackgroundFrame--;
    backgroundFrames.set(frame, window.setTimeout(() => {
      backgroundFrames.delete(frame);
      callback(performance.now());
    }, 0));
    return frame;
  };
  window.cancelAnimationFrame = (frame) => {
    const timer = backgroundFrames.get(frame);
    if (timer === undefined) cancelFrame(frame);
    else {
      clearTimeout(timer);
      backgroundFrames.delete(frame);
    }
  };
  const restoreFrames = () => {
    window.requestAnimationFrame = requestFrame;
    window.cancelAnimationFrame = cancelFrame;
  };
  document.addEventListener("visibilitychange", restoreFrames, { once: true });
  window.setTimeout(restoreFrames, 5000);
}
