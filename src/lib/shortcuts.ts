export type Shortcut = {
  command: Command;
  keys: string[];
  label: string;
  category: "Navigate" | "Review" | "View" | "General";
};
export type Command =
  | "palette" | "find-viewed-file" | "next-text-match" | "previous-text-match"
  | "find-file" | "search-files" | "next-file" | "previous-file"
  | "file-browser" | "recent-commit" | "uncommitted" | "review-palette"
  | "comment" | "toggle-reviewed" | "undo" | "save-comment" | "copy-prompt"
  | "preview-prompt" | "toggle-diff" | "toggle-wrap" | "toggle-files"
  | "toggle-comments" | "expand-diff" | "collapse-diff" | "refresh" | "cancel";
export const shortcuts: Shortcut[] = [
  { command: "palette", keys: ["?", "or", "⌘", "K"], label: "Open command launcher", category: "General" },
  { command: "find-viewed-file", keys: ["⌘/Ctrl", "F"], label: "Find in viewed file", category: "Navigate" },
  { command: "next-text-match", keys: ["⌘/Ctrl", "G"], label: "Find next match", category: "Navigate" },
  { command: "previous-text-match", keys: ["⌘/Ctrl", "Shift", "G"], label: "Find previous match", category: "Navigate" },
  { command: "find-file", keys: ["F"], label: "Find a file", category: "Navigate" },
  { command: "search-files", keys: ["/"], label: "Search files", category: "Navigate" },
  { command: "next-file", keys: ["J"], label: "Next file", category: "Navigate" },
  { command: "previous-file", keys: ["K"], label: "Previous file", category: "Navigate" },
  { command: "file-browser", keys: ["G", "F"], label: "Open File Browser", category: "Navigate" },
  { command: "recent-commit", keys: ["G", "C"], label: "Review most recent commit", category: "Navigate" },
  { command: "uncommitted", keys: ["G", "U"], label: "Review uncommitted changes", category: "Navigate" },
  { command: "review-palette", keys: ["G", "R"], label: "Open review palette", category: "Navigate" },
  { command: "comment", keys: ["L"], label: "Comment on a line or range", category: "Review" },
  { command: "toggle-reviewed", keys: ["R"], label: "Toggle reviewed", category: "Review" },
  { command: "undo", keys: ["U"], label: "Undo last action", category: "Review" },
  { command: "save-comment", keys: ["⌘/Ctrl", "Enter"], label: "Save comment", category: "Review" },
  { command: "copy-prompt", keys: ["Y"], label: "Copy review prompt", category: "Review" },
  { command: "preview-prompt", keys: ["P"], label: "Preview review prompt", category: "Review" },
  { command: "toggle-diff", keys: ["V"], label: "Toggle unified / split diff", category: "View" },
  { command: "toggle-wrap", keys: ["W"], label: "Toggle long line wrapping", category: "View" },
  { command: "toggle-files", keys: ["B"], label: "Toggle file browser", category: "View" },
  { command: "toggle-comments", keys: ["M"], label: "Toggle comments", category: "View" },
  { command: "expand-diff", keys: ["E"], label: "Expand viewed file diff", category: "View" },
  { command: "collapse-diff", keys: ["C"], label: "Collapse viewed file diff", category: "View" },
  { command: "refresh", keys: ["Shift", "R"], label: "Refresh repository", category: "General" },
  { command: "cancel", keys: ["Esc"], label: "Close or cancel", category: "General" },
];
