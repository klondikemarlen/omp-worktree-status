# Architecture and Invariants

The package is a single OMP extension, not a shell or worktree manager. Both package extension declarations load `index.ts`; `.omp-plugin/marketplace.json` supplies discovery metadata. There is no build step or generated runtime artifact.

## Directory selection and Git inspection

`toolDirectory` resolves an explicit Bash `cwd` first, then a reliable leading `cd … &&`. It does not interpret arbitrary shell scripts or persist the shell's internal directory changes. Home-relative and relative paths are resolved before Git inspection.

`inspectWorktree` asks Git for the worktree root, branch, Git directory, and common directory. A different Git directory and common directory identify a linked worktree. Non-Git directories still have valid directory context; detached HEAD has no branch name.

## Extension lifecycle

The default extension owns the active directory, last displayed text, immutable active context, and pending implicit Bash redirections.

- Session start and switch initialize from the session directory, or the newest usable saved directory. An unavailable saved directory produces a warning and leaves launch-directory behavior intact.
- Child and forked sessions do not restore or publish parent status.
- A `tool_call` for Bash without explicit `cwd` is revised to use the active directory when it differs from the session directory. The pending call preserves the original input so a leading relative `cd` resolves from the directory where the command actually ran.
- Successful Bash results refresh Git metadata even when the directory is unchanged. Errors, nonzero exits, and running or failed async results do not replace active context. Explicit directory choices are appended as custom session entries.
- Shutdown clears the active snapshot, status entry, and pending calls.

The exported getter and global symbol expose the same frozen snapshot to cooperating extensions. This is display context, not authority for another tool's execution directory. Keep this public boundary intact when changing rendering.

## Presentation

`formatStatus` owns plain status content and optional Ptyxis OSC 8 file links. At a worktree root it combines duplicate paths into `cwd/wt`; below it, `cwd` and `wt` remain distinct. A primary worktree matching the session directory is hidden, even on another branch. Linked worktrees retain their context.

The extension applies OMP's `text` foreground color to visible status. This keeps the directory and branch at normal readable brightness while respecting the active theme; do not hard-code white or dim the whole line. The extension clears an omitted status with `undefined`.

OMP owns hook-status placement, truncation, and the built-in footer. This plugin does not replace the built-in session-start directory or branch. The automated test theme returns text unchanged, so tests alone cannot establish contrast; use [terminal QA](/docs/qa-scenarios/status.md).

## Editor actions

`/open-in-editor` targets the active directory, with a worktree-root workspace lookup for supported VS Code-compatible commands. `/open-in-merge-editor` targets the active worktree root and uses its separate merge-editor configuration. Both spawn detached processes and report launch failures through OMP notifications. Color or layout changes must not change editor targeting.

Keep the current single-module layout unless an observed ownership or lifecycle problem justifies extraction. Directory parsing, Git inspection, formatting, and event handling are already separate functions; file size alone is not a reason to split them.
