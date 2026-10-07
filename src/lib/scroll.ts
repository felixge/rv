export type ScrollPosition = { top: number; left: number };

export const scrollStores = new Map<string, Record<string, ScrollPosition>>();
export function scrollStore(root: string) {
  let positions = scrollStores.get(root);
  if (positions) return positions;
  try {
    positions = JSON.parse(localStorage.getItem(`rv:scroll:${root}`) || "{}") as
      Record<string, ScrollPosition>;
  } catch {
    positions = {};
  }
  scrollStores.set(root, positions);
  return positions;
}

export function rememberScroll(root: string, key: string, element: HTMLElement) {
  const positions = scrollStore(root);
  positions[key] = { top: element.scrollTop, left: element.scrollLeft };
  try {
    // Shared browser storage lets a modified click inherit the current position
    // immediately without exposing it in the URL or waiting for a server write.
    localStorage.setItem(`rv:scroll:${root}`, JSON.stringify(positions));
  } catch {
    // Scroll restoration is best-effort when browser storage is unavailable.
  }
}

export function restoreScroll(root: string, key: string, element: HTMLElement) {
  const position = scrollStore(root)[key];
  if (position) element.scrollTo(position.left, position.top);
}
