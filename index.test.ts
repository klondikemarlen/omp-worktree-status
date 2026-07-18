import { chmod, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import worktreeStatusExtension, {
  type CommandHandler,
  type ExtensionApi,
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionHandler,
  formatStatus,
  getEditorCommand,
  inspectWorktree,
  openInEditor,
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

describe("getEditorCommand", () => {
  test("prefers VISUAL, then EDITOR, then the Windows default", () => {
    expect(getEditorCommand({ VISUAL: "code", EDITOR: "vim" })).toBe("code")
    expect(getEditorCommand({ EDITOR: "vim" })).toBe("vim")
    expect(getEditorCommand({}, "win32")).toBe("notepad")
    expect(getEditorCommand({})).toBeUndefined()
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

  test("keeps the worktree label at its root", () => {
    expect(
      formatStatus({
        directory: "/code/wrap-issue-438",
        worktree: "/code/wrap-issue-438",
        branch: "issue-438/prevent-stale-uat-back-merge",
        linked: true,
      }),
    ).toBe(
      "cwd: /code/wrap-issue-438 · wt: /code/wrap-issue-438 · branch: issue-438/prevent-stale-uat-back-merge",
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
        notify() {},
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
      registerCommand() {},
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

describe("open-in-editor", () => {
  test("opens the active worktree with the configured editor", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const editor = join(temporaryDirectory, "editor")
    const openedPath = join(temporaryDirectory, "opened-path")
    const previousVisual = process.env.VISUAL
    const previousEditor = process.env.EDITOR
    const previousOutput = process.env.OMP_EDITOR_OUTPUT
    let command: CommandHandler | undefined

    await writeFile(editor, '#!/bin/sh\nprintf "%s" "$1" > "$OMP_EDITOR_OUTPUT"\n')
    await chmod(editor, 0o755)
    process.env.VISUAL = editor
    delete process.env.EDITOR
    process.env.OMP_EDITOR_OUTPUT = openedPath

    try {
      const handlers: Partial<Record<ExtensionEvent, ExtensionHandler>> = {}
      const context = {
        cwd: "/tmp/session",
        sessionManager: { getHeader: () => null },
        ui: { notify() {}, setStatus() {}, theme: { fg(_color: string, text: string) { return text } } },
      } satisfies ExtensionContext
      const plugin = {
        on(event: ExtensionEvent, handler: ExtensionHandler) {
          handlers[event] = handler
        },
        registerCommand(name: string, options: { handler: CommandHandler }) {
          if (name === "open-in-editor") command = options.handler
        },
      } satisfies ExtensionApi

      worktreeStatusExtension(plugin)
      handlers.tool_call?.({ toolName: "bash", input: { command: "cd /tmp/worktree && git status" } }, context)
      if (!command) throw new Error("Expected /open-in-editor command.")
      const watcher = watch(temporaryDirectory)[Symbol.asyncIterator]()
      try {
        const opened = watcher.next()
        await command("", context)
        await opened
      } finally {
        await watcher.return?.()
      }
      expect(await readFile(openedPath, "utf8")).toBe("/tmp/worktree")
    } finally {
      if (previousVisual === undefined) delete process.env.VISUAL
      else process.env.VISUAL = previousVisual
      if (previousEditor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = previousEditor
      if (previousOutput === undefined) delete process.env.OMP_EDITOR_OUTPUT
      else process.env.OMP_EDITOR_OUTPUT = previousOutput
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test("opens VS Code worktrees in a new window", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const editor = join(temporaryDirectory, "code")
    const openedArguments = join(temporaryDirectory, "opened-arguments")
    const previousOutput = process.env.OMP_EDITOR_OUTPUT

    await writeFile(editor, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_EDITOR_OUTPUT"\n')
    await chmod(editor, 0o755)
    process.env.OMP_EDITOR_OUTPUT = openedArguments

    try {
      const watcher = watch(temporaryDirectory)[Symbol.asyncIterator]()
      try {
        const opened = watcher.next()
        openInEditor(editor, "/tmp/worktree")
        await opened
      } finally {
        await watcher.return?.()
      }
      expect(await readFile(openedArguments, "utf8")).toBe("--new-window\n/tmp/worktree\n")
    } finally {
      if (previousOutput === undefined) delete process.env.OMP_EDITOR_OUTPUT
      else process.env.OMP_EDITOR_OUTPUT = previousOutput
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test("reports a missing editor configuration", async () => {
    const previousVisual = process.env.VISUAL
    const previousEditor = process.env.EDITOR
    const notifications: string[] = []
    let command: CommandHandler | undefined
    delete process.env.VISUAL
    delete process.env.EDITOR

    try {
      const context = {
        cwd: "/tmp/session",
        sessionManager: { getHeader: () => null },
        ui: {
          notify(message: string) { notifications.push(message) },
          setStatus() {},
          theme: { fg(_color: string, text: string) { return text } },
        },
      } satisfies ExtensionContext
      const plugin = {
        on() {},
        registerCommand(name: string, options: { handler: CommandHandler }) {
          if (name === "open-in-editor") command = options.handler
        },
      } satisfies ExtensionApi

      worktreeStatusExtension(plugin)
      if (!command) throw new Error("Expected /open-in-editor command.")
      await command("", context)
      expect(notifications).toEqual(["No editor configured. Set $VISUAL or $EDITOR, then run /open-in-editor."])
    } finally {
      if (previousVisual === undefined) delete process.env.VISUAL
      else process.env.VISUAL = previousVisual
      if (previousEditor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = previousEditor
    }
  })
})
