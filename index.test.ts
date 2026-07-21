import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, watch, writeFile } from "node:fs/promises"
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
  getActiveWorktreeContext,
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
    expect(toolDirectory({ command: "cd /missing; true" }, "/tmp/session")).toBeUndefined()
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
      formatStatus(
        {
          directory: "/code/wrap-issue-438",
          worktree: "/code/wrap-issue-438",
          branch: "issue-438/prevent-stale-uat-back-merge",
          linked: true,
        },
        "/code/session",
      ),
    ).toBe(
      "cwd: /code/wrap-issue-438 · wt: /code/wrap-issue-438 · branch: issue-438/prevent-stale-uat-back-merge",
    )
  })

  test("omits primary worktree context regardless of branch", () => {
    const status = {
      directory: "/code/project/subdir",
      worktree: "/code/project",
      branch: "main",
      linked: false,
    }

    expect(formatStatus(status, "/code/project/../project")).toBe("")
    expect(formatStatus({ ...status, branch: "feature" }, "/code/project")).toBe("")
    expect(formatStatus(status, "/code/session")).toBe("cwd: /code/project/subdir · wt: /code/project · branch: main")
    expect(formatStatus({ ...status, linked: true }, "/code/project")).toBe(
      "cwd: /code/project/subdir · wt: /code/project · branch: main",
    )
  })

  test("formats home-relative paths with a slash", () => {
    const home = homedir()

    expect(formatStatus({ directory: home, worktree: home, branch: "feature", linked: false }, "/tmp/session")).toBe(
      "cwd: ~ · wt: ~ · branch: feature",
    )
    expect(formatStatus({
      directory: `${home}/code/project`,
      worktree: `${home}/code/project`,
      branch: "feature",
      linked: false,
    }, "/tmp/session")).toBe("cwd: ~/code/project · wt: ~/code/project · branch: feature")
    expect(formatStatus({
      directory: `${home}-other/project`,
      worktree: `${home}-other/project`,
      branch: "feature",
      linked: false,
    }, "/tmp/session")).toBe(`cwd: ${home}-other/project · wt: ${home}-other/project · branch: feature`)
  })

  test("links status paths only in Ptyxis", () => {
    const status = {
      directory: "/tmp/project with spaces",
      worktree: "/tmp/worktree#one",
      branch: "feature",
      linked: false,
    }
    const escape = "\u001B"
    const opened = formatStatus(status, status.directory, { PTYXIS_VERSION: "48.0" })

    expect(opened).toBe(
      `cwd: ${escape}]8;;file:///tmp/project%20with%20spaces${escape}\\${status.directory}${escape}]8;;${escape}\\ · wt: ${escape}]8;;file:///tmp/worktree%23one${escape}\\${status.worktree}${escape}]8;;${escape}\\ · branch: feature`,
    )
    expect(formatStatus(status, status.directory, {})).toBe(
      "cwd: /tmp/project with spaces · wt: /tmp/worktree#one · branch: feature",
    )
    expect(formatStatus(status, status.directory, {})).not.toContain(escape)
  })
})

describe("worktreeStatusExtension", () => {
  test("updates status without duplicating relative Bash cwd values", () => {
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
    const toolResult = handlers.tool_result
    if (!sessionStart || !toolResult) throw new Error("Expected status handlers.")
    sessionStart({}, context)
    const inputs = [
      { command: "cd /tmp/worktree && git status" },
      { cwd: "web" },
      { cwd: "web/api" },
      { command: "cd web && git status" },
      { command: "cd web && git status" },
    ]
    for (const input of inputs) toolResult({ toolName: "bash", input: { ...input } }, context)

    expect(statuses).toEqual([
      formatStatus({ directory: "/tmp/session", linked: false }, context.cwd, process.env),
      formatStatus({ directory: "/tmp/worktree", linked: false }, context.cwd, process.env),
      formatStatus({ directory: "/tmp/session/web", linked: false }, context.cwd, process.env),
      formatStatus({ directory: "/tmp/session/web/api", linked: false }, context.cwd, process.env),
      formatStatus({ directory: "/tmp/session/web", linked: false }, context.cwd, process.env),
    ])
  })

  test("refreshes branch metadata when Bash stays in the active directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const handlers: Partial<Record<ExtensionEvent, ExtensionHandler>> = {}
    const statuses: Array<string | undefined> = []
    const context = {
      cwd: join(directory, "session"),
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

    try {
      execFileSync("git", ["init", "--initial-branch=first", directory], { stdio: "ignore" })
      worktreeStatusExtension(plugin)
      const sessionStart = handlers.session_start
      const toolResult = handlers.tool_result
      if (!sessionStart || !toolResult) throw new Error("Expected status handlers.")
      sessionStart({}, context)
      toolResult({ toolName: "bash", input: { cwd: directory } }, context)
      execFileSync("git", ["-C", directory, "branch", "-M", "second"], { stdio: "ignore" })
      toolResult({ toolName: "bash", input: { cwd: directory } }, context)

      expect(statuses).toHaveLength(3)
      expect(statuses[1]).toContain("branch: first")
      expect(statuses[2]).toContain("branch: second")
      expect(getActiveWorktreeContext()).toMatchObject({ directory, branch: "second" })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("publishes immutable successful Bash context and clears it per session", () => {
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
      registerCommand() {},
    } satisfies ExtensionApi

    worktreeStatusExtension(plugin)

    const sessionStart = handlers.session_start
    const sessionSwitch = handlers.session_switch
    const sessionShutdown = handlers.session_shutdown
    const toolResult = handlers.tool_result
    if (!sessionStart || !sessionSwitch || !sessionShutdown || !toolResult) throw new Error("Expected status handlers.")
    sessionStart({}, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/session", linked: false })

    toolResult({ toolName: "bash", input: { cwd: "/tmp/failed" }, isError: true }, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/session", linked: false })
    toolResult({ toolName: "bash", input: { cwd: "/tmp/failed" }, details: { exitCode: 1 } }, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/session", linked: false })
    toolResult({ toolName: "bash", input: { cwd: "/tmp/failed" }, details: { async: { state: "running" } } }, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/session", linked: false })

    toolResult({ toolName: "bash", input: { cwd: "/tmp/worktree" } }, context)
    const active = getActiveWorktreeContext()
    expect(active).toEqual({ directory: "/tmp/worktree", linked: false })
    expect(Object.isFrozen(active)).toBe(true)
    toolResult({ toolName: "bash", input: { command: "cd /tmp/missing; true" } }, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/worktree", linked: false })
    toolResult({ toolName: "bash", input: { command: "git status" } }, context)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/session", linked: false })

    const nextContext = { ...context, cwd: "/tmp/next-session" }
    sessionSwitch({}, nextContext)
    expect(getActiveWorktreeContext()).toEqual({ directory: "/tmp/next-session", linked: false })

    sessionShutdown({}, nextContext)
    expect(getActiveWorktreeContext()).toBeUndefined()
    sessionStart({}, { ...nextContext, cwd: " " })
    expect(getActiveWorktreeContext()).toBeUndefined()
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
      handlers.tool_result?.({ toolName: "bash", input: { command: "cd /tmp/worktree && git status" } }, context)
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

  test("opens a worktree workspace file in a new VS Code window", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const activeDirectory = join(temporaryDirectory, "nested")
    const editor = join(temporaryDirectory, "code")
    const workspace = join(temporaryDirectory, "project.code-workspace")
    const openedArguments = join(temporaryDirectory, "opened-arguments")
    const previousVisual = process.env.VISUAL
    const previousOutput = process.env.OMP_EDITOR_OUTPUT
    let command: CommandHandler | undefined

    await mkdir(activeDirectory)
    execFileSync("git", ["init", temporaryDirectory], { stdio: "ignore" })
    await writeFile(editor, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_EDITOR_OUTPUT"\n')
    await chmod(editor, 0o755)
    await writeFile(workspace, "{}")
    await writeFile(join(temporaryDirectory, "z-project.code-workspace"), "{}")
    process.env.VISUAL = editor
    process.env.OMP_EDITOR_OUTPUT = openedArguments

    try {
      const handlers: Partial<Record<ExtensionEvent, ExtensionHandler>> = {}
      const context = {
        cwd: activeDirectory,
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
      handlers.session_start?.({}, context)
      if (!command) throw new Error("Expected /open-in-editor command.")
      const watcher = watch(temporaryDirectory)[Symbol.asyncIterator]()
      try {
        const opened = watcher.next()
        await command("", context)
        await opened
      } finally {
        await watcher.return?.()
      }
      expect(await readFile(openedArguments, "utf8")).toBe(`--new-window\n${workspace}\n`)
    } finally {
      if (previousVisual === undefined) delete process.env.VISUAL
      else process.env.VISUAL = previousVisual
      if (previousOutput === undefined) delete process.env.OMP_EDITOR_OUTPUT
      else process.env.OMP_EDITOR_OUTPUT = previousOutput
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test("opens VS Code-compatible worktrees in a new window", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const editor = join(temporaryDirectory, "devin-desktop")
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

  test("parses quoted editor paths and arguments", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "omp-worktree-status-"))
    const editor = join(temporaryDirectory, "editor with spaces")
    const openedArguments = join(temporaryDirectory, "opened-arguments")
    const previousOutput = process.env.OMP_EDITOR_OUTPUT

    await writeFile(editor, '#!/bin/sh\nprintf "%s\\n" "$@" > "$OMP_EDITOR_OUTPUT"\n')
    await chmod(editor, 0o755)
    process.env.OMP_EDITOR_OUTPUT = openedArguments

    try {
      const watcher = watch(temporaryDirectory)[Symbol.asyncIterator]()
      try {
        const opened = watcher.next()
        openInEditor(`"${editor}" "--wait for editor"`, "/tmp/worktree")
        await opened
      } finally {
        await watcher.return?.()
      }
      expect(await readFile(openedArguments, "utf8")).toBe("--wait for editor\n/tmp/worktree\n")
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
