import type { SavedState, Source } from "../types";

// Deliberately no polling, focus revalidation, websocket, or filesystem watcher.
// Responses are cached per URL for this page. A request with a new refresh
// value supersedes the older cached responses of its route.
const requests = new Map<string, { route: string; refresh?: string; promise: Promise<unknown> }>();
export function api<T>(
  route: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = `/api/${route}?${new URLSearchParams(params)}`;
  let request = requests.get(url);
  if (!request) {
    if (params.refresh !== undefined)
      for (const [key, cached] of requests)
        if (cached.route === route && cached.refresh !== params.refresh) requests.delete(key);
    const promise = fetch(url, { headers: { "X-Rv": "1" } }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    });
    promise.catch(() => requests.delete(url));
    request = { route, refresh: params.refresh, promise };
    requests.set(url, request);
  }
  return request.promise as Promise<T>;
}

export async function patchState(state: SavedState, keepalive = false) {
  const response = await fetch("/api/state", {
    method: "PATCH",
    headers: { "X-Rv": "1" },
    body: JSON.stringify(state),
    keepalive,
  });
  if (!response.ok) throw new Error((await response.json()).error);
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
