// Line totals for repository files, or +/− change counts for diffs.
export function LineStats({
  lines,
  additions = 0,
  deletions = 0,
  title,
  className = "line-stats",
}: {
  lines?: number;
  additions?: number;
  deletions?: number;
  title?: string;
  className?: string;
}) {
  const total = lines?.toLocaleString("en-US");
  return (
    <span
      className={className}
      title={title}
      aria-label={total !== undefined
        ? `${total} total lines of code`
        : `${additions} lines added, ${deletions} lines removed`}
    >
      {total !== undefined ? (
        <span className="lines-total">{total} lines</span>
      ) : (
        <>
          <span className="lines-added">+{additions}</span>
          <span className="lines-removed">−{deletions}</span>
        </>
      )}
    </span>
  );
}
