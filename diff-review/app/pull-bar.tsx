/** The bar a pull request's view shows under the toolbar: the pull request, when its threads were read, Submit. */
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

import type { PullDetails } from "../shared/github";
import { ago } from "./labels";

export function PullBar({ pull, onSubmit, onSync, refreshing }: { pull: PullDetails; onSubmit(): void; onSync(): void; refreshing: boolean }) {
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
      <Icon name="GitPullRequest" className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">
        #{pull.number} {pull.title}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {pull.baseRefName} ← {pull.headRefName} · {pull.state.toLowerCase()}
      </span>
      {pull.syncError === null ? (
        <span className="shrink-0 text-muted-foreground">{pull.syncedAt === null ? "" : `GitHub threads read ${ago(pull.syncedAt)}`}</span>
      ) : (
        <span className="shrink-0 text-warning-text" title={pull.syncError}>
          Could not read GitHub's review threads
        </span>
      )}
      <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={onSync} disabled={refreshing}>
        <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        Sync with GitHub
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => navigate.openUrl(pull.url)}>
        <Icon name="ExternalLink" className="size-3.5" />
        Open on GitHub
      </Button>
      <Button type="button" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={onSubmit}>
        <Icon name="Sent" className="size-3.5" />
        Submit review…
      </Button>
    </div>
  );
}
