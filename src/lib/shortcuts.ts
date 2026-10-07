type Shortcut = {
  command: Command;
  keys: string[];
  label: string;
  category: "Navigate" | "Review" | "View" | "General";
  // Unmodified key, or two keys typed in sequence. Uppercase requires Shift.
  bind?: string;
};
export type Command =
  | "palette" | "find-viewed-file" | "next-text-match" | "previous-text-match"
  | "find-file" | "search-files" | "next-file" | "previous-file"
  | "file-browser" | "recent-commit" | "uncommitted" | "review-palette"
  | "comment" | "toggle-reviewed" | "undo" | "save-comment" | "copy-prompt"
  | "preview-prompt" | "toggle-diff" | "toggle-wrap" | "toggle-files"
  | "toggle-comments" | "expand-diff" | "collapse-diff" | "refresh" | "cancel";
export const shortcuts: Shortcut[] = [
  { command: "palette", bind: "?", keys: ["?", "or", "⌘", "K"], label: "Open command launcher", category: "General" },
  { command: "find-viewed-file", keys: ["⌘/Ctrl", "F"], label: "Find in viewed file", category: "Navigate" },
  { command: "next-text-match", keys: ["⌘/Ctrl", "G"], label: "Find next match", category: "Navigate" },
  { command: "previous-text-match", keys: ["⌘/Ctrl", "Shift", "G"], label: "Find previous match", category: "Navigate" },
  { command: "find-file", bind: "f", keys: ["F"], label: "Find a file", category: "Navigate" },
  { command: "search-files", bind: "/", keys: ["/"], label: "Search files", category: "Navigate" },
  { command: "next-file", bind: "j", keys: ["J"], label: "Next file", category: "Navigate" },
  { command: "previous-file", bind: "k", keys: ["K"], label: "Previous file", category: "Navigate" },
  { command: "file-browser", bind: "gf", keys: ["G", "F"], label: "Open File Browser", category: "Navigate" },
  { command: "recent-commit", bind: "gc", keys: ["G", "C"], label: "Review most recent commit", category: "Navigate" },
  { command: "uncommitted", bind: "gu", keys: ["G", "U"], label: "Review uncommitted changes", category: "Navigate" },
  { command: "review-palette", bind: "gr", keys: ["G", "R"], label: "Open review palette", category: "Navigate" },
  { command: "comment", bind: "l", keys: ["L"], label: "Comment on a line or range", category: "Review" },
  { command: "toggle-reviewed", bind: "r", keys: ["R"], label: "Toggle reviewed", category: "Review" },
  { command: "undo", bind: "u", keys: ["U"], label: "Undo last action", category: "Review" },
  { command: "save-comment", keys: ["⌘/Ctrl", "Enter"], label: "Save comment", category: "Review" },
  { command: "copy-prompt", bind: "y", keys: ["Y"], label: "Copy review prompt", category: "Review" },
  { command: "preview-prompt", bind: "p", keys: ["P"], label: "Preview review prompt", category: "Review" },
  { command: "toggle-diff", bind: "v", keys: ["V"], label: "Toggle unified / split diff", category: "View" },
  { command: "toggle-wrap", bind: "w", keys: ["W"], label: "Toggle long line wrapping", category: "View" },
  { command: "toggle-files", bind: "b", keys: ["B"], label: "Toggle file browser", category: "View" },
  { command: "toggle-comments", bind: "m", keys: ["M"], label: "Toggle comments", category: "View" },
  { command: "expand-diff", bind: "e", keys: ["E"], label: "Expand viewed file diff", category: "View" },
  { command: "collapse-diff", bind: "c", keys: ["C"], label: "Collapse viewed file diff", category: "View" },
  { command: "refresh", bind: "R", keys: ["Shift", "R"], label: "Refresh repository", category: "General" },
  { command: "cancel", keys: ["Esc"], label: "Close or cancel", category: "General" },
];
