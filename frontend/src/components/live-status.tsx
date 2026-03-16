"use client";

import {
  Activity,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  Clock,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { JobEvent, JobType } from "@/lib/use-sse";

interface LiveStatusProps {
  jobs: JobEvent[];
  connected: boolean;
}

const STATUS_CONFIG: Record<
  JobType,
  { icon: React.ElementType; color: string; label: string; spinning?: boolean }
> = {
  queued:   { icon: Clock,        color: "text-muted-foreground", label: "Queued" },
  status:   { icon: Sparkles,     color: "text-amber-500",        label: "Loading",     spinning: true },
  step:     { icon: Loader2,      color: "text-blue-500",         label: "Generating",  spinning: true },
  complete: { icon: CheckCircle2, color: "text-emerald-500",      label: "Complete" },
  error:    { icon: XCircle,      color: "text-destructive",      label: "Failed" },
};

export function LiveStatus({ jobs, connected }: LiveStatusProps) {
  const activeCount = jobs.filter(
    (j) => j.type !== "complete" && j.type !== "error"
  ).length;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Activity className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Live Status</span>
        {activeCount > 0 && (
          <Badge variant="secondary" className="ml-auto tabular-nums">
            {activeCount} active
          </Badge>
        )}
      </div>

      <ScrollArea className="flex-1">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center text-sm text-muted-foreground">
            <Circle className="h-5 w-5" />
            <p>No jobs yet</p>
            <p className="text-xs">Upload an image to start a VFX pipeline</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            {[...jobs].reverse().map((job) => {
              const cfg = STATUS_CONFIG[job.type] ?? STATUS_CONFIG.queued;
              const Icon = cfg.icon;
              return (
                <div
                  key={job.job_id}
                  className="rounded-lg border border-border bg-background p-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium truncate">
                      <Icon
                        className={`h-4 w-4 shrink-0 ${cfg.color} ${
                          cfg.spinning ? "animate-spin" : ""
                        }`}
                      />
                      <span className="truncate font-mono text-xs">
                        {job.job_id}
                      </span>
                    </div>
                    <Badge
                      variant={job.type === "complete" ? "default" : "outline"}
                      className="shrink-0 text-[10px]"
                    >
                      {cfg.label}
                    </Badge>
                  </div>

                  <p className="mt-1.5 pl-6 text-xs text-muted-foreground">
                    {job.message || "Waiting..."}
                  </p>

                  {job.type === "step" && job.step != null && job.total_steps != null && (
                    <p className="mt-0.5 pl-6 text-[10px] text-muted-foreground tabular-nums">
                      Step {job.step} / {job.total_steps}
                    </p>
                  )}

                  <div className="mt-2 pl-6">
                    <Progress value={job.progress} max={100}>
                      <ProgressLabel className="sr-only">
                        {job.job_id}
                      </ProgressLabel>
                      <ProgressValue />
                    </Progress>
                  </div>

                  {job.type === "complete" && job.image_data && (
                    <div className="mt-2 pl-6">
                      <img
                        src={job.image_data}
                        alt="Result thumbnail"
                        className="h-16 w-auto rounded border border-border object-cover"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      <Separator />
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <span
          className={`h-2 w-2 rounded-full ${
            connected ? "bg-emerald-500" : "bg-destructive"
          }`}
        />
        {connected ? "SSE connected" : "Reconnecting..."}
      </div>
    </aside>
  );
}
