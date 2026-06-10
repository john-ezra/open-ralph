import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import type { LauncherResult, RunLauncherInput } from "../src/launcher.ts"
import { createTuiModule } from "../src/tui.ts"

type KeymapCommand = {
  namespace?: string
  name: string
  title?: string
  desc?: string
  category?: string
  enabled?: boolean
  hidden?: boolean
  slashName?: string
  run?: () => void | Promise<void>
}
type KeymapBinding = { key: string; cmd?: () => void; fallthrough?: boolean; preventDefault?: boolean }
type KeymapLayer = { commands: KeymapCommand[]; bindings: KeymapBinding[]; priority?: number }
type DialogSelectOption = { title: string; value: string; description?: string }
type DialogSelectProps = { title?: string; placeholder?: string; options: DialogSelectOption[]; onSelect?: (option: DialogSelectOption) => void }
type DialogConfirmProps = { message: string; onConfirm?: () => void; onCancel?: () => void }
type SessionModel = { id: string; providerID: string; variant?: string }

const defaultLauncherImplementation = async (input: RunLauncherInput): Promise<LauncherResult> => ({
  phase: input.phase,
  mode: "host-config-default",
  status: "complete",
  summary: "OpenRalph test run completed.",
})

let launcherImplementation: (input: RunLauncherInput) => Promise<LauncherResult> = defaultLauncherImplementation

const tuiModule = createTuiModule((input) => launcherImplementation(input))

describe("TUI plugin", () => {
  test("default-exports the file plugin module shape", () => {
    expect(tuiModule.id).toBe("openralph")
    expect(typeof tuiModule.tui).toBe("function")
  })

  test("registers palette commands with a single slash entry", async () => {
    let registeredLayer: KeymapLayer | undefined
    const disposers: Array<() => void> = []
    let promptProps: { title?: string; placeholder?: string } | undefined
    let selectProps: DialogSelectProps | undefined
    const dialog = {
      replace: (render: () => unknown) => render(),
      clear: () => undefined,
    }

    await tuiModule.tui(
      {
        keymap: {
          intercept: () => () => undefined,
          registerLayer: (layer: KeymapLayer) => {
            registeredLayer = layer
            return () => undefined
          },
        },
        lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
        ui: {
          dialog,
          DialogPrompt: (props: { title?: string; placeholder?: string }) => {
            promptProps = props
            return props
          },
          DialogSelect: (props: DialogSelectProps) => {
            selectProps = props
            return props
          },
          toast: () => undefined,
        },
      } as never,
      {},
      {} as never,
    )

    const commands = registeredLayer?.commands ?? []
    expect(registeredLayer?.bindings).toEqual([])
    expect(commands.map((command) => command.name).sort()).toEqual(["openralph"])
    expect(commands.every((command) => command.namespace === "palette")).toBe(true)
    expect(commands.every((command) => command.desc === undefined)).toBe(true)
    expect(commands.find((command) => command.name === "openralph")?.title).toBe("OpenRalph: Choose Phase")
    expect(commands.map((command) => command.slashName).filter(Boolean).sort()).toEqual(["ralph"])

    commands.find((command) => command.slashName === "ralph")?.run?.()

    expect(selectProps?.title).toBe("OpenRalph")
    expect(selectProps?.options.map((option) => option.value)).toEqual(["design", "plan", "build"])
    selectProps?.onSelect?.(selectProps.options[1])

    expect(promptProps?.title).toBe("OpenRalph: Plan")
    expect(promptProps?.placeholder).toBe("[number] [--model provider/model] [--no-docker]")

    selectProps?.onSelect?.(selectProps.options[2])

    expect(promptProps?.title).toBe("OpenRalph: Build")
    expect(promptProps?.placeholder).toBe("[number] [--model provider/model] [--push] [--no-docker]")
  })

  test("starts design in the current session from optional idea prompt", async () => {
    let registeredLayer: KeymapLayer | undefined
    let promptProps: { title?: string; placeholder?: string; onConfirm?: (value: string) => void } | undefined
    let selectProps: DialogSelectProps | undefined
    let sessionPrompt: { sessionID?: string; directory?: string; system?: string; parts?: Array<{ type: string; text: string }> } | undefined
    const disposers: Array<() => void> = []
    const toasts: Array<{ variant?: string; title?: string; message: string; duration?: number }> = []

    await tuiModule.tui(
      {
        keymap: {
          intercept: () => () => undefined,
          registerLayer: (layer: KeymapLayer) => {
            registeredLayer = layer
            return () => undefined
          },
        },
        lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
        state: { path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test" } },
        route: {
          current: { name: "session", params: { sessionID: "session-1" } },
          navigate: () => undefined,
        },
        client: {
          session: {
            create: async () => {
              throw new Error("session.create should not be called when a session is active")
            },
            prompt: async (input: typeof sessionPrompt) => {
              sessionPrompt = input
              return { data: {}, request: {}, response: {} }
            },
          },
        },
        ui: {
          dialog: {
            replace: (render: () => unknown) => render(),
            clear: () => undefined,
          },
          DialogPrompt: (props: { title?: string; placeholder?: string; onConfirm?: (value: string) => void }) => {
            promptProps = props
            return props
          },
          DialogSelect: (props: DialogSelectProps) => {
            selectProps = props
            return props
          },
          toast: (input: { variant?: string; title?: string; message: string; duration?: number }) => toasts.push(input),
        },
      } as never,
      {},
      {} as never,
    )

    const commands = registeredLayer?.commands ?? []
    commands.find((command) => command.name === "openralph")?.run?.()
    selectProps?.onSelect?.(selectProps.options[0])

    expect(promptProps?.title).toBe("OpenRalph: Design")
    expect(promptProps?.placeholder).toContain("optional")

    promptProps?.onConfirm?.("")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sessionPrompt?.sessionID).toBe("session-1")
    expect(sessionPrompt?.directory).toBe("/tmp/openralph-test")
    expect(sessionPrompt?.system).toContain("Ralph Design Requirements")
    expect(sessionPrompt?.system).toContain("planning-ready `specs/*.md`")
    expect(sessionPrompt?.parts?.[0]?.text).toContain("did not provide an initial idea")
    expect(toasts).toHaveLength(0)

    for (const dispose of disposers) dispose()
  })

  test("uses current session model as TUI plan/build fallback", async () => {
    const sessionModel = { providerID: "provider", id: "selected-model", variant: "high" }

    const planInput = await launchFromTui({ phase: "plan", prompt: "2 --no-docker", sessionModel })
    expect(planInput?.phase).toBe("plan")
    expect(planInput?.rawArgs).toBe("2 --no-docker --model provider/selected-model")

    const buildInput = await launchFromTui({ phase: "build", prompt: "", sessionModel })
    expect(buildInput?.phase).toBe("build")
    expect(buildInput?.rawArgs).toBe("--model provider/selected-model")
  })

  test("does not override explicit or configured TUI models", async () => {
    const sessionModel = { providerID: "provider", id: "selected-model" }

    const explicitInput = await launchFromTui({ phase: "plan", prompt: "1 --model provider/explicit", sessionModel })
    expect(explicitInput?.rawArgs).toBe("1 --model provider/explicit")

    const configuredInput = await launchFromTui({
      phase: "plan",
      prompt: "1",
      options: { planModel: "provider/configured" },
      sessionModel,
    })
    expect(configuredInput?.rawArgs).toBe("1")
  })

  test("prefers TUI next-model selection over the session record", async () => {
    const input = await launchFromTui({
      phase: "plan",
      prompt: "1",
      sessionModel: { providerID: "opencode", id: "big-pickle" },
      switchedModel: { providerID: "provider", id: "selected-model" },
    })

    expect(input?.rawArgs).toBe("1 --model provider/selected-model")
  })

  test("uses the TUI recent model state before the session record", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openralph-tui-state-"))
    try {
      await writeFile(
        join(stateDir, "model.json"),
        JSON.stringify({ recent: [{ providerID: "openai", modelID: "gpt-5.5" }] }),
      )

      const input = await launchFromTui({
        phase: "plan",
        prompt: "1",
        statePath: stateDir,
        providers: [{ id: "openai", models: { "gpt-5.5": { id: "gpt-5.5" } } }],
        sessionModel: { providerID: "opencode", id: "big-pickle" },
      })

      expect(input?.rawArgs).toBe("1 --model openai/gpt-5.5")
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test("auto-opens output dialog without lifecycle toasts", async () => {
    let resolveLauncher: ((result: LauncherResult) => void) | undefined
    let launcherInput: RunLauncherInput | undefined
    launcherImplementation = async (input) =>
      new Promise<LauncherResult>((resolve) => {
        launcherInput = input
        resolveLauncher = resolve
        expect(input.phase).toBe("plan")
      })

    const disposers: Array<() => void> = []
    const toasts: Array<{ variant?: string; title?: string; message: string; duration?: number }> = []
    const dialogMessages: string[] = []
    const dialogSizes: string[] = []
    let registeredLayer: KeymapLayer | undefined
    let promptProps: { onConfirm?: (value: string) => void } | undefined
    let selectProps: DialogSelectProps | undefined
    let alertProps: { message: string; onConfirm?: () => void } | undefined
    let currentDialogClose: (() => void) | undefined

    const dialog = {
      setSize: (size: string) => dialogSizes.push(size),
      replace: (render: () => unknown, onClose?: () => void) => {
        currentDialogClose?.()
        currentDialogClose = onClose
        return render()
      },
      clear: () => {
        const onClose = currentDialogClose
        currentDialogClose = undefined
        onClose?.()
      },
    }

    try {
      await tuiModule.tui(
        {
          keymap: {
            intercept: () => () => undefined,
            registerLayer: (layer: KeymapLayer) => {
              registeredLayer = layer
              return () => undefined
            },
          },
          lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
          state: { path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test" } },
          ui: {
            dialog,
            DialogPrompt: (props: { onConfirm?: (value: string) => void }) => {
              promptProps = props
              return props
            },
            DialogSelect: (props: DialogSelectProps) => {
              selectProps = props
              return props
            },
            DialogAlert: (props: { message: string; onConfirm?: () => void }) => {
              alertProps = props
              dialogMessages.push(props.message)
              return props
            },
            DialogConfirm: (props: DialogConfirmProps) => {
              dialogMessages.push(props.message)
              return props
            },
            toast: (input: { variant?: string; title?: string; message: string; duration?: number }) => toasts.push(input),
          },
        } as never,
        {},
        {} as never,
      )

      const commands = registeredLayer?.commands ?? []
      commands.find((command) => command.name === "openralph")?.run?.()
      selectProps?.onSelect?.(selectProps.options[1])
      promptProps?.onConfirm?.("2")
      dialog.clear()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(toasts).toHaveLength(0)
      expect(dialogSizes).toHaveLength(0)
      expect(dialogMessages).toHaveLength(1)
      expect(dialogMessages.at(-1)).toContain("Status: starting")
      expect(dialogMessages.at(-1)).toContain("Waiting for Docker/opencode output...")
      expect(dialogMessages.at(-1)).toContain("Confirm closes this viewer")

      expect(launcherInput?.signal?.aborted).toBe(false)

      launcherInput?.onOutput?.({
        stream: "stdout",
        chunk: Array.from({ length: 40 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n") + "\n",
      })
      const initialDialogCount = dialogMessages.length
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(dialogMessages.length).toBeGreaterThan(initialDialogCount)
      expect(dialogMessages.at(-1)).toMatch(/Elapsed: [1-9]\d*s/)
      expect(dialogMessages.at(-1)).toContain("line-31")
      expect(dialogMessages.at(-1)).toContain("line-40")
      expect(dialogMessages.at(-1)).not.toContain("line-30")

      resolveLauncher?.({
        phase: "plan",
        mode: "host-config-default",
        status: "complete",
        summary: "OpenRalph plan complete: test summary",
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(toasts).toHaveLength(0)
      expect(dialogMessages.at(-1)).toContain("Status: complete")
      expect(dialogMessages.at(-1)).toContain("OpenRalph plan complete: test summary")
      expect(alertProps?.message).toContain("Status: complete")
    } finally {
      resolveLauncher?.({
        phase: "plan",
        mode: "host-config-default",
        status: "complete",
        summary: "OpenRalph plan complete: test cleanup",
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      for (const dispose of disposers) dispose()
      launcherImplementation = defaultLauncherImplementation
    }
  })

  test("stops active run from the output dialog cancel action", async () => {
    let launcherInput: RunLauncherInput | undefined
    launcherImplementation = async (input) =>
      new Promise<LauncherResult>((_resolve, reject) => {
        launcherInput = input
        input.signal?.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true })
      })

    const disposers: Array<() => void> = []
    const toasts: Array<{ variant?: string; title?: string; message: string; duration?: number }> = []
    const dialogMessages: string[] = []
    let registeredLayer: KeymapLayer | undefined
    let promptProps: { onConfirm?: (value: string) => void } | undefined
    let selectProps: DialogSelectProps | undefined
    let currentDialogClose: (() => void) | undefined
    let confirmProps: DialogConfirmProps | undefined

    const dialog = {
      setSize: () => undefined,
      replace: (render: () => unknown, onClose?: () => void) => {
        currentDialogClose?.()
        currentDialogClose = onClose
        return render()
      },
      clear: () => {
        const onClose = currentDialogClose
        currentDialogClose = undefined
        onClose?.()
      },
    }

    try {
      await tuiModule.tui(
        {
          keymap: {
            intercept: () => () => undefined,
            registerLayer: (layer: KeymapLayer) => {
              registeredLayer = layer
              return () => undefined
            },
          },
          lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
          state: { path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test" } },
          ui: {
            dialog,
            DialogPrompt: (props: { onConfirm?: (value: string) => void }) => {
              promptProps = props
              return props
            },
            DialogSelect: (props: DialogSelectProps) => {
              selectProps = props
              return props
            },
            DialogAlert: (props: { message: string; onConfirm?: () => void }) => {
              dialogMessages.push(props.message)
              return props
            },
            DialogConfirm: (props: DialogConfirmProps) => {
              confirmProps = props
              dialogMessages.push(props.message)
              return props
            },
            toast: (input: { variant?: string; title?: string; message: string; duration?: number }) => toasts.push(input),
          },
        } as never,
        {},
        {} as never,
      )

      const commands = registeredLayer?.commands ?? []
      commands.find((command) => command.name === "openralph")?.run?.()
      selectProps?.onSelect?.(selectProps.options[1])
      promptProps?.onConfirm?.("2")
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(launcherInput?.signal?.aborted).toBe(false)
      expect(dialogMessages.at(-1)).toContain("Cancel stops the active Ralph loop")
      confirmProps?.onCancel?.()
      expect(launcherInput?.signal?.aborted).toBe(true)
      expect(toasts.at(-1)?.message).toBe("Stop requested for the active run.")

      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      for (const dispose of disposers) dispose()
      launcherImplementation = defaultLauncherImplementation
    }
  })

  test("keeps output dialog on cancel during live refreshes", async () => {
    let launcherInput: RunLauncherInput | undefined
    launcherImplementation = async (input) =>
      new Promise<LauncherResult>(() => {
        launcherInput = input
      })

    const disposers: Array<() => void> = []
    const dialogMessages: string[] = []
    const registeredLayers: KeymapLayer[] = []
    let promptProps: { onConfirm?: (value: string) => void } | undefined
    let selectProps: DialogSelectProps | undefined
    let currentDialogClose: (() => void) | undefined
    let confirmProps: DialogConfirmProps | undefined

    const dialog = {
      setSize: () => undefined,
      replace: (render: () => unknown, onClose?: () => void) => {
        currentDialogClose?.()
        currentDialogClose = onClose
        return render()
      },
      clear: () => {
        const onClose = currentDialogClose
        currentDialogClose = undefined
        onClose?.()
      },
    }

    try {
      await tuiModule.tui(
        {
          keymap: {
            intercept: () => () => undefined,
            registerLayer: (layer: KeymapLayer) => {
              registeredLayers.push(layer)
              return () => undefined
            },
          },
          lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
          state: { path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test" } },
          ui: {
            dialog,
            DialogPrompt: (props: { onConfirm?: (value: string) => void }) => {
              promptProps = props
              return props
            },
            DialogSelect: (props: DialogSelectProps) => {
              selectProps = props
              return props
            },
            DialogAlert: (props: { message: string; onConfirm?: () => void }) => {
              dialogMessages.push(props.message)
              return props
            },
            DialogConfirm: (props: DialogConfirmProps) => {
              confirmProps = props
              dialogMessages.push(props.message)
              return props
            },
            toast: () => undefined,
          },
        } as never,
        {},
        {} as never,
      )

      const commands = registeredLayers.flatMap((layer) => layer.commands)
      commands.find((command) => command.name === "openralph")?.run?.()
      selectProps?.onSelect?.(selectProps.options[1])
      promptProps?.onConfirm?.("2")
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(dialogMessages.at(-1)).toContain("Cancel stops the active Ralph loop")

      const afterSelectionDialogCount = dialogMessages.length
      await new Promise((resolve) => setTimeout(resolve, 1100))

      expect(dialogMessages.length).toBeGreaterThan(afterSelectionDialogCount)
      expect(dialogMessages.at(-1)).toMatch(/Elapsed: [1-9]\d*s/)

      launcherInput?.onOutput?.({ stream: "stdout", chunk: "line while dialog is open\n" })
      await new Promise((resolve) => setTimeout(resolve, 1100))

      expect(dialogMessages.at(-1)).toContain("line while dialog is open")
      confirmProps?.onCancel?.()
      expect(launcherInput?.signal?.aborted).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      launcherImplementation = defaultLauncherImplementation
    }
  })

  test("toasts detached completions and reopens the last run from the menu", async () => {
    let resolveLauncher: ((result: LauncherResult) => void) | undefined
    launcherImplementation = async () =>
      new Promise<LauncherResult>((resolve) => {
        resolveLauncher = resolve
      })

    const disposers: Array<() => void> = []
    const toasts: Array<{ variant?: string; title?: string; message: string; duration?: number }> = []
    const dialogMessages: string[] = []
    let registeredLayer: KeymapLayer | undefined
    let promptProps: { onConfirm?: (value: string) => void } | undefined
    let selectProps: DialogSelectProps | undefined
    let currentDialogClose: (() => void) | undefined

    const dialog = {
      setSize: () => undefined,
      replace: (render: () => unknown, onClose?: () => void) => {
        currentDialogClose?.()
        currentDialogClose = onClose
        return render()
      },
      clear: () => {
        const onClose = currentDialogClose
        currentDialogClose = undefined
        onClose?.()
      },
    }

    try {
      await tuiModule.tui(
        {
          keymap: {
            intercept: () => () => undefined,
            registerLayer: (layer: KeymapLayer) => {
              registeredLayer = layer
              return () => undefined
            },
          },
          lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
          state: { path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test" } },
          ui: {
            dialog,
            DialogPrompt: (props: { onConfirm?: (value: string) => void }) => {
              promptProps = props
              return props
            },
            DialogSelect: (props: DialogSelectProps) => {
              selectProps = props
              return props
            },
            DialogAlert: (props: { message: string; onConfirm?: () => void }) => {
              dialogMessages.push(props.message)
              return props
            },
            DialogConfirm: (props: DialogConfirmProps) => {
              dialogMessages.push(props.message)
              return props
            },
            toast: (input: { variant?: string; title?: string; message: string; duration?: number }) => toasts.push(input),
          },
        } as never,
        {},
        {} as never,
      )

      const commands = registeredLayer?.commands ?? []
      commands.find((command) => command.name === "openralph")?.run?.()
      expect(selectProps?.options.map((option) => option.value)).toEqual(["design", "plan", "build"])
      selectProps?.onSelect?.(selectProps.options[1])
      promptProps?.onConfirm?.("1")
      await new Promise((resolve) => setTimeout(resolve, 0))

      // User closes the viewer while the run is still going.
      dialog.clear()
      expect(toasts).toHaveLength(0)

      resolveLauncher?.({
        phase: "plan",
        mode: "host-config-default",
        status: "complete",
        summary: "OpenRalph plan complete: detached summary",
      })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(toasts).toHaveLength(1)
      expect(toasts[0]?.variant).toBe("success")
      expect(toasts[0]?.message).toContain("plan complete")

      commands.find((command) => command.name === "openralph")?.run?.()
      expect(selectProps?.options.map((option) => option.value)).toEqual(["design", "plan", "build", "view"])
      expect(selectProps?.options[3]?.title).toBe("View Last Run")

      selectProps?.onSelect?.(selectProps.options[3])
      expect(dialogMessages.at(-1)).toContain("Status: complete")
      expect(dialogMessages.at(-1)).toContain("OpenRalph plan complete: detached summary")
    } finally {
      for (const dispose of disposers) dispose()
      launcherImplementation = defaultLauncherImplementation
    }
  })

})

async function launchFromTui(input: {
  phase: "plan" | "build"
  prompt: string
  options?: Record<string, unknown>
  sessionModel?: SessionModel
  switchedModel?: SessionModel
  statePath?: string
  providers?: Array<{ id: string; models: Record<string, { id: string }> }>
}): Promise<RunLauncherInput | undefined> {
  let registeredLayer: KeymapLayer | undefined
  let promptProps: { onConfirm?: (value: string) => void } | undefined
  let selectProps: DialogSelectProps | undefined
  let launcherInput: RunLauncherInput | undefined
  let modelSwitchHandler: ((event: { properties: { sessionID: string; model: SessionModel } }) => void) | undefined
  const disposers: Array<() => void> = []

  launcherImplementation = async (runInput) => {
    launcherInput = runInput
    return defaultLauncherImplementation(runInput)
  }

  try {
    await tuiModule.tui(
      {
        keymap: {
          intercept: () => () => undefined,
          registerLayer: (layer: KeymapLayer) => {
            registeredLayer = layer
            return () => undefined
          },
        },
        lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => undefined) },
        event: {
          on: (type: string, handler: (event: { properties: { sessionID: string; model: SessionModel } }) => void) => {
            if (type === "session.next.model.switched") modelSwitchHandler = handler
            return () => undefined
          },
        },
        route: {
          current: { name: "session", params: { sessionID: "session-1" } },
          navigate: () => undefined,
        },
        state: {
          path: { directory: "/tmp/openralph-test", worktree: "/tmp/openralph-test", state: input.statePath },
          provider: input.providers ?? [],
          session: {
            get: () => (input.sessionModel ? ({ model: input.sessionModel } as never) : undefined),
          },
        },
        ui: {
          dialog: {
            setSize: () => undefined,
            replace: (render: () => unknown) => render(),
            clear: () => undefined,
          },
          DialogPrompt: (props: { onConfirm?: (value: string) => void }) => {
            promptProps = props
            return props
          },
          DialogSelect: (props: DialogSelectProps) => {
            selectProps = props
            return props
          },
          DialogAlert: (props: unknown) => props,
          DialogConfirm: (props: unknown) => props,
          toast: () => undefined,
        },
      } as never,
      input.options ?? {},
      {} as never,
    )

    if (input.switchedModel) {
      modelSwitchHandler?.({ properties: { sessionID: "session-1", model: input.switchedModel } })
    }

    const commands = registeredLayer?.commands ?? []
    commands.find((command) => command.name === "openralph")?.run?.()
    selectProps?.onSelect?.(selectProps.options[input.phase === "plan" ? 1 : 2])
    promptProps?.onConfirm?.(input.prompt)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    return launcherInput
  } finally {
    for (const dispose of disposers) dispose()
    launcherImplementation = defaultLauncherImplementation
  }
}
