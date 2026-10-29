/**
 * The page `annotation-layout.test.ts` loads to check scrolling: the tab's shape (a toolbar above its
 * own scroll area, files inside) in a container like bb's around it, which clips with `overflow:
 * hidden` and holds a little more than its height. `window.scrollWithin` is the tab's scrolling.
 * Each file has a sticky header and a body, as the tab's do; file 6 holds a comment card, and
 * `window.expand(index, height)` grows a file's body as its diff does when it has loaded and drawn.
 */
import { scrollWithin } from "../scroll-within";

declare global {
  interface Window {
    scrollWithin: typeof scrollWithin;
    expand(index: number, height: number): void;
  }
}

window.scrollWithin = scrollWithin;
window.expand = (index, height) => {
  // A new node, as Pierre's diff replaces the "Loading the diff…" line.
  document.querySelector(`[data-file="${index}"] [data-body]`)!.replaceChildren(Object.assign(document.createElement("div"), { style: `height: ${height}px` }));
};

const body = (index: number) =>
  index === 6
    ? `<div style="height: 60px"></div><div data-card tabindex="-1" style="height: 60px; background: #fdd">comment</div>`
    : `<p style="margin: 0">Loading the diff…</p>`;
const sections = Array.from(
  { length: 12 },
  (_, index) =>
    `<section data-file="${index}" style="border-bottom: 1px solid #ccc"><header style="position: sticky; top: 0; height: 24px; background: #eee">file ${index}</header><div data-body style="min-height: 135px">${body(index)}</div></section>`,
).join("");

document.body.innerHTML = `
<div data-bb style="height: 400px; overflow: hidden">
  <div style="height: 32px">bb's own bar</div>
  <div data-tab style="height: 100%; display: flex; flex-direction: column">
    <div data-toolbar style="height: 40px; flex-shrink: 0">toolbar</div>
    <div data-scroll style="flex: 1; min-height: 0; overflow-y: auto">${sections}</div>
  </div>
</div>`;
