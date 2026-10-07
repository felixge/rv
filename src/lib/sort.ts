export function compareTreeSegments(left: string, right: string) {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  const leftTokens = leftLower.match(/\d+|\D+/g) || [];
  const rightTokens = rightLower.match(/\d+|\D+/g) || [];
  for (let index = 0; index < Math.min(leftTokens.length, rightTokens.length); index++) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === rightToken) continue;
    const leftNumber = /^\d+$/.test(leftToken);
    const rightNumber = /^\d+$/.test(rightToken);
    if (leftNumber && rightNumber) {
      const comparison = Number(leftToken) - Number(rightToken);
      if (comparison) return comparison;
      continue;
    }
    return leftToken < rightToken ? -1 : 1;
  }
  if (leftTokens.length !== rightTokens.length)
    return leftTokens.length - rightTokens.length;
  if (leftLower !== rightLower) return leftLower < rightLower ? -1 : 1;
  return left < right ? -1 : left === right ? 0 : 1;
}

export function compareTreePaths(left: string, right: string) {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const sharedDepth = Math.min(leftParts.length, rightParts.length);
  for (let depth = 0; depth < sharedDepth; depth++) {
    const leftPart = leftParts[depth];
    const rightPart = rightParts[depth];
    if (leftPart === rightPart) continue;
    const leftIsDirectory = depth < leftParts.length - 1;
    const rightIsDirectory = depth < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    const comparison = compareTreeSegments(leftPart, rightPart);
    if (comparison) return comparison;
    return leftPart < rightPart ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

export function fuzzyScore(path: string, query: string) {
  const candidate = path.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let score = 0;
  let previous = -1;
  for (const character of needle) {
    const index = candidate.indexOf(character, previous + 1);
    if (index < 0) return null;
    score += index - previous - 1;
    if (previous >= 0 && index === previous + 1) score -= 2;
    previous = index;
  }
  const filename = candidate.slice(candidate.lastIndexOf("/") + 1);
  if (filename.startsWith(needle)) score -= 8;
  else if (filename.includes(needle)) score -= 4;
  return score;
}
