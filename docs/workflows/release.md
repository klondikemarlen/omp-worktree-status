# Release Procedure

The distribution source is the repository's default branch (`main`), installed with `github:klondikemarlen/omp-worktree-status`. A GitHub tag or release records a version but does not replace the default-branch install source. There is no npm publishing step, build step, Docker wrapper, or configured CI workflow in this repository.

Use the shared feature workflow for issue, meaningful issue-linked branch, draft PR, self-review, QA, and merge. Work in the current checkout unless another location is authorized. This page adds only project-specific checks and distribution details.

## Verify the feature

```sh
bun run release:check
git diff --check origin/main...HEAD
```

`release:check` runs the same Bun suite as `bun test`. No formatter or separate typecheck script is configured. Review the touched code for local style and keep whitespace changes scoped.

For status changes, complete the [terminal scenarios](/docs/qa-scenarios/status.md). Record exact observed results and any unavailable terminal-specific checks in the PR body. Keep transient execution logs and self-improvement finding classifications in the issue or PR, not in this knowledge base.

Merge only after actionable review feedback and applicable checks are resolved. Do not change the installed plugin before the implementation has merged.

## Version and distribute

After the feature merges, create an issue-linked release branch from synchronized `main`, increment `package.json`'s version, and add the corresponding `CHANGELOG.md` entry. Keep version metadata and documentation in separate commits, matching existing history. Run `bun run release:check` and `git diff --check origin/main...HEAD`, then review and merge the linked release PR.

From synchronized `main`, create the version tag and GitHub release. For example, replace `X.Y.Z` with the version just merged:

```sh
gh release create vX.Y.Z --target main --title "Release X.Y.Z" --notes-file <release-notes-file>
gh release view vX.Y.Z
```

Read back the remote tag/release and default-branch package version before claiming publication. Do not publish session data or workstation-specific paths in release notes.

## Install and prove the released artifact

```sh
omp plugin uninstall omp-worktree-status
omp plugin install github:klondikemarlen/omp-worktree-status
omp plugin list
```

Verify the installed version equals the released `package.json` version. If the installer resolves stale cached content, use `--force` with the same default-branch reference and verify again; a successful install command alone does not prove the version.

Start a new OMP process with normal plugin discovery. Exercise status brightness, combined root paths, separate subdirectory paths, and both editor command completions. Do not rely on a still-running process or explicitly load the source checkout for release QA.

Update the canonical PR evidence with observed release, install, and fresh-process outcomes. Remove only agent-owned temporary fixtures, and return to clean, synchronized `main`; preserve user-owned branches and worktrees.
