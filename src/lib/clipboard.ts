// Synchronous copy also works when the async clipboard API is blocked by
// an embedding page's permissions policy. Throws if both methods fail.
export async function copyText(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(textarea);
  const focused = document.activeElement as HTMLElement | null;
  textarea.select();
  let success = false;
  try {
    success = document.execCommand("copy");
  } catch {
    /* Try Clipboard API below. */
  }
  textarea.remove();
  focused?.focus({ preventScroll: true });
  if (!success) await navigator.clipboard.writeText(text);
}
