/**
 * The page `annotation-layout.test.ts` loads to check scrolling: the tab's shape (a toolbar above its
 * own scroll area, files inside) in a container like bb's around it, which clips with `overflow:
 * hidden` and holds a little more than its height. `window.scrollWithin` is the tab's scrolling.
 */
import { scrollWithin } from "../scroll-within";

declare global {
  interface Window {
    scrollWithin: typeof scrollWithin;
  }
}

window.scrollWithin = scrollWithin;

const sections = Array.from({ length: 12 }, (_, index) => `<section data-file="${index}" style="height: 160px; border-bottom: 1px solid #ccc">file ${index}</section>`).join("");

document.body.innerHTML = `
<div data-bb style="height: 400px; overflow: hidden">
  <div style="height: 32px">bb's own bar</div>
  <div data-tab style="height: 100%; display: flex; flex-direction: column">
    <div data-toolbar style="height: 40px; flex-shrink: 0">toolbar</div>
    <div data-scroll style="flex: 1; min-height: 0; overflow-y: auto">${sections}</div>
  </div>
</div>`;
