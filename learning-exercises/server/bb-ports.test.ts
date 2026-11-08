/**
 * The real `Ports` over the SDK's fake host: what `bbPorts` sends bb for spawning, putting threads
 * away, listing this plugin's threads and reading and writing workspace files, and how it reads bb's
 * answers (a missing file, binary or oversized content, a write conflict).
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { ORIENT_LIMITS } from "../shared/orientation";
import { bbPorts } from "./bb-ports";
import { FileConflict, type FileRoot } from "./ports";

const ROOT: FileRoot = { hostId: "host_1", rootPath: "/work/calc" };

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "learning-exercises" });
  return { ports: bbPorts(bb, () => {}), harness };
}

const file = (content: string, extra: Record<string, unknown> = {}) => ({
  path: "/work/calc/a.txt",
  content,
  contentEncoding: "utf8",
  sha256: "sha_a",
  sizeBytes: Buffer.byteLength(content),
  ...extra,
});

describe("spawn", () => {
  it("sends a visible part and an agent-only part, hidden when asked, with the plugin metadata", async () => {
    const { ports, harness } = setup();
    const seen: unknown[] = [];
    harness.sdk.stub("threads.spawn", (input: unknown) => {
      seen.push(input);
      return { id: "thr_new" };
    });
    const out = await ports.spawn({
      projectId: "proj_1",
      environmentId: "env_1",
      providerId: "claude-code",
      title: "Orient",
      hidden: true,
      visible: "Orienting",
      agentOnly: "Brief",
      metadata: { orientation: "o1" },
    });
    expect(out).toEqual({ threadId: "thr_new" });
    // The SDK adds the plugin's own origin fields on top.
    expect(seen).toMatchObject([
      {
        projectId: "proj_1",
        title: "Orient",
        visibility: "hidden",
        environment: { type: "reuse", environmentId: "env_1" },
        providerId: "claude-code",
        input: [
          { type: "text", text: "Orienting", mentions: [] },
          { type: "text", text: "Brief", visibility: "agent-only", mentions: [] },
        ],
        pluginMetadata: { orientation: "o1" },
      },
    ]);
  });

  it("throws when bb refuses", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("threads.spawn", () => {
      throw new Error("no capacity");
    });
    await expect(
      ports.spawn({ projectId: "p", environmentId: "e", providerId: "x", title: "t", hidden: false, visible: "v", agentOnly: "a", metadata: {} }),
    ).rejects.toThrow("no capacity");
  });
});

describe("stopThread and archiveThread", () => {
  it("call bb and throw on failure", async () => {
    const { ports, harness } = setup();
    const calls: string[] = [];
    harness.sdk.stub("threads.stop", (input: { threadId: string }) => void calls.push(`stop ${input.threadId}`));
    harness.sdk.stub("threads.archive", (input: { threadId: string }) => {
      calls.push(`archive ${input.threadId}`);
      if (input.threadId === "thr_bad") throw new Error("cannot archive");
    });
    await ports.stopThread("thr_1");
    await ports.archiveThread("thr_1");
    expect(calls).toEqual(["stop thr_1", "archive thr_1"]);
    await expect(ports.archiveThread("thr_bad")).rejects.toThrow("cannot archive");
  });
});

describe("environmentRoot and projectCheckout", () => {
  it("gives the host and path of an environment, null without a path or on error", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("environments.get", (input: { environmentId: string }) => {
      if (input.environmentId === "env_gone") return { id: "env_gone", hostId: "host_1", path: null };
      if (input.environmentId === "env_bad") throw new Error("unknown");
      return { id: input.environmentId, hostId: "host_1", path: "/work/calc" };
    });
    expect(await ports.environmentRoot("env_1")).toEqual(ROOT);
    expect(await ports.environmentRoot("env_gone")).toBeNull();
    expect(await ports.environmentRoot("env_bad")).toBeNull();
  });

  it("gives the project's source on the host, null when none or on error", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("projects.get", (input: { projectId: string }) => {
      if (input.projectId === "proj_bad") throw new Error("unknown");
      return { id: input.projectId, sources: [{ hostId: "host_2", path: "/other" }, { hostId: "host_1", path: "/work/calc" }] };
    });
    expect(await ports.projectCheckout("proj_1", "host_1")).toBe("/work/calc");
    expect(await ports.projectCheckout("proj_1", "host_9")).toBeNull();
    expect(await ports.projectCheckout("proj_bad", "host_1")).toBeNull();
  });
});

describe("readFile", () => {
  it("reads text with its hash and size", async () => {
    const { ports, harness } = setup();
    const seen: unknown[] = [];
    harness.sdk.stub("files.read", (input: unknown) => {
      seen.push(input);
      return file("héllo\n");
    });
    expect(await ports.readFile(ROOT, "a.txt")).toEqual({ kind: "text", text: "héllo\n", sha256: "sha_a", sizeBytes: 7 });
    expect(seen).toEqual([{ hostId: "host_1", rootPath: "/work/calc", path: "/work/calc/a.txt" }]);
  });

  it("decodes base64 content that is UTF-8", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.read", () => file(Buffer.from("héllo").toString("base64"), { contentEncoding: "base64", sizeBytes: 6 }));
    expect(await ports.readFile(ROOT, "a.txt")).toMatchObject({ kind: "text", text: "héllo" });
  });

  it("maps a not-found error to missing", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.read", () => {
      throw Object.assign(new Error("File not found: /work/calc/a.txt"), { code: "not_found" });
    });
    expect(await ports.readFile(ROOT, "a.txt")).toEqual({ kind: "missing" });
  });

  it("answers null for any other failure", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.read", () => {
      throw new Error("host offline");
    });
    expect(await ports.readFile(ROOT, "a.txt")).toBeNull();
  });

  it("answers too-large above the limit, before looking at the content", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.read", () => file("x", { sizeBytes: ORIENT_LIMITS.fileBytes + 1 }));
    expect(await ports.readFile(ROOT, "a.txt")).toEqual({ kind: "too-large" });
  });

  it("answers binary for a NUL or for bytes that are not UTF-8", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.read", () => file("ab\u0000cd"));
    expect(await ports.readFile(ROOT, "a.bin")).toEqual({ kind: "binary" });
    harness.sdk.stub("files.read", () => file(Buffer.from([0xff, 0xfe, 0x41]).toString("base64"), { contentEncoding: "base64", sizeBytes: 3 }));
    expect(await ports.readFile(ROOT, "a.bin")).toEqual({ kind: "binary" });
  });
});

describe("writeFile", () => {
  it("writes UTF-8 with parents created and no expected hash for a new file", async () => {
    const { ports, harness } = setup();
    const seen: unknown[] = [];
    harness.sdk.stub("files.write", (input: unknown) => {
      seen.push(input);
      return { outcome: "written", sha256: "sha_b", sizeBytes: 2 };
    });
    await ports.writeFile(ROOT, "docs/a.md", "hi", null);
    expect(seen).toEqual([
      { hostId: "host_1", rootPath: "/work/calc", path: "/work/calc/docs/a.md", content: "hi", contentEncoding: "utf8", createParents: true, expectedSha256: null },
    ]);
  });

  it("passes the expected hash", async () => {
    const { ports, harness } = setup();
    const seen: { expectedSha256?: string | null }[] = [];
    harness.sdk.stub("files.write", (input: { expectedSha256?: string | null }) => {
      seen.push(input);
      return { outcome: "written", sha256: "sha_b", sizeBytes: 2 };
    });
    await ports.writeFile(ROOT, "a.md", "hi", "sha_a");
    expect(seen[0]?.expectedSha256).toBe("sha_a");
  });

  it("throws FileConflict when bb answers a hash mismatch", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.write", () => ({ outcome: "conflict", currentSha256: "sha_other" }));
    await expect(ports.writeFile(ROOT, "a.md", "hi", "sha_a")).rejects.toBeInstanceOf(FileConflict);
  });

  it("throws any other failure as it is", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("files.write", () => {
      throw new Error("read-only file system");
    });
    await expect(ports.writeFile(ROOT, "a.md", "hi", null)).rejects.toThrow("read-only file system");
  });
});

describe("pluginThreadsWith and metadataValue", () => {
  it("lists this plugin's threads that carry the key, with their value, state and status", async () => {
    const { ports, harness } = setup();
    const listed: unknown[] = [];
    harness.sdk.stub("threads.list", (input: unknown) => {
      listed.push(input);
      return [
        { id: "thr_a", status: "running", archivedAt: null },
        { id: "thr_b", status: "idle", archivedAt: 5 },
        { id: "thr_c", status: "idle", archivedAt: null },
      ];
    });
    harness.sdk.stub("threads.experimental_listPluginMetadata", () => ({
      threads: [
        { threadId: "thr_a", metadata: { orientation: "o1" } },
        { threadId: "thr_b", metadata: { orientation: "o2" } },
        { threadId: "thr_c", metadata: { other: "x" } },
      ],
    }));
    expect(await ports.pluginThreadsWith("orientation")).toEqual([
      { threadId: "thr_a", value: "o1", archived: false, status: "running" },
      { threadId: "thr_b", value: "o2", archived: true, status: "idle" },
    ]);
    expect(listed).toEqual([{ originPluginId: "learning-exercises", includeHidden: true, archived: false, limit: 200 }]);
  });

  it("answers null when listing or reading metadata fails", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("threads.list", () => {
      throw new Error("down");
    });
    expect(await ports.pluginThreadsWith("orientation")).toBeNull();
    harness.sdk.stub("threads.list", () => [{ id: "thr_a", status: "idle", archivedAt: null }]);
    harness.sdk.stub("threads.experimental_listPluginMetadata", () => {
      throw new Error("down");
    });
    expect(await ports.pluginThreadsWith("orientation")).toBeNull();
  });

  it("reads one metadata value, null when absent or unreadable", async () => {
    const { ports, harness } = setup();
    harness.sdk.stub("threads.getPluginMetadata", (input: { threadId: string }) => {
      if (input.threadId === "thr_bad") throw new Error("gone");
      return { session: "s1", n: 3 };
    });
    expect(await ports.metadataValue("thr_1", "session")).toBe("s1");
    expect(await ports.metadataValue("thr_1", "n")).toBeNull();
    expect(await ports.metadataValue("thr_1", "absent")).toBeNull();
    expect(await ports.metadataValue("thr_bad", "session")).toBeNull();
    expect(await ports.sessionIdOf("thr_1")).toBe("s1");
  });
});
