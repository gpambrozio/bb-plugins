// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sendInCodeMode, SEND_DATA } from "./send-menu";
import { menuLine, rowBadge } from "./thread-ui";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Icon: (props: { name: string }) => <i data-icon={props.name} />,
  experimental_THREAD_ACTION_GROUPS: { state: "1_state" },
  experimental_useRpcKeyedQuery: () => ({ data: {} }),
}));

describe("Send in Code Mode", () => {
  it("sends with the plugin's data on the message", async () => {
    const submit = vi.fn(async () => undefined);
    await sendInCodeMode.run({ composer: { submit } as never });
    expect(submit).toHaveBeenCalledWith({ experimental_data: SEND_DATA });
  });

  it("does not throw when bb refuses the send (bb shows the reason itself)", async () => {
    const submit = vi.fn(async () => Promise.reject(new Error("Code Mode is not turned on for this machine")));
    await expect(sendInCodeMode.run({ composer: { submit } as never })).resolves.toBeUndefined();
  });

});

describe("a Code Mode thread", () => {
  const thread = { id: "thr_cm", providerId: "claude-code" } as never;

  it("shows a badge on its row, and other threads none", () => {
    const Badge = rowBadge.component;
    const { container, rerender } = render(<Badge thread={thread} data={{ thr_cm: "on" }} />);
    expect(screen.getByText("Code")).toBeTruthy();
    rerender(<Badge thread={thread} data={{ thr_cm: "off" }} />);
    expect(container.textContent).toBe("");
  });

  it("shows a read-only line in its thread menu", () => {
    const item = menuLine.item({ thread: { id: "thr_cm" }, data: { thr_cm: "on" } } as never);
    expect(item).toMatchObject({ label: "Code Mode: on", detail: "Fixed for this thread", disabled: true });
    expect(menuLine.item({ thread: { id: "thr_x" }, data: { thr_x: "none" } } as never)).toBeNull();
  });
});
