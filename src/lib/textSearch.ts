import type { FileDiffMetadata } from "@pierre/diffs";
import type { Source, TextSearchMatch } from "../types";

export const textSearchHighlightName = "rv-text-search";
export const textSearchMatchesHighlightName = "rv-text-search-matches";
export function textSearchMatches(
  query: string,
  file: Source,
  diff: FileDiffMetadata | null,
  split: boolean,
  expanded: boolean,
) {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const matches: TextSearchMatch[] = [];
  const addLine = (
    text: string | undefined,
    line: number,
    side?: TextSearchMatch["side"],
  ) => {
    const value = text?.toLowerCase() || "";
    let start = 0;
    while ((start = value.indexOf(needle, start)) !== -1) {
      matches.push({ line, start, end: start + needle.length, side });
      start += needle.length;
    }
  };
  if (file) {
    file.contents.split("\n").forEach((line, index) => addLine(line, index + 1));
    return matches;
  }
  if (!diff) return matches;

  const context = (
    deletionStart: number,
    additionStart: number,
    count: number,
  ) => {
    if (split) {
      for (let index = 0; index < count; index++)
        addLine(diff.deletionLines[deletionStart + index], deletionStart + index + 1, "deletions");
    }
    for (let index = 0; index < count; index++)
      addLine(diff.additionLines[additionStart + index], additionStart + index + 1, "additions");
  };
  let deletionCursor = 0;
  let additionCursor = 0;
  for (const hunk of diff.hunks) {
    if (expanded) {
      context(
        deletionCursor,
        additionCursor,
        Math.min(
          hunk.deletionLineIndex - deletionCursor,
          hunk.additionLineIndex - additionCursor,
        ),
      );
    }
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        context(content.deletionLineIndex, content.additionLineIndex, content.lines);
      } else {
        for (let index = 0; index < content.deletions; index++)
          addLine(
            diff.deletionLines[content.deletionLineIndex + index],
            content.deletionLineIndex + index + 1,
            "deletions",
          );
        for (let index = 0; index < content.additions; index++)
          addLine(
            diff.additionLines[content.additionLineIndex + index],
            content.additionLineIndex + index + 1,
            "additions",
          );
      }
    }
    deletionCursor = hunk.deletionLineIndex + hunk.deletionCount;
    additionCursor = hunk.additionLineIndex + hunk.additionCount;
  }
  if (expanded) {
    context(
      deletionCursor,
      additionCursor,
      Math.min(
        diff.deletionLines.length - deletionCursor,
        diff.additionLines.length - additionCursor,
      ),
    );
  }
  return matches;
}

// Diff lines carry their side in a container attribute (split) or line type.
function onSide(line: HTMLElement, side: "additions" | "deletions") {
  return Boolean(line.closest(`[data-${side}]`) ||
    line.dataset.lineType?.includes(side.slice(0, -1)));
}

export function lineSide(line: HTMLElement) {
  return onSide(line, "deletions") ? "deletions"
    : onSide(line, "additions") ? "additions" : undefined;
}

// Map a match to a DOM Range over the rendered, possibly tokenized, line.
export function rangeForMatch(
  match: TextSearchMatch,
  renderedLines: Map<number, HTMLElement[]>,
) {
  const lines = renderedLines.get(match.line) || [];
  const line = match.side
    ? lines.find((candidate) => onSide(candidate, match.side!))
    : lines[0];
  if (!line) return null;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = new Range();
  let started = false;
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nextOffset = offset + node.data.length;
    if (!started && match.start < nextOffset) {
      range.setStart(node, match.start - offset);
      started = true;
    }
    if (started && match.end <= nextOffset) {
      range.setEnd(node, match.end - offset);
      return range;
    }
    offset = nextOffset;
  }
  return null;
}

export const highlightStyles = `::highlight(${textSearchMatchesHighlightName}) {
  color: inherit;
  background: rgba(147, 157, 171, 0.35);
}
::highlight(${textSearchHighlightName}) {
  color: inherit;
  background: #ffd75e;
}`;
