export type Entry = {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
};
export type CompareMode = "working" | "commit" | "range";
export type Comparison = {
  mode: CompareMode;
  base: string;
  target: string;
  entries: Entry[];
  message?: string;
};
export const MESSAGE_PATH = "\0commit-message";
export const MESSAGE_TREE_PATH = "\uE000Commit message";
export type Source = { name: string; contents: string; notice?: string; cacheKey?: string } | null;
export type Info = {
  root: string;
  name: string;
  isGit: boolean;
  agent: boolean;
  branch: string;
  files: string[];
  lineCounts: Record<string, number | null>;
  working: Comparison;
  commits: { id: string; short: string; subject: string; date: string }[];
};
export type Comment = {
  id: string;
  path: string;
  start: number;
  end: number;
  text: string;
  general?: boolean;
  side?: "additions" | "deletions";
  context: string;
  // Older comments stored the whole Comparison, without a mode.
  comparison?: { mode?: CompareMode; base: string; target: string };
  commit?: string;
};
export type Content = { oldFile: Source; newFile: Source };
export type ViewerMode = "diff" | "old" | "new";
export type TextSearchMatch = {
  line: number;
  start: number;
  end: number;
  side?: "additions" | "deletions";
};
// The server-side disk cache, loaded once and saved back debounced.
export type SavedState = {
  view?: Record<string, unknown>;
  reviewed?: Record<string, string[]>;
  comments?: Comment[];
};
