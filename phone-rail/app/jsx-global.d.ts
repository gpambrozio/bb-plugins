/**
 * @dnd-kit's typings name the global `JSX` namespace, which React 19's types no
 * longer declare; this points it at React's. Types only.
 */
import type { JSX as ReactJSX } from "react";

declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
  }
}
