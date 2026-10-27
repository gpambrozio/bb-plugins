/**
 * The page `annotation-layout.test.ts` loads in Chromium: the real `@pierre/diffs` `PatchDiff`, as the
 * tab sets it up (wrapped lines), with a comment card under a line that holds a long unbroken path
 * and a long code block. `?fit=0` leaves out the annotation box, to show the test catches the overflow.
 */
import { PatchDiff } from "@pierre/diffs/react";
import { createRoot } from "react-dom/client";

import { ANNOTATION_FIT } from "../annotation-fit";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = someFunction(withAVeryLongArgumentName, andAnotherOne, andYetAnotherVeryLongArgumentName, more);",
  " const d = 4;",
  "",
].join("\n");

const query = new URLSearchParams(location.search);
const diffStyle = query.get("style") === "split" ? "split" : "unified";
const fit = query.get("fit") !== "0";

const card = (
  <div data-card="" style={{ display: "flex", flexDirection: "column", gap: 8, border: "1px solid #ccc", borderRadius: 6, padding: 12 }}>
    <p>See src/some/really/long/path/that/never/breaks/anywhere/at/all/file-name-that-goes-on-and-on.ts for the rest.</p>
    <pre>{"const thisIsALongCodeBlockLine = callSomething(withArguments, thatGoOnAndOn, forAVeryLongTime, untilTheyOverflow);"}</pre>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button type="button">Reply</button>
      <button type="button">Resolve</button>
      <button type="button">Dismiss</button>
    </div>
  </div>
);

createRoot(document.getElementById("root")!).render(
  <div data-pane="" style={{ width: 600, overflow: "auto" }}>
    <PatchDiff<undefined, undefined>
      patch={PATCH}
      options={{ diffStyle, overflow: "wrap", disableFileHeader: true }}
      lineAnnotations={[{ side: "additions", lineNumber: 3, metadata: undefined }]}
      renderAnnotation={() => (fit ? <div className={ANNOTATION_FIT}>{card}</div> : card)}
    />
  </div>,
);
