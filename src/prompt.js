export function reference(comment) {
  if (comment.general) return "General comment";
  const path = comment.commit
    ? `commit:${comment.commit}:message`
    : comment.path;
  if (comment.file) return path;
  return `${path}:${comment.start}${comment.end !== comment.start ? `-${comment.end}` : ""}`;
}

export function formatPrompt(comments) {
  return comments
    .map((comment) => {
      if (!comment.general) return `${reference(comment)}\n${comment.text.trim()}`;
      // General comments left while reviewing a commit name it.
      return comment.commit
        ? `commit:${comment.commit}\n${comment.text.trim()}`
        : comment.text.trim();
    })
    .join("\n\n");
}
