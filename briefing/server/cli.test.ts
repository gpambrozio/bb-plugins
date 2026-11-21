import { describe, expect, it } from "vitest";

import { briefingCli } from "./cli";
import { fakePorts, type FakeBb } from "./testing/fake-ports";

const bb: FakeBb = {
  threads: [
    { id: "thr_one", title: "First thread", requests: ["Build the thing."], preview: "Built it." },
    { id: "thr_kid", parentThreadId: "thr_one", status: "idle", reply: "blocked: no credentials" },
  ],
  projects: [{ id: "proj_a", name: "Alpha", sources: [] }],
};

const cli = () => briefingCli(() => fakePorts(bb));

describe("bb briefing", () => {
  it("prints the text briefing with no thread in view", async () => {
    const result = await cli().run([], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Briefing: 1 root thread.");
    expect(result.stdout).toContain("- First thread (Alpha, idle) [thr_one]");
    expect(result.stdout).toContain("1 sub-thread: kid is blocked.");
    expect(result.stdout).toContain("Asked: Build the thing.");
  });

  it("prints the data with --json", async () => {
    const result = await cli().run(["--json"], { threadId: "thr_whatever" });
    const data = JSON.parse(result.stdout ?? "") as { threads: { id: string; flaggedChildren: { detail: string }[] }[] };
    expect(data.threads.map((thread) => thread.id)).toEqual(["thr_one"]);
    expect(data.threads[0]?.flaggedChildren[0]?.detail).toBe("no credentials");
  });

  it("prints one thread in depth", async () => {
    const result = await cli().run(["thread", "thr_one"], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("First thread (Alpha, idle) [thr_one]");
    expect(result.stdout).toContain("Sub-threads (1):\n- kid (idle) [thr_kid]: blocked: no credentials");
    const json = await cli().run(["thread", "thr_one", "--json"], {});
    expect((JSON.parse(json.stdout ?? "") as { thread: { id: string } }).thread.id).toBe("thr_one");
  });

  it("fails plainly for an unknown thread, and reports a failed read as an error", async () => {
    expect(await cli().run(["thread", "thr_nope"], {})).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No thread thr_nope.") });
    const broken = briefingCli(() => ({
      ...fakePorts(bb),
      rootThreads: () => Promise.reject(new Error("bb is down")),
    }));
    expect(await broken.run([], {})).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("The briefing could not be read: bb is down") });
  });

  it("asks for a thread id", async () => {
    expect(await cli().run(["thread"], {})).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("missing required arguments: <id>") });
  });
});
