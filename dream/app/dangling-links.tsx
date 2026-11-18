/**
 * The links a dream left pointing at memory files that are gone, as a warning: on a run in the
 * history and on a waiting dry run's view. Nothing when there are none.
 */
import { linksText } from "../shared/format";
import type { DanglingLinkInfo } from "../shared/types";

export function DanglingLinks({ links }: { links: readonly DanglingLinkInfo[] | undefined }) {
  const text = linksText(links);
  if (text === null || links === undefined) return null;
  return (
    <div className="rounded-md border border-warning px-3 py-2 text-sm text-warning-text" role="status">
      <p>{text}:</p>
      <ul className="mt-1 space-y-0.5 font-mono text-xs">
        {links.map((entry) => (
          <li key={`${entry.file} ${entry.link}`}>
            {entry.file} → {entry.link}
          </li>
        ))}
      </ul>
    </div>
  );
}
