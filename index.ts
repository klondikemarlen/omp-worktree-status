import { execFileSync, spawn } from "node:child_process"
import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const STATUS_KEY = "worktree-status"
export const ACTIVE_WORKTREE_CONTEXT = Symbol.for("omp-worktree-status.active-worktree-context")


type ToolInput = Record<string, unknown>
type GitRunner = (cwd: string, args: string[]) => string | undefined

export type ExtensionContext = {
  cwd: string
  sessionManager: {
    getHeader(): { parentSession?: unknown } | null
    getEntries?(): unknown[]
    appendCustomEntry?(customType: string, data: Record<string, unknown>): string
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
    setStatus(key: string, text: string | undefined): void
    theme: { fg(color: string, text: string): string }
  }
}

export type ExtensionEvent = "session_start" | "session_switch" | "session_shutdown" | "tool_call" | "tool_result"
type ExtensionEventPayload = {
  toolCallId?: string
  toolName?: string
  input?: ToolInput
  details?: { exitCode?: number; async?: { state?: "running" | "completed" | "failed" } }
  isError?: boolean
}

export type ExtensionHandler = (event: ExtensionEventPayload, ctx: ExtensionContext) => { input: ToolInput } | void
export type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>

export type ExtensionApi = {
  on(event: ExtensionEvent, handler: ExtensionHandler): void
  registerCommand(name: string, options: { description?: string; handler: CommandHandler }): void
}

export type WorktreeStatus = {
  directory: string
  worktree?: string
  branch?: string
  linked: boolean
}

export type ActiveWorktreeContext = Readonly<WorktreeStatus>

export function getActiveWorktreeContext(): ActiveWorktreeContext | undefined {
  return (globalThis as Record<symbol, ActiveWorktreeContext | undefined>)[ACTIVE_WORKTREE_CONTEXT]
}

type StatusEnvironment = { PTYXIS_VERSION?: string }


function unquote(directory: string): string | undefined {
  if (directory.startsWith("'") && directory.endsWith("'")) return directory.slice(1, -1)
  if (directory.startsWith('"') && directory.endsWith('"')) return directory.slice(1, -1)
  return /^[^\s;&|]+$/.test(directory) ? directory : undefined
}

function commandDirectory(command: string, cwd: string): string | undefined {
  const directory = command.match(/^\s*cd(?:\s+--)?\s+((?:'[^']*'|"[^"]*"|[^\s;&|]+))\s*&&/)?.[1]
  const parsed = directory && unquote(directory)
  if (!parsed) return undefined
  const expanded = parsed === "~" || parsed.startsWith("~/") ? `${homedir()}${parsed.slice(1)}` : parsed
  return resolve(cwd, expanded)
}

export function toolDirectory(input: ToolInput, sessionCwd: string): string | undefined {
  if (typeof input.cwd === "string" && input.cwd.trim()) {
    const directory = input.cwd.trim()
    const expanded = directory === "~" || directory.startsWith("~/") ? `${homedir()}${directory.slice(1)}` : directory
    return isAbsolute(expanded) ? expanded : resolve(sessionCwd, expanded)
  }

  return typeof input.command === "string" ? commandDirectory(input.command, sessionCwd) : undefined
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

export type EditorEnvironment = { VISUAL?: string; EDITOR?: string }

export function getEditorCommand(
  environment: EditorEnvironment = process.env,
  platform = process.platform,
): string | undefined {
  return environment.VISUAL?.trim() || environment.EDITOR?.trim() || (platform === "win32" ? "notepad" : undefined)
}

export type MergeEditorEnvironment = { MERGE_EDITOR?: string; PATH?: string }

function commandArguments(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((argument) => argument.replace(/^["']|["']$/g, "")) ?? []
}

function commandOnPath(command: string, environment: MergeEditorEnvironment): boolean {
  const [executable] = commandArguments(command)
  if (!executable) return false
  if (executable.includes("/") || executable.includes("\\")) {
    try {
      accessSync(executable, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return (environment.PATH ?? process.env.PATH ?? "").split(delimiter).some((directory) => {
    try {
      accessSync(join(directory, executable), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

export function getMergeEditorCommand(
  directory: string,
  environment: MergeEditorEnvironment = process.env,
  git: GitRunner = runGit,
): string | undefined {
  const configured = environment.MERGE_EDITOR?.trim()
  if (configured) return configured
  const mergeTool = git(directory, ["config", "--get", "merge.tool"])
  return mergeTool && commandOnPath(mergeTool, environment) ? mergeTool : undefined
}


function workspaceFile(directory: string): string | undefined {
  try {
    const workspace = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".code-workspace"))
      .sort((a, b) => a.name.localeCompare(b.name))[0]
    return workspace && join(directory, workspace.name)
  } catch {
    return undefined
  }
}



export function openInEditor(
  editorCommand: string,
  directory: string,
  onError?: (error: Error) => void,
  workspaceDirectory = directory,
): void {
  const [editor, ...args] = commandArguments(editorCommand)
  if (!editor) throw new Error("Editor command is empty.")
  const codeEditor = /(?:^|[/\\])(?:code(?:-insiders)?|codium|cursor|windsurf|devin(?:-desktop)?)(?:\.exe)?$/i.test(editor)
  const target = codeEditor ? workspaceFile(workspaceDirectory) ?? directory : directory
  const child = spawn(editor, [...args, ...(codeEditor ? ["--new-window"] : []), target], { detached: true, stdio: "ignore", windowsHide: true })
  if (onError) child.once("error", onError)
  child.unref()
}

export function openInMergeEditor(
  mergeEditorCommand: string,
  directory: string,
  onError?: (error: Error) => void,
): void {
  const [editor, ...args] = commandArguments(mergeEditorCommand)
  if (!editor) throw new Error("Merge editor command is empty.")
  const child = spawn(editor, [...args, directory], { detached: true, stdio: "ignore", windowsHide: true })
  if (onError) child.once("error", onError)
  child.unref()
}

export function inspectWorktree(directory: string, git: GitRunner = runGit): WorktreeStatus {
  const worktree = git(directory, ["rev-parse", "--show-toplevel"])
  if (!worktree) return { directory, linked: false }

  const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"])
  const commonDir = git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const branch = git(directory, ["branch", "--show-current"]) || undefined

  return { directory, worktree, branch, linked: Boolean(gitDir && commonDir && gitDir !== commonDir) }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function savedDirectory(entry: unknown): string | undefined {
  if (
    !entry ||
    typeof entry !== "object" ||
    !("type" in entry) ||
    !("customType" in entry) ||
    !("data" in entry) ||
    entry.type !== "custom" ||
    entry.customType !== STATUS_KEY ||
    !entry.data ||
    typeof entry.data !== "object" ||
    !("directory" in entry.data)
  ) return undefined
  const { directory } = entry.data
  return typeof directory === "string" && directory.trim() ? directory : undefined
}

function latestSavedDirectory(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const directory = savedDirectory(entries[index])
    if (directory) return directory
  }
  return undefined
}


export function formatStatus(
  status: WorktreeStatus,
  sessionDirectory = status.directory,
  environment: StatusEnvironment = {},
): string {
  if (status.worktree && !status.linked && canonicalPath(status.worktree) === canonicalPath(sessionDirectory)) return ""
  const home = homedir()
  const directory = status.directory === home
    ? "~"
    : status.directory.startsWith(`${home}/`) ? `~/${relative(home, status.directory)}` : status.directory
  const directoryText = environment.PTYXIS_VERSION
    ? `\u001B]8;;${pathToFileURL(resolve(status.directory)).href}\u001B\\${directory}\u001B]8;;\u001B\\`
    : directory
  const details = [`cwd: ${directoryText}`]
  if (status.worktree && canonicalPath(status.directory) !== canonicalPath(status.worktree)) {
    const worktree = status.worktree === home
      ? "~"
      : status.worktree.startsWith(`${home}/`) ? `~/${relative(home, status.worktree)}` : status.worktree
    const worktreeText = environment.PTYXIS_VERSION
      ? `\u001B]8;;${pathToFileURL(resolve(status.worktree)).href}\u001B\\${worktree}\u001B]8;;\u001B\\`
      : worktree
    details.push(`wt: ${worktreeText}`)
  } else if (status.worktree) {
    details[0] = `cwd/wt: ${directoryText}`
  }
  if (status.branch) details.push(`branch: ${status.branch}`)
  else if (status.worktree) details.push("branch: detached")
  else details.push("not a Git worktree")
  return details.join(" · ")
}


export default function worktreeStatusExtension(pi: ExtensionApi): void {
  let activeDirectory: string | undefined
  let activeText: string | undefined
  let activeContext: ActiveWorktreeContext | undefined
  let sessionDirectory: string | undefined
  const redirectedCalls = new Map<string, { input: ToolInput; directory: string }>()

  Object.defineProperty(globalThis, ACTIVE_WORKTREE_CONTEXT, {
    configurable: true,
    get: () => activeContext,
  })

  const clear = () => {
    activeDirectory = undefined
    activeContext = undefined
    activeText = undefined
  }

  const update = (ctx: ExtensionContext, directory: string, status = inspectWorktree(directory)) => {
    const parentSession = ctx.sessionManager.getHeader()?.parentSession
    if (typeof parentSession === "string" && parentSession.length > 0) return
    activeDirectory = directory
    activeContext = Object.freeze({ ...status })
    const text = formatStatus(status, ctx.cwd, process.env)
    if (text === activeText) return
    activeText = text
    ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("text", text) : undefined)
  }

  const reset = (ctx: ExtensionContext) => {
    clear()
    sessionDirectory = ctx.cwd.trim() || undefined
    const parentSession = ctx.sessionManager.getHeader()?.parentSession
    if (!sessionDirectory || (typeof parentSession === "string" && parentSession.length > 0)) {
      ctx.ui.setStatus(STATUS_KEY, undefined)
      return
    }
    const restoredDirectory = latestSavedDirectory(ctx.sessionManager.getEntries?.() ?? [])
    if (restoredDirectory) {
      const status = existsSync(restoredDirectory) && inspectWorktree(restoredDirectory)
      if (status && status.worktree) {
        update(ctx, restoredDirectory, status)
        return
      }
      ctx.ui.notify("Saved worktree is unavailable; using the session directory.", "warning")
    }
    update(ctx, sessionDirectory)
  }

  const ensureSession = (ctx: ExtensionContext) => {
    if (sessionDirectory !== (ctx.cwd.trim() || undefined)) reset(ctx)
  }

  pi.registerCommand("open-in-editor", {
    description: "Open the active directory in $VISUAL or $EDITOR.",
    handler: async (_args, ctx) => {
      const editor = getEditorCommand()
      if (!editor) {
        ctx.ui.notify("No editor configured. Set $VISUAL or $EDITOR, then run /open-in-editor.", "error")
        return
      }
      const directory = activeDirectory ?? ctx.cwd
      const worktree = inspectWorktree(directory).worktree ?? directory
      try {
        openInEditor(editor, directory, () => {
          ctx.ui.notify(`Could not start ${editor}. Verify $VISUAL or $EDITOR, then try /open-in-editor.`, "error")
        }, worktree)
      } catch {
        ctx.ui.notify(`Could not start ${editor}. Verify $VISUAL or $EDITOR, then try /open-in-editor.`, "error")
      }
    },
  })

  pi.registerCommand("open-in-merge-editor", {
    description: "Open the active worktree in $MERGE_EDITOR or Git merge.tool.",
    handler: async (_args, ctx) => {
      const directory = activeDirectory ?? ctx.cwd
      const editor = getMergeEditorCommand(directory)
      if (!editor) {
        ctx.ui.notify("No merge editor configured. Set $MERGE_EDITOR or Git merge.tool, then run /open-in-merge-editor.", "error")
        return
      }
      const worktree = inspectWorktree(directory).worktree ?? directory
      try {
        openInMergeEditor(editor, worktree, () => {
          ctx.ui.notify(`Could not start ${editor}. Verify $MERGE_EDITOR or Git merge.tool, then try /open-in-merge-editor.`, "error")
        })
      } catch {
        ctx.ui.notify(`Could not start ${editor}. Verify $MERGE_EDITOR or Git merge.tool, then try /open-in-merge-editor.`, "error")
      }
    },
  })

  pi.on("session_start", (_event, ctx) => reset(ctx))
  pi.on("session_switch", (_event, ctx) => reset(ctx))
  pi.on("tool_call", (event, ctx) => {
    ensureSession(ctx)
    if (
      event.toolName !== "bash" ||
      !event.toolCallId ||
      !event.input ||
      (typeof event.input.cwd === "string" && event.input.cwd.trim()) ||
      !activeDirectory ||
      activeDirectory === ctx.cwd
    ) return
    redirectedCalls.set(event.toolCallId, { input: event.input, directory: activeDirectory })
    return { input: { ...event.input, cwd: activeDirectory } }
  })
  pi.on("tool_result", (event, ctx) => {
    ensureSession(ctx)
    const redirected = event.toolCallId ? redirectedCalls.get(event.toolCallId) : undefined
    if (event.toolCallId) redirectedCalls.delete(event.toolCallId)
    if (
      event.toolName !== "bash" ||
      !event.input ||
      event.isError ||
      event.details?.async?.state === "running" ||
      event.details?.async?.state === "failed" ||
      (event.details?.exitCode !== undefined && event.details.exitCode !== 0)
    ) return
    const selectedDirectory = toolDirectory(redirected?.input ?? event.input, redirected?.directory ?? ctx.cwd)
    const directory = selectedDirectory ?? redirected?.directory ?? ctx.cwd
    if (!directory) return
    update(ctx, directory)
    if (selectedDirectory) ctx.sessionManager.appendCustomEntry?.(STATUS_KEY, { directory: selectedDirectory })
  })
  pi.on("session_shutdown", (_event, ctx) => {
    sessionDirectory = undefined
    clear()
    ctx.ui.setStatus(STATUS_KEY, undefined)
    redirectedCalls.clear()
  })
}
