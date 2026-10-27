/**
 * What every annotation (thread cards, the new comment's box) sits in. An annotation is a cell of
 * Pierre's code grid, whose code column grows to its widest cell's min-content: one long word or code
 * block in a comment widened the whole column past the pane, so the card ran off screen and the
 * code scrolled sideways. `contain: inline-size` keeps the annotation's content out of that sizing,
 * so it takes the column's width (the visible pane, as the code wraps), and its text wraps there; a
 * code block in a comment scrolls inside its card.
 *
 * Its own module, with no imports, so the browser layout test can load it with the real Pierre
 * (`annotation-layout.test.ts`).
 */
export const ANNOTATION_FIT = "[contain:inline-size] [overflow-wrap:anywhere] [&_pre]:overflow-x-auto";
