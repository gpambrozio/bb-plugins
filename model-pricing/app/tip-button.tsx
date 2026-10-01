/**
 * A button with bb's own tooltip, which bb's vendored `Button` uses in place of
 * a `title`. The tooltip hangs on a wrapper so it also shows while the button
 * is disabled, which is when "why can't I press this?" is asked.
 */
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function TipButton({ label, ...props }: ButtonProps & { label: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button aria-label={label} {...props} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
