// @vitest-environment jsdom
/**
 * The card on a thread's Info tab and sidebar row, through the SDK's app
 * harness, and how the app registers both on bb 0.48 and on bb 0.47, whose
 * slots have no sidebar row item.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { PluginAppSlots, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { boardPageTitle } from "./board-panel";
import {
  registerThreadCard,
  ThreadCardInfoRow,
  ThreadCardRowItem,
  useThreadCards,
} from "./thread-card-slots";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const card = {
  id: "I_42",
  repository: "octo/widgets",
  number: 42,
  title: "Crash on empty input",
  url: "https://github.com/octo/widgets/issues/42",
  author: null,
  labels: [],
};

const infoProps = { threadId: "thr_a", projectId: "proj_w", environment: null };

describe("ThreadCardInfoRow", () => {
  it("shows the card's reference, linked to GitHub, and its title", async () => {
    const getPluginMetadata = vi.fn(async () => ({ card }));
    const view = renderSlot({ component: ThreadCardInfoRow }, infoProps, {
      sdk: { threads: { getPluginMetadata } },
    });
    const link = await screen.findByRole("link", { name: "Open octo/widgets#42 on GitHub" });
    expect(link.textContent).toBe("octo/widgets#42");
    expect(link.getAttribute("href")).toBe(card.url);
    expect(screen.getByText("Crash on empty input")).toBeTruthy();
    expect(screen.getByText("GitHub card")).toBeTruthy();
    expect(getPluginMetadata).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_a" }));
    expect(view.inspection.sdkCalls.map((call) => call.method)).toEqual(["threads.getPluginMetadata"]);
  });

  it("shows nothing for a thread the board did not start", async () => {
    const getPluginMetadata = vi.fn(async () => ({}));
    const view = renderSlot({ component: ThreadCardInfoRow }, infoProps, {
      sdk: { threads: { getPluginMetadata } },
    });
    await waitFor(() => expect(getPluginMetadata).toHaveBeenCalled());
    expect(view.container.textContent).toBe("");
  });

  it("shows nothing, and says why in the console, when the metadata cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = renderSlot({ component: ThreadCardInfoRow }, infoProps, {
      sdk: {
        threads: {
          getPluginMetadata: async () => {
            throw new Error("offline");
          },
        },
      },
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline")));
    expect(view.container.textContent).toBe("");
  });

  it("does not link a card whose URL is not http or https", async () => {
    renderSlot({ component: ThreadCardInfoRow }, infoProps, {
      sdk: { threads: { getPluginMetadata: async () => ({ card: { ...card, url: "javascript:alert(1)" } }) } },
    });
    await screen.findByText("octo/widgets#42");
    expect(screen.queryByRole("link")).toBeNull();
  });
});

function sidebarThread(id: string, originPluginId: string | null): PluginSidebarThread {
  return { id, projectId: "proj_w", originPluginId } as PluginSidebarThread;
}

/** bb calls `useData` once for the app and hands its answer to every row; this does both. */
function Rows({ threads }: { threads: PluginSidebarThread[] }) {
  const data = useThreadCards({ threads });
  return (
    <ul>
      {threads.map((thread) => (
        <li key={thread.id} data-testid={thread.id}>
          <ThreadCardRowItem thread={thread} data={data} />
        </li>
      ))}
    </ul>
  );
}

describe("the sidebar row item", () => {
  it("reads only the board's threads, in one batch, and shows repo#number with the title in its tooltip", async () => {
    const listPluginMetadata = vi.fn(async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: threadIds.filter((id) => id === "thr_a").map((threadId) => ({ threadId, metadata: { card } })),
    }));
    const threads = [sidebarThread("thr_a", "github-board"), sidebarThread("thr_b", null), sidebarThread("thr_c", "github-board")];
    renderSlot({ component: Rows }, { threads }, {
      pluginId: "github-board",
      sdk: { threads: { experimental_listPluginMetadata: listPluginMetadata } },
    });

    const item = await screen.findByLabelText("GitHub card octo/widgets#42: Crash on empty input");
    expect(item.textContent).toBe("widgets#42");
    expect(item.getAttribute("title")).toBe("octo/widgets#42: Crash on empty input");
    expect(listPluginMetadata).toHaveBeenCalledTimes(1);
    expect(listPluginMetadata.mock.calls[0]![0].threadIds).toEqual(["thr_a", "thr_c"]);
    expect(screen.getByTestId("thr_b").textContent).toBe("");
    expect(screen.getByTestId("thr_c").textContent).toBe("");
  });

  it("reads a thread once, and a new thread when it appears", async () => {
    const listPluginMetadata = vi.fn(async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: threadIds.map((threadId) => ({ threadId, metadata: { card: { ...card, number: Number(threadId.slice(4)) } } })),
    }));
    const first = [sidebarThread("thr_1", "github-board")];
    const view = renderSlot({ component: Rows }, { threads: first }, {
      pluginId: "github-board",
      sdk: { threads: { experimental_listPluginMetadata: listPluginMetadata } },
    });
    await screen.findByText("widgets#1");

    view.lifecycle.rerender(<Rows threads={[...first, sidebarThread("thr_2", "github-board")]} />);
    await screen.findByText("widgets#2");
    expect(listPluginMetadata.mock.calls.map(([args]) => args.threadIds)).toEqual([["thr_1"], ["thr_2"]]);
  });

  it("asks again after a failed read, the next time the list changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const listPluginMetadata = vi.fn(async ({ threadIds }: { threadIds: readonly string[] }) => {
      if (fail) throw new Error("offline");
      return { threads: threadIds.map((threadId) => ({ threadId, metadata: { card } })) };
    });
    const first = [sidebarThread("thr_a", "github-board")];
    const view = renderSlot({ component: Rows }, { threads: first }, {
      pluginId: "github-board",
      sdk: { threads: { experimental_listPluginMetadata: listPluginMetadata } },
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("offline")));

    fail = false;
    view.lifecycle.rerender(<Rows threads={[...first, sidebarThread("thr_b", null)]} />);
    await screen.findByText("widgets#42");
    expect(listPluginMetadata).toHaveBeenCalledTimes(2);
  });

  it("asks nothing while no listed thread was started by the board", () => {
    const listPluginMetadata = vi.fn();
    renderSlot({ component: Rows }, { threads: [sidebarThread("thr_b", null)] }, {
      pluginId: "github-board",
      sdk: { threads: { experimental_listPluginMetadata: listPluginMetadata } },
    });
    expect(listPluginMetadata).not.toHaveBeenCalled();
  });
});

describe("registerThreadCard", () => {
  it("registers the Info tab row and the sidebar row item on bb 0.48", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.threadInfoRows.map((row) => [row.id, row.group])).toEqual([["card", "1_thread"]]);
    expect(app.threadRowMetadata.map((item) => item.id)).toEqual(["card"]);
    expect(app.threadRowMetadata[0]!.useData).toBe(useThreadCards);
  });

  it("registers only the Info tab row on bb 0.47, whose slots have no row item", () => {
    const threadInfoRow = vi.fn();
    const slots = { experimental_threadInfoRow: threadInfoRow } as unknown as PluginAppSlots;
    expect(() => registerThreadCard(slots)).not.toThrow();
    expect(threadInfoRow).toHaveBeenCalledTimes(1);
  });
});

describe("the page title", () => {
  it("names the template editor and leaves the board to the panel's own title", async () => {
    expect(boardPageTitle({ subPath: "prompts" })).toEqual({ title: "Prompt templates" });
    expect(boardPageTitle({ subPath: "" })).toBeNull();
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels[0]!.experimental_usePageTitle).toBe(boardPageTitle);
  });
});
