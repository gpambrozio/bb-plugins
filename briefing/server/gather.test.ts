import { describe, expect, it } from "vitest";

import { FIRSTMATE_DESCRIPTION, LIMITS, gatherBriefing, gatherThread, statusWord } from "./gather";
import { card, fakePorts, type FakeBb } from "./testing/fake-ports";

const system = { initiator: "system", systemMessageKind: "child-completed", input: [{ type: "text", text: "[bb system] child done" }] };

function world(patch: Partial<FakeBb> = {}): FakeBb {
  return {
    threads: [
      {
        id: "thr_old",
        title: "Old work",
        updatedAt: 1,
        requests: ["Start the old work.", "And then finish it."],
        preview: "Finished the old work.",
      },
      {
        id: "thr_mate",
        title: "FirstMate",
        projectId: "proj_fm",
        updatedAt: 5,
        requests: ["ahoy", system, "What is in flight?", system],
        preview: "Captain, two tasks are in flight.",
      },
      { id: "thr_crew1", parentThreadId: "thr_mate", status: "idle", reply: "Did it.\nneeds-decision: keep or drop?" },
      { id: "thr_crew2", parentThreadId: "thr_mate", status: "active" },
      { id: "thr_grandchild", parentThreadId: "thr_crew2", status: "error" },
      { id: "thr_gone", parentThreadId: "thr_mate", archivedAt: 9 },
      { id: "thr_archived_root", archivedAt: 3 },
      { id: "thr_asks", title: "Needs an answer", updatedAt: 2, hasPendingInteraction: true, requests: ["Only message"] },
    ],
    projects: [
      { id: "proj_a", name: "Alpha", sources: [{ hostId: "host_mac", path: "/src/alpha" }] },
      { id: "proj_fm", name: "FirstMate", sources: [{ hostId: "host_mac", path: "/fm" }] },
    ],
    files: {
      "host_mac:/src/alpha/CLAUDE.md": "@AGENTS.md\n",
      "host_mac:/src/alpha/README.md": "# Alpha\n\nAlpha keeps the lights on.",
      "host_mac:/fm/AGENTS.md": "# FirstMate\n\nThe captain's first mate runs a crew.",
    },
    fleet: {
      ok: true,
      fleet: {
        mate: { threadId: "thr_mate" },
        cards: [card("Held", { backlog: { hold: "go?" } }), card("Next up")],
        suggestions: [{ label: "Review it", prompt: "…" }],
      },
    },
    ...patch,
  };
}

describe("gatherBriefing", () => {
  it("briefs every root thread that is not archived, most urgent first", async () => {
    const briefing = await gatherBriefing(fakePorts(world()), 100);
    expect(briefing.threads.map((thread) => thread.id)).toEqual(["thr_asks", "thr_mate", "thr_old"]);
    expect(briefing.threads[0]?.needsUser).toBe(true);
    expect(briefing.threads[1]?.isFirstMate).toBe(true);
  });

  it("takes the opening and the latest message of the user's, skipping bb's notices", async () => {
    const briefing = await gatherBriefing(fakePorts(world()));
    const mate = briefing.threads.find((thread) => thread.id === "thr_mate");
    expect(mate?.opening).toBe("ahoy");
    expect(mate?.lastUser).toBe("What is in flight?");
    expect(mate?.lastAgent).toBe("Captain, two tasks are in flight.");
    // A thread with one message has no separate latest one.
    const asks = briefing.threads.find((thread) => thread.id === "thr_asks");
    expect(asks?.opening).toBe("Only message");
    expect(asks?.lastUser).toBeNull();
  });

  it("finds the user's latest message past a full page of notices", async () => {
    const notices = Array.from({ length: LIMITS.pageSize + 30 }, () => system);
    const briefing = await gatherBriefing(fakePorts({ threads: [{ id: "thr_busy", requests: ["first", "the latest", ...notices] }] }));
    expect(briefing.threads[0]?.lastUser).toBe("the latest");
  });

  it("counts every sub-thread under its root, at any depth, and names the ones that need someone", async () => {
    const briefing = await gatherBriefing(fakePorts(world()));
    const mate = briefing.threads.find((thread) => thread.id === "thr_mate");
    expect(mate?.childCount).toBe(3);
    expect(mate?.flaggedChildren).toEqual([
      { id: "thr_crew1", title: "crew1", state: "needs a decision", detail: "keep or drop?" },
      { id: "thr_grandchild", title: "grandchild", state: "failed", detail: null },
    ]);
  });

  it("says how many idle sub-threads were not checked, and nothing when all were", async () => {
    const kids = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `thr_k${index}`, parentThreadId: "thr_root", reply: "done: fine" }));
    const exactly = await gatherBriefing(fakePorts({ threads: [{ id: "thr_root" }, ...kids(LIMITS.childReplies)] }));
    expect(exactly.problems).toEqual([]);
    const over = await gatherBriefing(fakePorts({ threads: [{ id: "thr_root" }, ...kids(LIMITS.childReplies + 1)] }));
    expect(over.problems).toEqual([`Only ${LIMITS.childReplies} idle sub-threads were checked for a blocked status line; 1 were not.`]);
  });

  it("says when bb's list of root threads was cut at its cap", async () => {
    const briefing = await gatherBriefing(fakePorts({ threads: [{ id: "thr_root" }], rootsComplete: false }));
    expect(briefing.problems).toEqual(["Only the first 1 root threads were read."]);
  });

  it("does not repeat the opening as the latest message when bb retried the first turn", async () => {
    const retry = { initiator: "user", systemMessageKind: "unlabeled", retryOfRequestId: "creq_1", input: [{ type: "text", text: "Do it" }] };
    const briefing = await gatherBriefing(fakePorts({ threads: [{ id: "thr_r", requests: ["Do it", retry] }] }));
    expect(briefing.threads[0]?.opening).toBe("Do it");
    expect(briefing.threads[0]?.lastUser).toBeNull();
  });

  it("only reads the latest reply of idle sub-threads", async () => {
    const ports = fakePorts(world());
    await gatherBriefing(ports);
    expect(ports.calls.filter((call) => call.startsWith("reply:"))).toEqual(["reply:thr_crew1"]);
  });

  it("describes each project from AGENTS.md, then CLAUDE.md, then the README, on its own machine", async () => {
    const ports = fakePorts(world());
    const briefing = await gatherBriefing(ports);
    expect(briefing.projects).toEqual([
      { id: "proj_a", name: "Alpha", description: "Alpha keeps the lights on.", source: "README.md" },
      // The first mate's home is described as such, not from its charter.
      { id: "proj_fm", name: "FirstMate", description: FIRSTMATE_DESCRIPTION, source: "FirstMate" },
    ]);
    expect(ports.calls.some((call) => call.startsWith("read:host_mac:/fm/"))).toBe(false);
    expect(ports.calls.filter((call) => call.startsWith("read:host_mac:/src/alpha"))).toEqual([
      "read:host_mac:/src/alpha/AGENTS.md",
      "read:host_mac:/src/alpha/CLAUDE.md",
      "read:host_mac:/src/alpha/README.md",
    ]);
  });

  it("falls back to a thread's workspace when the checkout's machine is offline, and says so when none answers", async () => {
    const base = world();
    const ok = await gatherBriefing(
      fakePorts({
        ...base,
        threads: base.threads.map((thread) => (thread.id === "thr_old" ? { ...thread, hostId: "host_linux", path: "/w/alpha" } : thread)),
        offline: ["host_mac"],
        files: { "host_linux:/w/alpha/AGENTS.md": "Alpha, from the worktree." },
      }),
    );
    expect(ok.projects.find((project) => project.id === "proj_a")?.description).toBe("Alpha, from the worktree.");

    const offline = await gatherBriefing(fakePorts({ ...base, offline: ["host_mac"] }));
    expect(offline.projects.find((project) => project.id === "proj_a")?.description).toBeNull();
    expect(offline.problems.some((problem) => problem.includes('project "Alpha"') && problem.includes("offline"))).toBe(true);
  });

  it("never follows a description file that points outside the checkout, and tries the next one", async () => {
    const base = world();
    const secret = "Private notes that must never be read aloud.";
    const ports = fakePorts({
      ...base,
      files: { ...base.files, "host_mac:/Users/me/private.md": secret },
      links: { "host_mac:/src/alpha/AGENTS.md": "/Users/me/private.md" },
    });
    const briefing = await gatherBriefing(ports);
    expect(briefing.projects.find((project) => project.id === "proj_a")).toMatchObject({ description: "Alpha keeps the lights on.", source: "README.md" });
    expect(JSON.stringify(briefing)).not.toContain("Private notes");

    const allOutside = await gatherBriefing(
      fakePorts({
        ...base,
        files: { "host_mac:/Users/me/private.md": secret },
        links: Object.fromEntries(["AGENTS.md", "CLAUDE.md", "README.md"].map((file) => [`host_mac:/src/alpha/${file}`, "/Users/me/private.md"])),
      }),
    );
    expect(allOutside.projects.find((project) => project.id === "proj_a")?.description).toBeNull();
    expect(allOutside.problems).toContain(
      `Did not read the description of project "Alpha" from AGENTS.md (it points outside the project's folder), CLAUDE.md (it points outside the project's folder), README.md (it points outside the project's folder).`,
    );
    expect(JSON.stringify(allOutside)).not.toContain("Private notes");
  });

  it("goes on to the README when AGENTS.md cannot be read, without trying another machine", async () => {
    const base = world();
    const ports = fakePorts({ ...base, fileErrors: { "host_mac:/src/alpha/AGENTS.md": "permission denied" } });
    const briefing = await gatherBriefing(ports);
    expect(briefing.projects.find((project) => project.id === "proj_a")).toMatchObject({ description: "Alpha keeps the lights on.", source: "README.md" });
    expect(briefing.problems).toEqual([]);
  });

  it("does not call sub-threads clear when a reply could not be read, and says why", async () => {
    const ports = fakePorts({ threads: [{ id: "thr_root" }, { id: "thr_kid", parentThreadId: "thr_root", reply: "blocked: needs a key" }] });
    for (const failure of [new Error("thread store unavailable"), new Error("BB request timed out after 8 s.")]) {
      const briefing = await gatherBriefing({ ...ports, latestReply: () => Promise.reject(failure) });
      expect(briefing.threads[0]).toMatchObject({ childCount: 1, flaggedChildren: [], uncheckedChildren: 1 });
      expect(briefing.problems).toEqual([`Could not check 1 sub-thread for a blocked status line: ${failure.message}`]);
    }
    const read = await gatherBriefing(ports);
    expect(read.threads[0]).toMatchObject({ uncheckedChildren: 0, flaggedChildren: [{ id: "thr_kid", state: "blocked" }] });
  });

  it("counts the sub-threads past the cap on reply reads as not checked", async () => {
    const kids = Array.from({ length: LIMITS.childReplies + 2 }, (_, index) => ({ id: `thr_k${index}`, parentThreadId: "thr_root", reply: "done: fine" }));
    const briefing = await gatherBriefing(fakePorts({ threads: [{ id: "thr_root" }, ...kids] }));
    expect(briefing.threads[0]?.uncheckedChildren).toBe(2);
  });

  it("adds FirstMate's tasks only when its thread is a root thread", async () => {
    const briefing = await gatherBriefing(fakePorts(world()));
    expect(briefing.firstMate?.needsOwner).toEqual([{ title: "Held", detail: "go?" }]);
    expect(briefing.firstMate?.queued).toEqual([{ title: "Next up", detail: null }]);
    expect(briefing.firstMate?.suggestions).toEqual(["Review it"]);

    const base = world();
    const nested = await gatherBriefing(
      fakePorts({ ...base, threads: base.threads.map((thread) => (thread.id === "thr_mate" ? { ...thread, parentThreadId: "thr_old" } : thread)) }),
    );
    expect(nested.firstMate).toBeNull();
  });

  it("reports a FirstMate it cannot read, and is silent when FirstMate is not installed", async () => {
    const broken = await gatherBriefing(fakePorts(world({ fleet: { ok: false, reason: "FirstMate Crew is crashed." } })));
    expect(broken.firstMate).toBeNull();
    expect(broken.problems).toContain("Could not read FirstMate's tasks: FirstMate Crew is crashed.");

    const absent = await gatherBriefing(fakePorts(world({ fleet: undefined })));
    expect(absent.firstMate).toBeNull();
    expect(absent.problems).toEqual([]);
  });

  it("keeps briefing the other threads when one thread's messages cannot be read", async () => {
    const briefing = await gatherBriefing(fakePorts(world({ failing: ["thr_old"] })));
    expect(briefing.threads).toHaveLength(3);
    expect(briefing.threads.find((thread) => thread.id === "thr_old")?.opening).toBeNull();
    expect(briefing.problems.some((problem) => problem.includes('"Old work"'))).toBe(true);
  });
});

describe("gatherThread", () => {
  it("gives the last few user messages, the full latest reply, and every sub-thread with its status line", async () => {
    const base = world();
    const detail = await gatherThread(
      fakePorts({ ...base, threads: base.threads.map((thread) => (thread.id === "thr_mate" ? { ...thread, reply: "Full reply text." } : thread)) }),
      "thr_mate",
    );
    expect(detail?.recentUserMessages).toEqual(["What is in flight?"]);
    expect(detail?.thread.lastAgent).toBe("Full reply text.");
    expect(detail?.children.map((child) => [child.id, child.status, child.statusLine])).toEqual([
      ["thr_crew1", "idle", "needs-decision: keep or drop?"],
      ["thr_crew2", "working", null],
      ["thr_grandchild", "failed", null],
    ]);
    expect(detail?.firstMate?.needsOwner).toHaveLength(1);
    expect(detail?.project?.description).toBe(FIRSTMATE_DESCRIPTION);
  });

  it("gives three recent user messages even when the opening is among the latest", async () => {
    const detail = await gatherThread(fakePorts({ threads: [{ id: "thr_m", requests: ["one", "two", "three", "four"] }] }), "thr_m");
    expect(detail?.thread.opening).toBe("one");
    expect(detail?.recentUserMessages).toEqual(["four", "three", "two"]);
    const short = await gatherThread(fakePorts({ threads: [{ id: "thr_s", requests: ["one", "two"] }] }), "thr_s");
    expect(short?.recentUserMessages).toEqual(["two"]);
  });

  it("keeps the whole latest reply and the whole messages, however long", async () => {
    const reply = `Start. ${"word ".repeat(2_000)}The decision: ship it.`;
    const opening = `Opening. ${"more ".repeat(400)}`;
    const detail = await gatherThread(fakePorts({ threads: [{ id: "thr_l", requests: [opening, "x"], reply }] }), "thr_l");
    expect(detail?.thread.lastAgent).toBe(reply.trim().replace(/\s+/g, " "));
    expect(detail?.thread.opening?.length).toBeGreaterThan(LIMITS.messageChars);
  });

  it("says which sub-threads' replies were not read, and why", async () => {
    const base = fakePorts({ threads: [{ id: "thr_root" }, { id: "thr_kid", parentThreadId: "thr_root" }] });
    const ports = { ...base, latestReply: (id: string) => (id === "thr_kid" ? Promise.reject(new Error("timed out")) : Promise.resolve("ok")) };
    const detail = await gatherThread(ports, "thr_root");
    expect(detail?.children).toEqual([{ id: "thr_kid", title: "kid", status: "idle", statusLine: null, unread: "failed" }]);
    expect(detail?.problems).toEqual(["Could not check 1 sub-thread for a blocked status line: timed out"]);
  });

  it("says when the thread's whole latest reply could not be read", async () => {
    const base = fakePorts({ threads: [{ id: "thr_x", title: "X", preview: "Short preview." }] });
    const detail = await gatherThread({ ...base, latestReply: () => Promise.reject(new Error("bb is busy")) }, "thr_x");
    expect(detail?.thread.lastAgent).toBe("Short preview.");
    expect(detail?.problems).toEqual(['Could not read the whole latest reply of "X", so only its opening is given: bb is busy']);
  });

  it("says when the thread detail cannot list the projects", async () => {
    const ports = { ...fakePorts(world()), projects: () => Promise.reject(new Error("bb is busy")) };
    expect((await gatherThread(ports, "thr_old"))?.problems).toContain("Could not list the projects: bb is busy");
  });

  it("is null for a thread bb does not have", async () => {
    expect(await gatherThread(fakePorts(world()), "thr_nope")).toBeNull();
  });

  it("does not add FirstMate's tasks to another thread", async () => {
    expect((await gatherThread(fakePorts(world()), "thr_old"))?.firstMate).toBeNull();
  });
});

describe("statusWord", () => {
  it("says bb's statuses in plain words", () => {
    expect(statusWord("active")).toBe("working");
    expect(statusWord("error")).toBe("failed");
    expect(statusWord("waiting-for-host")).toBe("waiting for its machine");
    expect(statusWord("idle")).toBe("idle");
  });
});
