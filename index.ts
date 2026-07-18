import { execFileSync, spawn } from "node:child_process"
import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const STATUS_KEY = "worktree-status"

type ToolInput = Record<string, unknown>
type GitRunner = (cwd: string, args: string[]) => string | undefined

export type ExtensionContext = {
  cwd: string
  sessionManager: {
    getHeader(): { parentSession?: unknown } | null
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
    setStatus(key: string, text: string | undefined): void
    theme: { fg(color: string, text: string): string }
  }
}

export type ExtensionEvent = "session_start" | "session_switch" | "session_shutdown" | "tool_call"
export type ExtensionHandler = (event: { toolName?: string; input?: ToolInput }, ctx: ExtensionContext) => void
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

type StatusEnvironment = { PTYXIS_VERSION?: string }


function unquote(directory: string): string | undefined {
  if (directory.startsWith("'") && directory.endsWith("'")) return directory.slice(1, -1)
  if (directory.startsWith('"') && directory.endsWith('"')) return directory.slice(1, -1)
  return /^[^\s;&|]+$/.test(directory) ? directory : undefined
}

function commandDirectory(command: string, cwd: string): string | undefined {
  const directory = command.match(/^\s*cd(?:\s+--)?\s+((?:'[^']*'|"[^"]*"|[^\s;&|]+))\s*(?:&&|;|\n)/)?.[1]
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

export function openInEditor(
  editorCommand: string,
  directory: string,
  onError?: (error: Error) => void,
): void {
  const command = editorCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((argument) => argument.replace(/^["']|["']$/g, "")) ?? []
  const [editor, ...args] = command
  if (!editor) throw new Error("Editor command is empty.")
  const newWindow = /(?:^|[/\\])(?:code(?:-insiders)?|codium|cursor|windsurf|devin(?:-desktop)?)(?:\.exe)?$/i.test(editor) ? ["--new-window"] : []
  const child = spawn(editor, [...args, ...newWindow, directory], { detached: true, stdio: "ignore", windowsHide: true })
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


export function formatStatus(
  status: WorktreeStatus,
  sessionDirectory = status.directory,
  environment: StatusEnvironment = {},
): string {
  if (status.worktree && status.branch === "main" && resolve(status.worktree) === resolve(sessionDirectory)) return ""
  const home = homedir()
  const directory = status.directory === home
    ? "~"
    : status.directory.startsWith(`${home}/`) ? `~/${relative(home, status.directory)}` : status.directory
  const directoryText = environment.PTYXIS_VERSION
    ? `\u001B]8;;${pathToFileURL(resolve(status.directory)).href}\u001B\\${directory}\u001B]8;;\u001B\\`
    : directory
  const details = [`cwd: ${directoryText}`]
  if (status.worktree) {
    const worktree = status.worktree === home
      ? "~"
      : status.worktree.startsWith(`${home}/`) ? `~/${relative(home, status.worktree)}` : status.worktree
    const worktreeText = environment.PTYXIS_VERSION
      ? `\u001B]8;;${pathToFileURL(resolve(status.worktree)).href}\u001B\\${worktree}\u001B]8;;\u001B\\`
      : worktree
    details.push(`wt: ${worktreeText}`)
  }
  if (status.branch) details.push(`branch: ${status.branch}`)
  else if (status.worktree) details.push("branch: detached")
  else details.push("not a Git worktree")
  return details.join(" · ")
}


export default function worktreeStatusExtension(pi: ExtensionApi): void {
  let activeDirectory: string | undefined

  const update = (ctx: ExtensionContext, directory: string) => {
    const parentSession = ctx.sessionManager.getHeader()?.parentSession
    if ((typeof parentSession === "string" && parentSession.length > 0) || directory === activeDirectory) return
    activeDirectory = directory
    const text = formatStatus(inspectWorktree(directory), ctx.cwd, process.env)
    ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("dim", text) : undefined)
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
      try {
        openInEditor(editor, directory, () => {
          ctx.ui.notify(`Could not start ${editor}. Verify $VISUAL or $EDITOR, then try /open-in-editor.`, "error")
        })
      } catch {
        ctx.ui.notify(`Could not start ${editor}. Verify $VISUAL or $EDITOR, then try /open-in-editor.`, "error")
      }
    },
  })

  pi.on("session_start", (_event, ctx) => update(ctx, ctx.cwd))
  pi.on("session_switch", (_event, ctx) => update(ctx, ctx.cwd))
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || !event.input) return
    const directory = toolDirectory(event.input, activeDirectory ?? ctx.cwd)
    if (directory) update(ctx, directory)
  })
  pi.on("session_shutdown", (_event, ctx) => {
    activeDirectory = undefined
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
