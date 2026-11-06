/**
 * Under the plugin's settings: the projects marked "Never for this project", each with Undo.
 */
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { rpcContract } from "../shared/contract";
import { errorText, useLearningRpc } from "./data";

export function NeverProjectsSection() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "neverProjects", input: {} });
  const rpc = useLearningRpc();
  const projects = query.data?.projects ?? [];
  return (
    <div className="flex flex-col gap-2 text-sm">
      <h3 className="font-medium">Projects with no offers</h3>
      {projects.length === 0 ? (
        <p className="text-muted-foreground">None. "Never for this project" on an offer adds one here.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {projects.map((project) => (
            <li key={project.key} className="flex items-center justify-between gap-2">
              <span className="truncate">{project.name}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => rpc.call("removeNeverProject", { key: project.key }).catch((error: unknown) => toast.error(`Learning Exercises: ${errorText(error)}`))}
              >
                Undo
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
