import type { SavedState, Source } from "../types";

// Deliberately no polling, focus revalidation, websocket, or filesystem watcher.
export const requests = new Map<string, Promise<unknown>>();
export function api<T>(
  route: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = `/api/${route}?${new URLSearchParams(params)}`;
  if (!requests.has(url))
    requests.set(
      url,
      fetch(url, { headers: { "X-Rv": "1" } })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            requests.delete(url);
            throw new Error(data.error);
          }
          return data;
        })
        .catch((error) => {
          requests.delete(url);
          throw error;
        }),
    );
  return requests.get(url) as Promise<T>;
}

export async function sendState(method: "PUT" | "DELETE", state?: SavedState) {
  const response = await fetch("/api/state", {
    method,
    headers: { "X-Rv": "1" },
    body: method === "PUT" ? JSON.stringify(state) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
}

// One-time upgrade: older builds kept review state in the browser, which is
// lost whenever the origin (port, URL, browser) changes.
export function legacyState(root: string): SavedState | null {
  try {
    const comments = localStorage.getItem(`rv:comments:${root}`);
    const reviewed = localStorage.getItem(`rv:reviewed:${root}`);
    const view = localStorage.getItem(`rv:view:${root}`);
    if (!comments && !reviewed && !view) return null;
    return {
      comments: comments ? JSON.parse(comments) : [],
      reviewed: reviewed ? JSON.parse(reviewed) : {},
      view: view ? JSON.parse(view) : {},
    };
  } catch {
    return null;
  }
}

export async function loadFile(path: string, ref: string, refresh: number): Promise<Source> {
  const file = await api<Source>("file", { path, ref, refresh: String(refresh) });
  return file && { ...file, cacheKey: JSON.stringify([refresh, ref, path]) };
}
