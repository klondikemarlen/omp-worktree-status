# OMP Worktree Status

An OMP plugin that shows the active Bash directory, its Git worktree root, and its branch in OMP's hook-status area.

It fixes the practical gap between an OMP session started in one checkout and Bash commands intentionally run in another worktree.

## Install

```sh
omp plugin install github:klondikemarlen/omp-worktree-status
```

Restart OMP after installation.

## Status behavior

The status starts at the session directory. On each successful Bash call, it uses an explicit `cwd`, a leading simple directory switch, or the session directory when neither is supplied:

```sh
cd ~/code/icefoganalytics/wrap-issue-438 && git status --short --branch
```

A linked worktree displays the command directory, worktree root, and checked-out branch when the command runs below the root:

```text
cwd: ~/code/icefoganalytics/wrap-issue-438/api · wt: ~/code/icefoganalytics/wrap-issue-438 · branch: issue-438/prevent-main-to-uat-releases-from-using-a-stale-uat-back-merge
```

At the worktree root, it combines the duplicate path:

```text
cwd/wt: ~/code/icefoganalytics/wrap-issue-438 · branch: issue-438/prevent-main-to-uat-releases-from-using-a-stale-uat-back-merge
```

When the selected primary worktree root matches OMP's session directory, the plugin omits its redundant status entry regardless of branch. Linked worktrees and other worktrees retain the context above.

Paths inside the home directory use the conventional `~/` prefix.

In Ptyxis, `cwd` and `wt` paths are Ctrl-clickable links. Other terminals receive the same plain-text status.

The worktree line uses the active theme's normal text foreground for readable directory and branch context, rather than dim footer styling.

OMP's built-in footer remains the session-start directory and branch. Extensions can add hook status, but OMP does not expose an API for replacing built-in footer segments.

## Resuming sessions

The plugin remembers the last Git worktree directory selected with an explicit Bash `cwd` or a reliable leading `cd … &&`. A non-Git scratch directory or a recovered OMP Verifier checkout still becomes active for the current session, but does not replace the directory saved for resume. Ordinary linked worktrees, including detached ones, can be saved.

On resume, the status and subsequent Bash calls without an explicit `cwd` use the saved directory. An explicit `cwd` remains authoritative, and a leading `cd` runs relative to the restored directory. If the saved worktree is missing or invalid, OMP warns and uses the launch directory. Child and forked sessions do not reuse their parent's saved status.

## Extension context

Other OMP extensions can read the active status context without maintaining their own directory state:

```ts
import { getActiveWorktreeContext } from "omp-worktree-status"

const context = getActiveWorktreeContext()
// Readonly<{ directory: string; worktree?: string; branch?: string; linked: boolean }> | undefined
```

The same immutable snapshot is available at `globalThis[Symbol.for("omp-worktree-status.active-worktree-context")]` for extensions that cannot import this package. It is initialized from a non-empty session directory, updated after successful Bash calls using an explicit `cwd`, a reliable leading `cd`, or the session directory, reinitialized on a session change, and cleared at shutdown. Treat it as display context, not as a substitute for resolving each command's own execution directory.

## Open in editor

Run `/open-in-editor` to open the active status directory. It uses `$VISUAL`, then `$EDITOR`; Windows falls back to `notepad`. On POSIX, configure either variable before running the command.

VS Code-compatible command names (`code`, `code-insiders`, `codium`, `cursor`, `windsurf`, `devin`, and `devin-desktop`) open a `*.code-workspace` file in the active worktree root in a new window. Without one, they open the active directory. Other editors always receive the active directory.

Quote editor paths and configured arguments that contain spaces.

## Open in merge editor

Run `/open-in-merge-editor` to open the active worktree root in a repository-oriented diff or merge editor. Set `$MERGE_EDITOR` to an editor command, including quoted arguments:

```sh
export MERGE_EDITOR='smerge --new-window'
```

Without `$MERGE_EDITOR`, the command uses an executable named by Git's `merge.tool`, so a normal Sublime Merge configuration works:

```sh
git config --global merge.tool smerge
```

It does not fall back to `$VISUAL` or `$EDITOR`; configure a merge editor explicitly.

## Development

```sh
bun test
```

See the [project knowledge guide](/docs/README.md) for architecture, terminal QA scenarios, and the release/install procedure.
