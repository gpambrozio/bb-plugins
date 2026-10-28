/**
 * What this bb's app offers beyond bb 0.47, the oldest Herald runs on.
 *
 * bb 0.48 brought the panel controller (`experimental_panel`), header thread
 * actions (`placement: "header"`) and `experimental_useTabVisible` together,
 * so the last one stands for all three. It is read through the namespace, not
 * a named import: bb's builder refuses a named import its own app does not
 * have, and compiles a namespace member it does not have to `undefined`. A
 * git install is built by the bb that runs it, so the answer is that bb's.
 */
import * as sdkApp from "@get-bb/plugin-sdk/app";

const tabVisible: (() => boolean) | undefined = sdkApp.experimental_useTabVisible;

/** True on bb 0.48 or newer: the panel controller, header thread actions and tab visibility. */
export const HAS_PANEL_CONTROLLER = typeof tabVisible === "function";

/**
 * Whether the tab this component renders in is showing. bb 0.47 cannot say,
 * so there it is always true: the tab keeps working, as it did before.
 */
export const useTabVisible: () => boolean = tabVisible ?? (() => true);
