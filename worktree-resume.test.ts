import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import worktreeStatusExtension, {
  type ExtensionContext,
  type ExtensionEvent,
  type ExtensionHandler,
  getActiveWorktreeContext,
} from "./index.ts"

function startSession(cwd: string, entries: unknown[]) {
  const handlers = new Map<ExtensionEvent, ExtensionHandler>()
  const context: ExtensionContext = {
    cwd,
    sessionManager: {
      getHeader: () => null,
      getEntries: () => entries,
      appendCustomEntry(customType, data) {
        entries.push({
          type: "custom",
          customType,
          data,
        })
        return String(entries.length)
      },
    },
    ui: {
      notify() {},
      setStatus() {},
      theme: {
        fg: (_color, text) => text,
      },
    },
  }

  worktreeStatusExtension({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand() {},
  })
  handlers.get("session_start")!({}, context)

  return function selectDirectory(directory: string) {
    handlers.get("tool_result")!({
      toolName: "bash",
      input: {
        cwd: directory,
      },
    }, context)
  }
}

describe("worktree selection across resume", () => {
  let sandbox: string
  let repository: string
  let workingDirectory: string
  let entries: unknown[]

  function git(...args: string[]) {
    execFileSync("git", ["-C", repository, ...args], {
      stdio: "ignore",
    })
  }

  function createDetachedCheckout(handoffId: string) {
    const handoffDirectory = join(sandbox, handoffId)
    const checkout = join(handoffDirectory, "checkout")
    mkdirSync(handoffDirectory)
    writeFileSync(join(handoffDirectory, "handoff.json"), JSON.stringify({
      id: handoffId,
    }))
    git("worktree", "add", "--detach", checkout, "HEAD")
    return checkout
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "worktree-resume-"))
    repository = join(sandbox, "project")
    workingDirectory = join(sandbox, "feature")
    entries = []
    mkdirSync(repository)
    git("init", "--initial-branch=main")
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "Initial")
    git("worktree", "add", "-b", "feature", workingDirectory)
  })

  afterEach(() => {
    rmSync(sandbox, {
      recursive: true,
      force: true,
    })
  })

  test("when Bash visits a non-Git QA directory, resume restores the selected worktree", () => {
    // Arrange
    const scratch = join(sandbox, "qa")
    mkdirSync(scratch)
    const selectDirectory = startSession(repository, entries)
    selectDirectory(workingDirectory)

    // Act
    selectDirectory(scratch)
    startSession(repository, entries)

    // Assert
    expect(getActiveWorktreeContext()?.directory).toBe(workingDirectory)
  })

  test("when a Verifier checkout is released after use, resume restores the selected worktree", () => {
    // Arrange
    const handoffId = randomUUID()
    const pin = `refs/omp-verifier/deliveries/${handoffId}`
    git("update-ref", pin, "HEAD")
    const checkout = createDetachedCheckout(handoffId)
    const subdirectory = join(checkout, "src")
    mkdirSync(subdirectory)
    const selectDirectory = startSession(repository, entries)
    selectDirectory(workingDirectory)

    // Act
    selectDirectory(subdirectory)
    git("worktree", "remove", checkout)
    git("update-ref", "-d", pin)
    startSession(repository, entries)

    // Assert
    expect(getActiveWorktreeContext()?.directory).toBe(workingDirectory)
  })

  test("when a detached checkout resembles a handoff but has no matching pin, resume restores it", () => {
    // Arrange
    const checkout = createDetachedCheckout(randomUUID())
    const selectDirectory = startSession(repository, entries)

    // Act
    selectDirectory(checkout)
    startSession(repository, entries)

    // Assert
    expect(getActiveWorktreeContext()?.directory).toBe(checkout)
  })
})
