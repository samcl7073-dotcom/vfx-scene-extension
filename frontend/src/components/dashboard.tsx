"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  Clapperboard,
  Clock,
  Download,
  Eye,
  ImagePlus,
  Images,
  Layers,
  Loader2,
  Mountain,
  Palette,
  ScanSearch,
  Sparkles,
  Sun,
  Trash2,
  Trees,
  Upload,
  Waves,
  Wifi,
  WifiOff,
  XCircle,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  useSSE,
  type AnalysisResult,
  type JobEvent,
  type JobType,
  type MaskData,
  type SubmitOptions,
} from "@/lib/use-sse";
import { MaskOverlay } from "@/components/mask-overlay";

// ---------------------------------------------------------------------------
// Gallery item — persisted across job-map overwrites
// ---------------------------------------------------------------------------

interface GalleryItem {
  job_id: string;
  image_data: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Status icon config
// ---------------------------------------------------------------------------

const STATUS_CFG: Record<
  JobType,
  { icon: React.ElementType; color: string; label: string; spin?: boolean }
> = {
  queued:   { icon: Clock,        color: "text-slate-500",    label: "Queued" },
  status:   { icon: Sparkles,     color: "text-amber-400",    label: "Loading",    spin: true },
  step:     { icon: Loader2,      color: "text-sky-400",      label: "Generating", spin: true },
  complete: { icon: CheckCircle2, color: "text-emerald-400",  label: "Complete" },
  error:    { icon: XCircle,      color: "text-red-400",      label: "Failed" },
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Background element display config (preset categories)
// ---------------------------------------------------------------------------

const BG_ELEMENTS: {
  key: keyof Omit<AnalysisResult["background_elements"], "other">;
  label: string;
  icon: React.ElementType;
}[] = [
  { key: "sky",                    label: "Sky",         icon: Sun },
  { key: "sun_or_moon",           label: "Sun / Moon",  icon: Sparkles },
  { key: "sea_or_water",          label: "Sea / Water",  icon: Waves },
  { key: "mountains_or_hills",    label: "Mountains",    icon: Mountain },
  { key: "forests_or_vegetation", label: "Forests",      icon: Trees },
  { key: "cityscape_or_buildings",label: "Buildings",    icon: Layers },
];

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function Dashboard() {
  const { jobs, connected, submitJob, analyzeImage } = useSSE();

  // --- gallery (accumulated completed generations) ---
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const job of jobs) {
      if (
        job.kind !== "analyze" &&
        job.type === "complete" &&
        job.image_data &&
        !seenRef.current.has(job.job_id)
      ) {
        seenRef.current.add(job.job_id);
        setGallery((prev) => [
          { job_id: job.job_id, image_data: job.image_data!, timestamp: Date.now() },
          ...prev,
        ]);
      }
    }
  }, [jobs]);

  const clearGallery = useCallback(() => {
    setGallery([]);
    seenRef.current.clear();
  }, []);

  // --- canvas state ---
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [selectedGalleryImg, setSelectedGalleryImg] = useState<string | null>(null);

  // --- analysis state ---
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(true);

  // --- mask overlay state ---
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [hoveringCanvas, setHoveringCanvas] = useState(false);
  const selectedMaskData: MaskData | null = selectedCategory ? analysisResult?.masks?.[selectedCategory] ?? null : null;

  useEffect(() => {
    for (const job of jobs) {
      if (job.kind === "analyze" && job.type === "complete" && job.analysis) {
        setAnalysisResult(job.analysis);
        setAnalysisPanelOpen(true);
        setAnalyzing(false);
      }
      if (job.kind === "analyze" && job.type === "error") {
        setAnalyzing(false);
      }
    }
  }, [jobs]);

  const handleAnalyze = useCallback(async () => {
    if (!baseFile) return;
    setAnalyzing(true);
    setAnalysisResult(null);
    setSelectedCategory(null);
    try {
      await analyzeImage(baseFile);
    } catch {
      setAnalyzing(false);
    }
  }, [baseFile, analyzeImage]);

  const imageInputRef = useRef<HTMLInputElement>(null);

  // derived – exclude analysis jobs from the active generation tracker
  const activeJob = jobs.find(
    (j) => j.kind !== "analyze" && j.type !== "complete" && j.type !== "error",
  );
  const latestComplete = jobs.find(
    (j) => j.kind !== "analyze" && j.type === "complete" && j.image_data,
  );
  const displayImage = selectedGalleryImg ?? latestComplete?.image_data ?? previewUrl;

  // handlers
  const handleImage = useCallback((file: File) => {
    setBaseFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setSelectedGalleryImg(null);
    setAnalysisResult(null);
    setSelectedCategory(null);
  }, []);

  const handleGenerate = useCallback(async () => {
    setSubmitting(true);
    try {
      const opts: SubmitOptions = {};
      if (baseFile) opts.image = baseFile;
      await submitJob(opts);
    } finally {
      setSubmitting(false);
    }
  }, [baseFile, submitJob]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file?.type.startsWith("image/")) handleImage(file);
    },
    [handleImage],
  );

  // active‐job progress for the global bar
  const stepProgress = activeJob?.progress ?? (latestComplete ? 100 : 0);
  const stepLabel =
    activeJob?.type === "step" && activeJob.step != null && activeJob.total_steps != null
      ? `Step ${activeJob.step} / ${activeJob.total_steps}`
      : activeJob?.message ?? (latestComplete ? "Complete" : "Idle");

  // sidebar job count
  const activeCount = jobs.filter(
    (j) => j.type !== "complete" && j.type !== "error",
  ).length;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* ================================================================ */}
      {/* HEADER                                                           */}
      {/* ================================================================ */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 bg-card/80 px-5 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <Clapperboard className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-semibold tracking-tight">
            VFX Scene Extension
          </h1>
          <span className="hidden text-[10px] text-muted-foreground sm:inline">
            ComfyUI &middot; Flux GGUF
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {connected ? (
            <>
              <Wifi className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-muted-foreground">Live</span>
            </>
          ) : (
            <>
              <WifiOff className="h-3.5 w-3.5 text-red-400" />
              <span className="text-muted-foreground">Disconnected</span>
            </>
          )}
        </div>
      </header>

      {/* ================================================================ */}
      {/* GLOBAL STEP PROGRESS BAR                                         */}
      {/* ================================================================ */}
      <div className="shrink-0 border-b border-border/40 bg-card/50 px-5 py-2">
        <div className="flex items-center gap-3">
          <Zap className="h-3.5 w-3.5 shrink-0 text-primary" />
          <Progress value={stepProgress} max={100} className="flex-1">
            <ProgressLabel className="min-w-[110px] text-xs text-muted-foreground">
              {stepLabel}
            </ProgressLabel>
            <ProgressValue className="text-xs" />
          </Progress>
        </div>
      </div>

      {/* ================================================================ */}
      {/* MAIN BODY — Canvas + Sidebar                                     */}
      {/* ================================================================ */}
      <div className="flex flex-1 overflow-hidden">
        {/* ---------- CANVAS AREA ---------- */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* toolbar */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Main Canvas</h2>
              <p className="text-xs text-muted-foreground">
                Upload an image, then generate mask options to analyze the scene
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => imageInputRef.current?.click()}
                disabled={submitting || analyzing}
              >
                <ImagePlus className="mr-1.5 h-3 w-3" />
                Upload
              </Button>
              {baseFile && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleAnalyze}
                  disabled={analyzing || submitting}
                >
                  {analyzing ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <ScanSearch className="mr-1.5 h-3 w-3" />
                  )}
                  {analyzing ? "Analyzing…" : "Generate Mask Options"}
                </Button>
              )}
              {baseFile && (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleGenerate}
                  disabled={submitting || analyzing}
                >
                  {submitting && (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  )}
                  Generate
                </Button>
              )}
            </div>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImage(f);
              }}
            />
          </div>

          {/* analysis results panel */}
          {analysisResult && (
            <Card className="shrink-0 border-primary/20 bg-card/80">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-2.5 text-left"
                onClick={() => setAnalysisPanelOpen((o) => !o)}
              >
                <div className="flex items-center gap-2">
                  <Eye className="h-3.5 w-3.5 text-primary" />
                  <span className="text-xs font-semibold">Mask Options — Scene Breakdown</span>
                </div>
                {analysisPanelOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>

              {analysisPanelOpen && (
                <CardContent className="space-y-4 px-4 pb-4 pt-0">
                  {/* context line */}
                  <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-primary/70">
                      Scene Context
                    </span>
                    <p className="mt-1 text-xs leading-relaxed text-foreground">
                      {analysisResult.description}
                    </p>
                  </div>

                  {/* foreground — AI-decided */}
                  <div className="space-y-2 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-sky-400">
                      Foreground — AI Identified
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {analysisResult.foreground_elements.length > 0 ? (
                        analysisResult.foreground_elements.map((el) => (
                          <Badge
                            key={el}
                            variant="secondary"
                            className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-300"
                          >
                            {el}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-[10px] text-muted-foreground">
                          None detected
                        </span>
                      )}
                    </div>
                  </div>

                  {/* background — preset categories */}
                  <div className="space-y-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Background Elements — Isolated
                    </span>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                      {BG_ELEMENTS.map(({ key, label, icon: Icon }) => {
                        const active = analysisResult.background_elements[key];
                        const hasMask = !!(active && analysisResult.masks?.[key]);
                        const selected = selectedCategory === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={!hasMask}
                            onClick={() => {
                              if (hasMask) setSelectedCategory(selected ? null : key);
                            }}
                            className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-center transition-all ${
                              selected
                                ? "border-emerald-400 bg-emerald-500/20 ring-2 ring-emerald-400/50 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
                                : active
                                  ? "border-emerald-500/40 bg-emerald-500/10 shadow-[0_0_8px_rgba(16,185,129,0.15)]"
                                  : "border-border/30 bg-muted/20 opacity-35"
                            } ${hasMask ? "cursor-pointer hover:border-emerald-400/60" : ""}`}
                          >
                            <Icon
                              className={`h-4 w-4 ${
                                selected ? "text-emerald-300" : active ? "text-emerald-400" : "text-muted-foreground"
                              }`}
                            />
                            <span
                              className={`text-[10px] font-medium leading-tight ${
                                selected ? "text-emerald-200" : active ? "text-emerald-300" : "text-muted-foreground"
                              }`}
                            >
                              {label}
                            </span>
                            <span
                              className={`text-[9px] font-semibold ${
                                selected ? "text-emerald-300" : active ? "text-emerald-400" : "text-muted-foreground/50"
                              }`}
                            >
                              {selected ? "SELECTED" : active ? "DETECTED" : "—"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {analysisResult.background_elements.other
                      ?.filter(Boolean)
                      .length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <span className="text-[10px] text-muted-foreground">Other:</span>
                        {analysisResult.background_elements.other
                          .filter(Boolean)
                          .map((el) => (
                            <Badge
                              key={el}
                              className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-300"
                            >
                              {el}
                            </Badge>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* metadata row */}
                  <div className="flex flex-wrap items-center gap-4 border-t border-border/30 pt-2.5 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Palette className="h-3 w-3" />
                      {analysisResult.dominant_colors.join(", ") || "—"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Sun className="h-3 w-3" />
                      {analysisResult.lighting || "—"}
                    </span>
                    <span className="flex items-center gap-1">
                      <Layers className="h-3 w-3" />
                      Depth: {analysisResult.depth_hint || "—"}
                    </span>
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* canvas card */}
          <Card
            className={`relative flex min-h-[300px] items-center justify-center overflow-hidden transition-colors ${
              isDragging
                ? "border-primary/60 bg-primary/5"
                : "border-dashed border-border/50"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
          >
            <CardContent className="flex flex-col items-center gap-4 py-16">
              {displayImage ? (
                <div
                  className="relative"
                  onMouseEnter={() => setHoveringCanvas(true)}
                  onMouseLeave={() => setHoveringCanvas(false)}
                >
                  <img
                    src={displayImage}
                    alt="Canvas preview"
                    className="max-w-full rounded-lg object-contain shadow-2xl ring-1 ring-white/5"
                  />

                  {/* mask overlay — interactive canvas with zone adjustment sliders */}
                  {selectedMaskData && (
                    <MaskOverlay
                      maskData={selectedMaskData}
                      isHovering={hoveringCanvas}
                    />
                  )}

                  {(activeJob || analyzing) && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 backdrop-blur-sm">
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-7 w-7 animate-spin text-primary" />
                        <span className="text-xs font-medium text-slate-200">
                          {analyzing
                            ? "Analyzing scene…"
                            : activeJob?.message}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="rounded-full bg-muted/60 p-4">
                    <Upload className="h-7 w-7 text-muted-foreground" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-medium">
                      Drag & drop an image here
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      PNG, JPG, or EXR &mdash; up to 50 MB
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ---------- LIVE STATUS SIDEBAR ---------- */}
        <aside className="flex w-72 shrink-0 flex-col border-l border-border/60 bg-card/60">
          <div className="flex h-10 items-center gap-2 border-b border-border/40 px-3">
            <Activity className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold">Live Status</span>
            {activeCount > 0 && (
              <Badge variant="secondary" className="ml-auto tabular-nums text-[10px]">
                {activeCount}
              </Badge>
            )}
          </div>

          <ScrollArea className="flex-1">
            {jobs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-14 text-center text-xs text-muted-foreground">
                <Circle className="h-4 w-4" />
                <p>No jobs yet</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1 p-1.5">
                {[...jobs].reverse().map((job) => {
                  const cfg = STATUS_CFG[job.type] ?? STATUS_CFG.queued;
                  const Icon = cfg.icon;
                  return (
                    <div
                      key={job.job_id}
                      className="rounded-md border border-border/40 bg-background/60 p-2.5 transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 truncate">
                          <Icon
                            className={`h-3.5 w-3.5 shrink-0 ${cfg.color} ${
                              cfg.spin ? "animate-spin" : ""
                            }`}
                          />
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {job.job_id}
                          </span>
                        </div>
                        <Badge
                          variant={job.type === "complete" ? "default" : "outline"}
                          className="h-4 shrink-0 text-[9px]"
                        >
                          {cfg.label}
                        </Badge>
                      </div>

                      <p className="mt-1 pl-5 text-[11px] text-muted-foreground leading-snug">
                        {job.message || "Waiting..."}
                      </p>

                      {job.type === "step" &&
                        job.step != null &&
                        job.total_steps != null && (
                          <p className="mt-0.5 pl-5 text-[10px] tabular-nums text-muted-foreground/70">
                            Step {job.step} / {job.total_steps}
                          </p>
                        )}

                      <div className="mt-1.5 pl-5">
                        <Progress value={job.progress} max={100}>
                          <ProgressLabel className="sr-only">
                            {job.job_id}
                          </ProgressLabel>
                          <ProgressValue className="text-[10px]" />
                        </Progress>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <Separator className="opacity-40" />
          <div className="flex items-center gap-2 px-3 py-2 text-[10px] text-muted-foreground">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? "bg-emerald-400" : "bg-red-400"
              }`}
            />
            {connected ? "SSE stream connected" : "Reconnecting..."}
          </div>
        </aside>
      </div>

      {/* ================================================================ */}
      {/* GALLERY                                                          */}
      {/* ================================================================ */}
      <div className="shrink-0 border-t border-border/60 bg-card/50">
        <div className="flex items-center justify-between px-5 pt-2.5 pb-1">
          <div className="flex items-center gap-2">
            <Images className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold">Gallery</span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {gallery.length} generation{gallery.length !== 1 ? "s" : ""}
            </span>
          </div>
          {gallery.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={clearGallery}
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Clear
            </Button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto px-5 pb-3 pt-1">
          {gallery.length === 0 ? (
            <div className="flex w-full items-center justify-center py-4 text-xs text-muted-foreground/60">
              Completed generations will appear here
            </div>
          ) : (
            gallery.map((item) => (
              <button
                key={item.job_id}
                type="button"
                onClick={() => setSelectedGalleryImg(item.image_data)}
                className={`group relative shrink-0 overflow-hidden rounded-md ring-1 transition-all hover:ring-primary/60 ${
                  selectedGalleryImg === item.image_data
                    ? "ring-primary ring-2"
                    : "ring-border/40"
                }`}
              >
                <img
                  src={item.image_data}
                  alt={`Generation ${item.job_id}`}
                  className="h-16 w-auto object-cover"
                />
                <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/50 to-transparent p-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <a
                    href={item.image_data}
                    download={`vfx_${item.job_id}.png`}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded bg-black/60 p-0.5"
                  >
                    <Download className="h-3 w-3 text-white" />
                  </a>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
