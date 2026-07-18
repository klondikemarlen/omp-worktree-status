# OMP Worktree Status

An OMP plugin that shows the active Bash directory, its Git worktree root, and its branch in OMP's hook-status area.

It fixes the practical gap between an OMP session started in one checkout and Bash commands intentionally run in another worktree.

## Install

```sh
omp plugin install github:klondikemarlen/omp-worktree-status
```

Restart OMP after installation.

## Status behavior

The status starts at the session directory. It changes when a Bash tool call supplies `cwd`, or when its command begins with a simple directory switch such as:

```sh
cd ~/code/icefoganalytics/wrap-issue-438 && git status --short --branch
```

A linked worktree displays its actual command directory, worktree root, and checked-out branch:

```text
cwd: ~/code/icefoganalytics/wrap-issue-438/api · wt: ~/code/icefoganalytics/wrap-issue-438 · branch: issue-438/prevent-main-to-uat-releases-from-using-a-stale-uat-back-merge
```


When the selected `main` worktree root matches OMP's session directory, the plugin omits its redundant status entry. Other worktrees and branches retain the full context above.

Paths inside the home directory use the conventional `~/` prefix.

In Ptyxis, `cwd` and `wt` paths are Ctrl-clickable links. Other terminals receive the same plain-text status.

OMP's built-in footer remains the session-start directory and branch. Extensions can add hook status, but OMP does not expose an API for replacing built-in footer segments.

## Open in editor

Run `/open-in-editor` to open the active status directory. It uses `$VISUAL`, then `$EDITOR`; Windows falls back to `notepad`. On POSIX, configure either variable before running the command.

VS Code-compatible command names (`code`, `code-insiders`, `codium`, `cursor`, `windsurf`, `devin`, and `devin-desktop`) open a `*.code-workspace` file in the active worktree root in a new window. Without one, they open the active directory. Other editors always receive the active directory.

Quote editor paths and configured arguments that contain spaces.

## Development

```sh
bun test
```
