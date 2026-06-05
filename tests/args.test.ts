import { describe, expect, test } from "bun:test"
import { formatLoopArgsForReplay, parseLoopArgs, resolveDockerOptions, resolveModel, validateOptions } from "../src/args.ts"

describe("parseLoopArgs", () => {
  test("parses empty plan args", () => {
    expect(parseLoopArgs("plan", "")).toEqual({ push: false, noDocker: false })
  })

  test("parses max, model, and push for build", () => {
    expect(parseLoopArgs("build", "20 --model provider/model --push")).toEqual({
      maxIterations: 20,
      model: "provider/model",
      push: true,
      noDocker: false,
    })
  })

  test("parses no-docker for plan and build", () => {
    expect(parseLoopArgs("plan", "--no-docker 3")).toEqual({
      maxIterations: 3,
      push: false,
      noDocker: true,
    })
    expect(parseLoopArgs("build", "3 --no-docker")).toEqual({
      maxIterations: 3,
      push: false,
      noDocker: true,
    })
  })

  test("rejects duplicate no-docker", () => {
    expect(() => parseLoopArgs("plan", "--no-docker --no-docker")).toThrow("--no-docker can only be provided once")
  })

  test("rejects unknown flags", () => {
    expect(() => parseLoopArgs("plan", "--wat")).toThrow("Unknown flag")
  })

  test("rejects push for planning", () => {
    expect(() => parseLoopArgs("plan", "--push")).toThrow("--push is only supported")
  })

  test("rejects zero max", () => {
    expect(() => parseLoopArgs("build", "0")).toThrow("Unexpected argument")
  })

  test("supports quoted model values", () => {
    expect(parseLoopArgs("plan", '--model "provider/model"')).toEqual({
      model: "provider/model",
      push: false,
      noDocker: false,
    })
  })

  test("rejects malformed model values", () => {
    expect(() => parseLoopArgs("plan", "--model -bad")).toThrow("--model requires a provider/model value")
    expect(() => parseLoopArgs("plan", "--model model-without-provider")).toThrow("--model requires a provider/model value")
  })
})

describe("formatLoopArgsForReplay", () => {
  test("strips docker-only args", () => {
    expect(formatLoopArgsForReplay(parseLoopArgs("plan", "5 --model provider/model --no-docker"))).toBe("5 --model provider/model")
  })
})

describe("resolveModel", () => {
  test("prefers command model over plugin option", () => {
    const args = parseLoopArgs("build", "--model provider/command")
    expect(resolveModel("build", args, { buildModel: "provider/config" })).toBe("provider/command")
  })

  test("uses phase model when no command model is provided", () => {
    expect(resolveModel("plan", { push: false, noDocker: false }, { planModel: "provider/plan" })).toBe("provider/plan")
  })
})

describe("validateOptions", () => {
  test("accepts known optional strings", () => {
    expect(validateOptions({ defineModel: "a/b", planModel: "c/d", buildModel: "e/f" })).toEqual({
      defineModel: "a/b",
      planModel: "c/d",
      buildModel: "e/f",
      docker: undefined,
    })
  })

  test("accepts docker options", () => {
    const options = validateOptions({ docker: { enabled: true, image: "openralph:test", maskEnv: false } })
    expect(options).toEqual({
      defineModel: undefined,
      planModel: undefined,
      buildModel: undefined,
      docker: { enabled: true, image: "openralph:test", maskEnv: false },
    })
    expect(resolveDockerOptions(options)).toEqual({ enabled: true, image: "openralph:test", maskEnv: false })
  })

  test("uses docker defaults", () => {
    expect(resolveDockerOptions(validateOptions({}))).toEqual({
      enabled: true,
      image: "openralph:local",
      maskEnv: true,
    })
    expect(resolveDockerOptions(validateOptions({ docker: { enabled: true } }))).toEqual({
      enabled: true,
      image: "openralph:local",
      maskEnv: true,
    })
  })

  test("rejects non-string model option", () => {
    expect(() => validateOptions({ planModel: 1 })).toThrow("planModel must be a string")
  })

  test("rejects malformed model options", () => {
    expect(() => validateOptions({ planModel: "model-without-provider" })).toThrow("planModel must be a provider/model value")
    expect(() => validateOptions({ buildModel: "provider/-model" })).toThrow("buildModel must be a provider/model value")
  })

  test("rejects invalid docker options", () => {
    expect(() => validateOptions({ docker: true })).toThrow("docker must be an object")
    expect(() => validateOptions({ docker: { enabled: "yes" } })).toThrow("docker.enabled must be a boolean")
    expect(() => validateOptions({ docker: { image: "" } })).toThrow("image must not be empty")
    expect(() => validateOptions({ docker: { image: "-v" } })).toThrow("docker.image must be a valid Docker image reference")
    expect(() => validateOptions({ docker: { image: "openralph:test,bad" } })).toThrow("docker.image must be a valid Docker image reference")
    expect(() => validateOptions({ docker: { maskEnv: "yes" } })).toThrow("docker.maskEnv must be a boolean")
  })
})
