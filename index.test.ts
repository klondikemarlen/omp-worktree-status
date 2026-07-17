import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import worktreeStatusExtension, {
  type ExtensionApi,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionHandler,
  formatStatus,
  inspectWorktree,
  toolDirectory,
} from "./index.ts"

describe("toolDirectory", () => {
  test("prefers an explicit tool cwd", () => {
    expect(toolDirectory({ cwd: "/tmp/worktree", command: "cd /ignored && git status" }, "/tmp/session")).toBe("/tmp/worktree")
  })

  test("tracks the leading cd used by a Bash command", () => {
    expect(toolDirectory({ command: "cd ~/code/wrap-issue-438 && git status --short" }, "/tmp/session")).toBe(`${homedir()}/code/wrap-issue-438`)
  })
})

describe("inspectWorktree", () => {
  test("reports the linked worktree and branch", () => {
    const output: Record<string, string> = {
      "rev-parse --show-toplevel": "/code/wrap-issue-438",
      "rev-parse --absolute-git-dir": "/code/wrap/.git/worktrees/wrap-issue-438",
      "rev-parse --path-format=absolute --git-common-dir": "/code/wrap/.git",
      "branch --show-current": "issue-438/prevent-stale-uat-back-merge",
    }

    const status = inspectWorktree("/code/wrap-issue-438/api", (_cwd, args) => output[args.join(" ")])

    expect(status).toEqual({
      directory: "/code/wrap-issue-438/api",
      worktree: "/code/wrap-issue-438",
      branch: "issue-438/prevent-stale-uat-back-merge",
      linked: true,
    })
    expect(formatStatus(status)).toBe(
      "cwd: /code/wrap-issue-438/api · wt: /code/wrap-issue-438 · branch: issue-438/prevent-stale-uat-back-merge",
    )
  })
})

describe("worktreeStatusExtension", () => {
  test("updates only the top-level status from the latest Bash directory", () => {
    const handlers: Partial<Record<ExtensionEvent, ExtensionHandler>> = {}
    const statuses: Array<string | undefined> = []
    const context = {
      cwd: "/tmp/session",
      sessionManager: { getHeader: () => null },
      ui: {
        setStatus(_key: string, text: string | undefined) {
          statuses.push(text)
        },
        theme: { fg(_color: string, text: string) { return text } },
      },
    } satisfies ExtensionContext
    const plugin = {
      on(event: ExtensionEvent, handler: ExtensionHandler) {
        handlers[event] = handler
      },
    } satisfies ExtensionApi

    worktreeStatusExtension(plugin)

    const sessionStart = handlers.session_start
    const toolCall = handlers.tool_call
    if (!sessionStart || !toolCall) throw new Error("Expected status handlers.")
    sessionStart({}, context)
    toolCall({ toolName: "bash", input: { command: "cd /tmp/worktree && git status" } }, context)

    expect(statuses).toEqual([
      "cwd: /tmp/session · not a Git worktree",
      "cwd: /tmp/worktree · not a Git worktree",
    ])
  })
})
