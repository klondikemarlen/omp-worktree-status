# Status QA Scenarios

Use these scenarios when changing status presentation or its lifecycle. Run `bun run release:check` first. The tests cover directory parsing, Git metadata, formatting, resume behavior, active-context publication, and editor launching; their pass-through theme does not verify terminal contrast or command discovery.

## Local presentation smoke

Start a **new** OMP process with the checkout extension explicitly loaded, avoiding a second discovered copy:

```sh
omp --no-session --no-extensions -e "$PWD/index.ts"
```

1. Use a successful Bash tool call with an explicit `cwd` pointing at another Git checkout or linked worktree. The primary session checkout intentionally hides its redundant status, so it is not a useful visibility fixture.
2. At the selected root, observe `cwd/wt: <path> · branch: <branch>` at normal foreground brightness, comparable to ordinary text or the instance line when that plugin is installed. It must not be dim gray. The chosen theme controls the actual foreground color.
3. Select a subdirectory with another successful Bash call. Observe separate `cwd`, `wt`, and `branch` segments, with the same brightness throughout the line.
4. Type `/open-in` without submitting. Both `open-in-editor` and `open-in-merge-editor` should appear in autocomplete. Cancel the input; do not launch an editor just to check discovery.
5. In Ptyxis, Ctrl-click a directory link and verify it opens the intended location. Other terminals should show plain paths. Automated formatting tests check OSC 8 encoding, but do not prove terminal click handling.

Capture terminal output or a sanitized screenshot. For an ANSI capture, confirm that the worktree line uses the theme's normal text foreground rather than its dim foreground. A source-string assertion or a mocked color call is not visual evidence.

## Adjacent lifecycle checks

For a color-only change, run the existing suite rather than adding duplicate directory scenarios. When changing lifecycle behavior, also exercise the relevant live path:

- A failed Bash command must not replace the last successful directory.
- A resumed session restores a saved valid worktree; a missing saved directory warns and falls back.
- An implicit Bash call after restoration executes in the restored directory; explicit `cwd` remains authoritative.
- Returning to the primary session worktree hides redundant status. Selecting a linked worktree displays it again.

## Release smoke

Repeat the visible root, subdirectory, and autocomplete scenarios after [uninstalling and reinstalling the released plugin](/docs/workflows/release.md), in a fresh process using normal discovery, not `-e` pointing at the checkout. Existing OMP processes retain the extension loaded at startup.
