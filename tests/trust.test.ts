import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { attestDockerEnvironment, authorizeHostLoopChild, authorizeLoopChild, createHostLoopToken, hasDockerMarker } from "../src/trust.ts"

describe("Docker attestation", () => {
  test("requires container evidence and matching token file", async () => {
    await expect(
      attestDockerEnvironment(
        { OPENRALPH_IN_DOCKER: "1", OPENRALPH_DOCKER_TOKEN: "token" },
        { containerEvidence: async () => true, readTextFile: async () => "token" },
      ),
    ).resolves.toBe(true)

    await expect(
      attestDockerEnvironment(
        { OPENRALPH_IN_DOCKER: "1", OPENRALPH_DOCKER_TOKEN: "token" },
        { containerEvidence: async () => true, readTextFile: async () => "other" },
      ),
    ).resolves.toBe(false)

    await expect(
      attestDockerEnvironment(
        { OPENRALPH_IN_DOCKER: "1", OPENRALPH_DOCKER_TOKEN: "token" },
        { containerEvidence: async () => false, readTextFile: async () => "token" },
      ),
    ).resolves.toBe(false)
  })

  test("treats real container evidence as a Docker marker", async () => {
    await expect(hasDockerMarker({}, { containerEvidence: async () => true })).resolves.toBe(true)
  })
})

describe("host loop child authorization", () => {
  test("accepts matching host token outside the project", async () => {
    const token = await createHostLoopToken()
    try {
      const env = { OPENRALPH_LOOP_CHILD: "1", ...token.env }
      await expect(authorizeLoopChild(env, process.cwd(), { containerEvidence: async () => false })).resolves.toBe(true)
    } finally {
      await token.cleanup()
    }
  })

  test("rejects missing, empty, mismatched, and in-project host tokens", async () => {
    await expect(authorizeHostLoopChild({}, process.cwd())).resolves.toBe(false)
    await expect(authorizeHostLoopChild({ OPENRALPH_HOST_LOOP_TOKEN: "", OPENRALPH_HOST_LOOP_TOKEN_FILE: "/tmp/nope" }, process.cwd())).resolves.toBe(false)

    const root = await mkdtemp(join(tmpdir(), "openralph-trust-test-"))
    try {
      const outside = join(root, "outside-token")
      await writeFile(outside, "actual")
      await expect(authorizeHostLoopChild({ OPENRALPH_HOST_LOOP_TOKEN: "expected", OPENRALPH_HOST_LOOP_TOKEN_FILE: outside }, process.cwd())).resolves.toBe(
        false,
      )

      const inside = join(process.cwd(), ".openralph-token-test")
      await writeFile(inside, "actual")
      try {
        await expect(authorizeHostLoopChild({ OPENRALPH_HOST_LOOP_TOKEN: "actual", OPENRALPH_HOST_LOOP_TOKEN_FILE: inside }, process.cwd())).resolves.toBe(false)
      } finally {
        await rm(inside, { force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
