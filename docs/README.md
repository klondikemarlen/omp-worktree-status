# Project Knowledge

This guide is for contributors and agents changing the worktree-status plugin. Start with the [user guide](/README.md) for installation, status examples, and editor configuration.

- [Architecture and invariants](/docs/architecture.md): which layer owns directory selection, session state, formatting, and editor actions.
- [Status QA scenarios](/docs/qa-scenarios/status.md): exercise readable status and adjacent behavior in a real OMP process.
- [Release procedure](/docs/workflows/release.md): repository-specific verification, GitHub distribution, and fresh-process installation checks.

## Authority and publication

The user guide describes the intended public behavior. `index.ts` implements it; `index.test.ts` provides automated behavioral evidence. Real terminal QA covers rendering and autocomplete that the test theme stub cannot demonstrate.

This is a public repository: documentation and fixtures must not include credentials, private checkout paths, or session data. No documentation site is configured. A future site must explicitly select its public inputs rather than publish the entire repository automatically.
