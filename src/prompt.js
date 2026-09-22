export function reference(comment) {
  const path = comment.commit
    ? `commit:${comment.commit}:message`
    : comment.path;
  return `${path}:${comment.start}${comment.end !== comment.start ? `-${comment.end}` : ""}`;
}

export function formatPrompt(comments) {
  return comments
    .map((comment) => `${reference(comment)}\n${comment.text.trim()}`)
    .join("\n\n");
}
