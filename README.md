# difflet

A small, local code review tool. React, [Pierre Trees](https://trees.software/),
[Pierre Diffs](https://diffs.com/), and a Node standard-library server. No accounts,
database, telemetry, or runtime network dependencies.

## Install and run

Requires **Node.js 22+** and **Git**.

From this checkout:

```sh
npm ci
npm run build
npm link
```

Then, in any repository:

```sh
difflet
```

This opens your browser and keeps a read-only server running in the terminal.
Ctrl+C stops it. The default port is 4444. To review another directory or avoid
opening the browser automatically:

```sh
difflet /path/to/project --port 4445 --no-open
```

Running from a subdirectory reviews the Git repository root. Ordinary non-Git
folders also support browsing and commenting, without the Changes view.

## Review

- **Files:** browse current tracked and untracked files; deleted and Git-ignored
  files are omitted. Deleted files remain reviewable under Changes.
- **Changes → Working tree:** net changes from HEAD, including staged, unstaged,
  deleted, and untracked files. A staged change that is undone in the working
  file has no net diff. Before the first commit, files are compared with an empty tree.
- **Recent commit:** choose from the latest 60 commits. Each is compared to its
  first parent; the initial commit is compared to an empty tree.
  The full **Commit message** opens first and supports line comments, including
  commits with no file changes. Choose a changed file to review its diff.
- Commit menus show relative author dates; hover an age for the full timestamp
  with timezone. Ages stay fixed until you refresh, like the rest of the review.
- **Commit range:** open Base and Target to browse recent commits or search by
  message/hash. For a branch, tag, or other revision, type it and choose **Use ref**.
  Arrow keys and Enter select; Escape cancels. Click **Compare** to load the range.
  This is a direct base-to-target comparison (`git diff base target`), not a
  merge-base/three-dot comparison. Branch names, tags, and `HEAD~2` work too.
- **Unified / Split:** choose stacked or side-by-side diffs. Renames deliberately
  appear as deletion + addition to keep the Git layer simple.
- **Mark reviewed:** moves the current file or commit message into **Reviewed**
  in the left panel. It stays open and selectable; click **✓ Reviewed** to undo.
  Search covers both sections. Progress is separate for each commit/range and
  persists in this browser. Files and Working tree progress lasts until refresh,
  so newly edited content is never silently marked reviewed.
- Section headers show file counts and green **+added** / red **−removed** line
  totals. Totals move with reviewed files. Files uses working-tree changes;
  Changes uses the selected comparison. Commit messages do not add to line totals.
  Binary files and untracked files without a text preview are excluded from totals.
- Small chevrons in each panel header hide it; a narrow rail at the same edge
  lets you reopen it. Drag the panels'
  inner edges to resize (or focus a divider and use arrow keys). Widths survive
  refresh and hiding/reopening; limits keep room for the diff. Selecting lines
  or clicking an inline comment marker automatically reopens Comments. Hiding a
  panel keeps its state, including an unfinished comment draft.
- Click a **line number** to comment. Shift-click or drag across line numbers
  for a range. Save with **Add comment** or **Ctrl/Cmd+Enter**. Edit and delete
  saved comments in the right panel.
- Press **?** for a searchable keyboard shortcut guide. Common review actions
  are available without a mouse, including `J`/`K` file navigation, `L` to
  select a line or range for commenting, `/` to search files, and `R` to mark
  the current file reviewed.
- Commented lines have clickable markers that open the comment in the right
  panel. Hover a comment to highlight its lines in the matching view; click it
  to open its file/comparison and scroll to the range.
- **Copy Prompt** copies all saved comments, across files and comparisons, in
  order, without opening a modal. Preview is a separate action for inspecting
  or manually copying the text if clipboard access is unavailable.
- **Reset**, next to Copy Prompt, restores the initial screen and deletes all
  comments, review progress, and view settings for this repository after
  confirmation. Other repositories are unaffected. There is no undo.

The output has no preamble or agent instructions:

```text
src/shipping.ts:6
Make the threshold configurable.

src/shipping.ts:13-14
Keep cents precise; round only when displaying the price.
```

Comments use the line numbers of the version you selected. Deleted-line comments
use the **old side's** numbers; the UI labels these, while the copied prompt
remains only references and comments. Comments are not re-anchored when files
change. Check them before sending a prompt after a refresh.
Commit-message references use `commit:<full hash>:message:<line or range>` instead
of a file path; their line numbers include the subject and blank lines.

## Deliberately manual refresh

There are no watchers, polling timers, focus refreshes, or live subscriptions.
The file list, working change list, and recent commits load when the page opens.
File contents load on selection and are cached until the page reloads. Historical
comparisons load when you choose or restore them. **Refresh** (or browser reload)
reads new repository data while keeping the Files/Changes tab, selected file or
commit message, commit/range, file search, collapsed folders, diff layout, and
panel visibility and widths. Unsubmitted range picker values are kept separately
from the comparison on screen. Applied historical comparisons stay pinned to
their resolved commits, even if a branch or tag moves.

Saved comments and a small view snapshot live in browser local storage, keyed by
repository path, and survive reloads. File contents and fetched comparisons are
not stored in the view snapshot. State is separate for each browser/origin/port.
Unsaved drafts are not persisted. Nothing is written into your repository.

Binary files, symlinks, submodules, and files over 2 MiB show a preview notice rather
than being rendered. The layout is intended for desktop code review.

## Security

The server listens on loopback by default, rejects foreign Host headers and
cross-origin API reads, and exposes only read operations. Source files never go
to an external service. Do not expose it directly to an untrusted network.
`--host 0.0.0.0` is available for use behind an authenticated development proxy;
it disables the local Host restriction and does **not** add authentication.

## Verify

```sh
npm run build
npm test
# Requires agent-browser + Chromium (agent-browser install):
npm run test:browser
```

The tests create and remove disposable Git repositories. The browser test clicks
real rendered line numbers, checks file/diff content and both line-number sides,
pastes back the real clipboard, verifies comment persistence/edit/delete, reviews
commits and ranges, and creates a commit and a working change while the page is
idle to verify refresh-only behavior. Set `SCREENSHOTS=/absolute/output/path` to
capture representative states.

To create an installable package (includes the built UI):

```sh
npm pack
npm install -g ./difflet-0.1.0.tgz
```
