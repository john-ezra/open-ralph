import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { TuiDialogStack, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { parseLoopArgs, resolveModel, validateOptions } from "./args.ts"
import { buildDesignUserPrompt, DESIGN_SYSTEM_PROMPT } from "./design.ts"
import type { CommandOutputEvent } from "./exec.ts"
import { runOpenRalphLauncher, type RunLauncherInput } from "./launcher.ts"

const MAX_OUTPUT_CHARS = 40_000
const OUTPUT_DIALOG_LINES = 10
const OUTPUT_DIALOG_REFRESH_MS = 1000
const MAX_DIALOG_LINE_LENGTH = 220

interface TuiRunState {
  controller: AbortController
  phase: "plan" | "build"
  rawArgs: string
  startedAt: number
  status: string
  output: string
  summary?: string
  dialog?: TuiDialogStack
  refreshTimer?: ReturnType<typeof setTimeout>
  suppressDialogClose?: boolean
}

type RalphMode = "design" | "plan" | "build"
type RunLauncher = typeof runOpenRalphLauncher
type SelectedModels = Map<string, string>

export function createTuiModule(runLauncher: RunLauncher = runOpenRalphLauncher): TuiPluginModule {
  const tui = (async (api, rawOptions, _meta) => {
    const options = validateOptions(rawOptions)
    let active: TuiRunState | undefined
    let lastRun: TuiRunState | undefined
    const selectedModels: SelectedModels = new Map()

    const unregisterModelSwitch = api.event?.on?.("session.next.model.switched", (event) => {
      const model = formatSelectedModel(event.properties.model)
      if (model) selectedModels.set(event.properties.sessionID, model)
    })

    const unregister = api.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: "openralph",
          title: "OpenRalph: Choose Phase",
          category: "OpenRalph",
          slashName: "ralph",
          run: () => showModeSelect(api, undefined, options, selectedModels, runLauncher, () => active, (next) => {
            active = next
          }, (next) => {
            lastRun = next
          }),
        },
      ],
      bindings: [],
    })

    api.lifecycle.onDispose(() => {
      active?.controller.abort()
      if (active) clearRefreshTimer(active)
      if (lastRun && lastRun !== active) clearRefreshTimer(lastRun)
      unregisterModelSwitch?.()
      unregister()
    })
  }) satisfies TuiPlugin

  return { id: "openralph", tui }
}

export default createTuiModule()

function showModeSelect(
  api: Parameters<TuiPlugin>[0],
  dialog: TuiDialogStack | undefined,
  options: ReturnType<typeof validateOptions>,
  selectedModels: SelectedModels,
  runLauncher: RunLauncher,
  getActive: () => TuiRunState | undefined,
  setActive: (run: TuiRunState | undefined) => void,
  setLastRun: (run: TuiRunState) => void,
): void {
  const stack = dialog ?? api.ui.dialog
  stack.replace(() =>
    api.ui.DialogSelect<RalphMode>({
      title: "OpenRalph",
      placeholder: "Select a Ralph phase",
      options: [
        {
          title: "Design",
          value: "design",
          description: "Ideate and write planning-ready specs",
        },
        {
          title: "Plan",
          value: "plan",
          description: "Create or refine IMPLEMENTATION_PLAN.md from specs",
        },
        {
          title: "Build",
          value: "build",
          description: "Implement planned work one task and commit at a time",
        },
      ],
      onSelect: (option) => {
        stack.clear()
        if (option.value === "design") {
          promptForDesign(api, stack, options, getActive)
          return
        }
        promptForArgs(api, stack, option.value, options, selectedModels, runLauncher, getActive, setActive, setLastRun)
      },
    }),
  )
}

function promptForDesign(
  api: Parameters<TuiPlugin>[0],
  dialog: TuiDialogStack | undefined,
  options: ReturnType<typeof validateOptions>,
  getActive: () => TuiRunState | undefined,
): void {
  if (getActive()) {
    api.ui.toast({ variant: "warning", title: "OpenRalph", message: "An OpenRalph run is already active." })
    return
  }

  const stack = dialog ?? api.ui.dialog
  stack.replace(() =>
    api.ui.DialogPrompt({
      title: "OpenRalph: Design",
      placeholder: "Feature, workflow, bug, or product change (optional)",
      onConfirm: (value) => {
        stack.clear()
        void startDesignTurn(api, value, options)
      },
      onCancel: () => stack.clear(),
    }),
  )
}

async function startDesignTurn(
  api: Parameters<TuiPlugin>[0],
  initialIdea: string,
  options: ReturnType<typeof validateOptions>,
): Promise<void> {
  try {
    const sessionID = await ensureDesignSession(api)
    await api.client.session.prompt(
      {
        sessionID,
        directory: projectDirectory(api),
        system: DESIGN_SYSTEM_PROMPT,
        parts: [{ type: "text", text: buildDesignUserPrompt(initialIdea) }],
        ...(options.defineModel ? { model: parseProviderModel(options.defineModel) } : {}),
      },
      { throwOnError: true },
    )
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "OpenRalph Design failed",
      message: trimMessage(formatError(error)),
      duration: 12000,
    })
  }
}

async function ensureDesignSession(api: Parameters<TuiPlugin>[0]): Promise<string> {
  const sessionID = currentSessionID(api)
  if (sessionID) return sessionID

  const result = await api.client.session.create(
    {
      directory: projectDirectory(api),
      title: "Ralph Design",
      metadata: { openralph: "design" },
    },
    { throwOnError: true },
  )
  api.route.navigate("session", { sessionID: result.data.id })
  return result.data.id
}

function currentSessionID(api: Parameters<TuiPlugin>[0]): string | undefined {
  const route = api.route?.current
  if (route?.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function projectDirectory(api: Parameters<TuiPlugin>[0]): string {
  return api.state.path.worktree || api.state.path.directory
}

function parseProviderModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("defineModel must use provider/model format for OpenRalph Design")
  }

  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  }
}

function promptForArgs(
  api: Parameters<TuiPlugin>[0],
  dialog: TuiDialogStack | undefined,
  phase: "plan" | "build",
  options: ReturnType<typeof validateOptions>,
  selectedModels: SelectedModels,
  runLauncher: RunLauncher,
  getActive: () => TuiRunState | undefined,
  setActive: (run: TuiRunState | undefined) => void,
  setLastRun: (run: TuiRunState) => void,
): void {
  const stack = dialog ?? api.ui.dialog
  stack.replace(() =>
    api.ui.DialogPrompt({
      title: phase === "plan" ? "OpenRalph: Plan" : "OpenRalph: Build",
      placeholder: argsPromptPlaceholder(phase),
      onConfirm: (value) => {
        stack.clear()
        setTimeout(() => {
          void startTuiRun(api, phase, value, options, selectedModels, runLauncher, getActive, setActive, setLastRun)
        }, 0)
      },
      onCancel: () => stack.clear(),
    }),
  )
}

function argsPromptPlaceholder(phase: "plan" | "build"): string {
  return phase === "plan"
    ? "[number] [--model provider/model] [--no-docker]"
    : "[number] [--model provider/model] [--push] [--no-docker]"
}

async function startTuiRun(
  api: Parameters<TuiPlugin>[0],
  phase: "plan" | "build",
  rawArgs: string,
  options: ReturnType<typeof validateOptions>,
  selectedModels: SelectedModels,
  runLauncher: RunLauncher,
  getActive: () => TuiRunState | undefined,
  setActive: (run: TuiRunState | undefined) => void,
  setLastRun: (run: TuiRunState) => void,
): Promise<void> {
  if (getActive()) {
    api.ui.toast({ variant: "warning", title: "OpenRalph", message: "An OpenRalph run is already active." })
    return
  }

  const controller = new AbortController()
  const run: TuiRunState = {
    controller,
    phase,
    rawArgs,
    startedAt: Date.now(),
    status: "starting",
    output: "",
  }
  setActive(run)
  setLastRun(run)
  showOutputDialog(api, undefined, run)

  try {
    const effectiveRawArgs = withSelectedModelFallback(phase, rawArgs, options, await selectedTuiModel(api, selectedModels))
    if (effectiveRawArgs !== run.rawArgs) {
      run.rawArgs = effectiveRawArgs
      refreshOutputDialog(api, run)
    }

    const input: RunLauncherInput = {
      phase,
      rawArgs: effectiveRawArgs,
      cwd: api.state.path.worktree || api.state.path.directory,
      options,
      streamOutput: false,
      captureOutput: true,
      onOutput: (event) => recordOutput(api, run, event),
      signal: controller.signal,
    }
    const result = await runLauncher(input)
    run.status = result.status
    run.summary = result.summary
    refreshOutputDialog(api, run)
  } catch (error) {
    const stopped = controller.signal.aborted
    run.status = stopped ? "stopped" : "failed"
    run.summary = formatError(error)
    refreshOutputDialog(api, run)
  } finally {
    clearRefreshTimer(run)
    if (getActive() === run) setActive(undefined)
  }
}

function withSelectedModelFallback(
  phase: "plan" | "build",
  rawArgs: string,
  options: ReturnType<typeof validateOptions>,
  selectedModel: string | undefined,
): string {
  if (!selectedModel) return rawArgs

  const parsed = parseLoopArgs(phase, rawArgs)
  if (resolveModel(phase, parsed, options)) return rawArgs

  const trimmed = rawArgs.trim()
  return trimmed ? `${trimmed} --model ${selectedModel}` : `--model ${selectedModel}`
}

async function selectedTuiModel(api: Parameters<TuiPlugin>[0], selectedModels: SelectedModels): Promise<string | undefined> {
  const sessionID = currentSessionID(api)
  const selectedModel = sessionID ? selectedModels.get(sessionID) : undefined
  if (selectedModel) return selectedModel

  const recentModel = await selectedRecentModel(api)
  if (recentModel) return recentModel

  if (!sessionID) return undefined

  const model = api.state.session?.get(sessionID)?.model
  return formatSelectedModel(model)
}

async function selectedRecentModel(api: Parameters<TuiPlugin>[0]): Promise<string | undefined> {
  const statePath = api.state.path?.state
  if (!statePath) return undefined

  try {
    const parsed = JSON.parse(await readFile(join(statePath, "model.json"), "utf8")) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.recent)) return undefined

    for (const entry of parsed.recent) {
      if (!isRecord(entry)) continue
      const providerID = typeof entry.providerID === "string" ? entry.providerID : undefined
      const modelID = typeof entry.modelID === "string" ? entry.modelID : undefined
      if (!providerID || !modelID || !isKnownModel(api, providerID, modelID)) continue
      return `${providerID}/${modelID}`
    }
  } catch {
    return undefined
  }
}

function isKnownModel(api: Parameters<TuiPlugin>[0], providerID: string, modelID: string): boolean {
  const providers = api.state.provider
  if (!providers?.length) return true
  const provider = providers.find((entry) => entry.id === providerID)
  return Boolean(provider?.models?.[modelID])
}

function formatSelectedModel(model: { providerID?: string; id?: string } | undefined): string | undefined {
  if (!model?.providerID || !model.id) return undefined
  return `${model.providerID}/${model.id}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function recordOutput(api: Parameters<TuiPlugin>[0], run: TuiRunState, event: CommandOutputEvent): void {
  if (run.status === "starting") run.status = "running"
  run.output += event.chunk
  if (run.output.length > MAX_OUTPUT_CHARS) run.output = run.output.slice(-MAX_OUTPUT_CHARS)
  scheduleOutputDialogRefresh(api, run)
}

function showOutputDialog(api: Parameters<TuiPlugin>[0], dialog: TuiDialogStack | undefined, run: TuiRunState): void {
  const stack = dialog ?? api.ui.dialog
  run.dialog = stack
  refreshOutputDialog(api, run)
  scheduleOutputDialogRefresh(api, run)
}

function scheduleOutputDialogRefresh(api: Parameters<TuiPlugin>[0], run: TuiRunState): void {
  if (!run.dialog || run.refreshTimer || !isActiveRunStatus(run.status)) return
  run.refreshTimer = setTimeout(() => {
    run.refreshTimer = undefined
    refreshOutputDialog(api, run)
    scheduleOutputDialogRefresh(api, run)
  }, OUTPUT_DIALOG_REFRESH_MS)
}

function refreshOutputDialog(api: Parameters<TuiPlugin>[0], run: TuiRunState): void {
  if (!run.dialog) return
  const stack = run.dialog
  const closeViewer = () => {
    closeOutputDialog(run, stack)
    stack.clear()
  }
  run.suppressDialogClose = true
  const onClose = () => {
    if (run.suppressDialogClose) return
    closeOutputDialog(run, stack)
  }
  if (canStopRun(run)) {
    stack.replace(
      () =>
        api.ui.DialogConfirm({
          title: `OpenRalph ${run.phase} output`,
          message: `${formatOutputDialogMessage(run)}\n\nConfirm closes this viewer. Cancel stops the active Ralph loop.`,
          onConfirm: closeViewer,
          onCancel: () => stopFromOutputDialog(api, run, stack),
        }),
      onClose,
    )
  } else {
    stack.replace(
      () =>
        api.ui.DialogAlert({
          title: `OpenRalph ${run.phase} output`,
          message: formatOutputDialogMessage(run),
          onConfirm: closeViewer,
        }),
      onClose,
    )
  }
  queueMicrotask(() => {
    if (run.dialog === stack) run.suppressDialogClose = false
  })
}

function stopFromOutputDialog(api: Parameters<TuiPlugin>[0], run: TuiRunState, stack: TuiDialogStack): void {
  requestStopRun(api, run, { refresh: false })
  closeOutputDialog(run, stack)
  stack.clear()
}

function requestStopRun(
  api: Parameters<TuiPlugin>[0],
  run: TuiRunState,
  options: { refresh: boolean },
): void {
  if (!run.controller.signal.aborted) {
    run.status = "stop requested"
    run.controller.abort()
  }
  if (options.refresh) refreshOutputDialog(api, run)
  api.ui.toast({ variant: "warning", title: "OpenRalph", message: "Stop requested for the active run." })
}

function closeOutputDialog(run: TuiRunState, stack: TuiDialogStack): void {
  if (run.dialog === stack) run.dialog = undefined
  run.suppressDialogClose = false
  clearRefreshTimer(run)
}

function clearRefreshTimer(run: TuiRunState): void {
  if (!run.refreshTimer) return
  clearTimeout(run.refreshTimer)
  run.refreshTimer = undefined
}

function formatOutputDialogMessage(run: TuiRunState): string {
  const lines = [
    `Status: ${run.status}`,
    `Args: ${run.rawArgs.trim() || "(default)"}`,
    `Elapsed: ${formatElapsed(Date.now() - run.startedAt)}`,
    "",
    "Recent output:",
    recentOutput(run),
  ]

  if (run.summary) {
    lines.push("", "Summary:", trimMessage(run.summary))
  }

  return lines.join("\n")
}

function recentOutput(run: TuiRunState): string {
  const output = sanitizeOutput(run.output).trimEnd()
  if (!output) return "Waiting for Docker/opencode output..."

  return output
    .split(/\n/)
    .slice(-OUTPUT_DIALOG_LINES)
    .map(trimDialogLine)
    .join("\n")
}

function sanitizeOutput(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\r/g, "\n")
}

function trimDialogLine(value: string): string {
  if (value.length <= MAX_DIALOG_LINE_LENGTH) return value
  return `${value.slice(0, MAX_DIALOG_LINE_LENGTH - 3)}...`
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function isActiveRunStatus(status: string): boolean {
  return status === "starting" || status === "running" || status === "stop requested"
}

function canStopRun(run: TuiRunState): boolean {
  return (run.status === "starting" || run.status === "running") && !run.controller.signal.aborted
}

function trimMessage(value: string): string {
  const lines = value.trim().split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - 8)).join("\n")
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
