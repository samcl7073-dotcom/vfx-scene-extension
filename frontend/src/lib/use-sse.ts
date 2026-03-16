"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type JobType = "queued" | "status" | "step" | "complete" | "error";
export type JobKind = "generate" | "analyze";

export interface BackgroundElements {
  sky: boolean;
  sun_or_moon: boolean;
  sea_or_water: boolean;
  mountains_or_hills: boolean;
  forests_or_vegetation: boolean;
  cityscape_or_buildings: boolean;
  other: string[];
}

export interface AmbiguousZone {
  id: string;
  bbox: { x: number; y: number; w: number; h: number };
  centroid: { x: number; y: number };
  mean_alpha: number;
}

export interface MaskData {
  display: string;
  alpha_matte: string | null;
  zones: AmbiguousZone[];
}

export interface AnalysisResult {
  description: string;
  foreground_elements: string[];
  background_elements: BackgroundElements;
  dominant_colors: string[];
  lighting: string;
  depth_hint: string;
  masks?: Record<string, MaskData>;
}

export interface JobEvent {
  type: JobType;
  kind?: JobKind;
  job_id: string;
  message: string;
  progress: number;
  step?: number;
  total_steps?: number;
  image_data?: string;
  analysis?: AnalysisResult;
}

export interface SubmitOptions {
  prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  image_strength?: number;
  image?: File;
  mask?: File;
}

export function useSSE() {
  const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/stream`);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.addEventListener("job_update", (e) => {
      try {
        const data: JobEvent = JSON.parse(e.data);
        setJobs((prev) => {
          const next = new Map(prev);
          next.set(data.job_id, data);
          return next;
        });
      } catch {
        /* ignore malformed events */
      }
    });

    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  const submitJob = useCallback(async (opts: SubmitOptions): Promise<{ job_id: string }> => {
    const form = new FormData();
    form.append("prompt", opts.prompt ?? "Extend this scene seamlessly with photorealistic detail");
    form.append("width", String(opts.width ?? 1024));
    form.append("height", String(opts.height ?? 768));
    form.append("steps", String(opts.steps ?? 8));
    if (opts.seed != null) form.append("seed", String(opts.seed));
    form.append("image_strength", String(opts.image_strength ?? 0.75));
    if (opts.image) form.append("image", opts.image);
    if (opts.mask) form.append("mask", opts.mask);

    const res = await fetch(`${API_BASE}/api/generate`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  const analyzeImage = useCallback(async (image: File): Promise<{ job_id: string }> => {
    const form = new FormData();
    form.append("image", image);

    const res = await fetch(`${API_BASE}/api/analyze`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }, []);

  return { jobs: Array.from(jobs.values()), connected, submitJob, analyzeImage };
}
