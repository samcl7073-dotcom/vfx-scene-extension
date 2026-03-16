"use client";

import { Clapperboard, Wifi, WifiOff } from "lucide-react";

interface HeaderProps {
  connected: boolean;
}

export function Header({ connected }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <div className="flex items-center gap-2.5">
        <Clapperboard className="h-5 w-5 text-primary" />
        <h1 className="text-base font-semibold tracking-tight">
          VFX Scene Extension
        </h1>
      </div>

      <div className="flex items-center gap-2 text-xs">
        {connected ? (
          <>
            <Wifi className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-muted-foreground">Live</span>
          </>
        ) : (
          <>
            <WifiOff className="h-3.5 w-3.5 text-destructive" />
            <span className="text-muted-foreground">Disconnected</span>
          </>
        )}
      </div>
    </header>
  );
}
