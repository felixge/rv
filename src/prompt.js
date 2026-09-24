export function reference(comment) {
  if (comment.general) return "General comment";
  const path = comment.commit
    ? `commit:${comment.commit}:message`
    : comment.path;
  return `${path}:${comment.start}${comment.end !== comment.start ? `-${comment.end}` : ""}`;
}

export function formatPrompt(comments) {
  return comments
    .map((comment) => comment.general
      ? comment.text.trim()
      : `${reference(comment)}\n${comment.text.trim()}`)
    .join("\n\n");
}
