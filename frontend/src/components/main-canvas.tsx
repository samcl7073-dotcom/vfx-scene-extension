"use client";

import { useCallback, useState, useRef } from "react";
import { Upload, ImagePlus, Loader2, Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { JobEvent, SubmitOptions } from "@/lib/use-sse";

interface MainCanvasProps {
  onSubmit: (opts: SubmitOptions) => Promise<{ job_id: string }>;
  jobs: JobEvent[];
}

export function MainCanvas({ onSubmit, jobs }: MainCanvasProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [baseFile, setBaseFile] = useState<File | null>(null);
  const [maskFile, setMaskFile] = useState<File | null>(null);
  const [maskPreview, setMaskPreview] = useState<string | null>(null);

  const imageRef = useRef<HTMLInputElement>(null);
  const maskRef = useRef<HTMLInputElement>(null);

  const latestComplete = jobs.find((j) => j.type === "complete" && j.image_data);
  const latestActive = jobs.find(
    (j) => j.type !== "complete" && j.type !== "error"
  );
  const displayImage = latestComplete?.image_data ?? previewUrl;

  const handleImage = useCallback((file: File) => {
    setBaseFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setMaskFile(null);
    setMaskPreview(null);
  }, []);

  const handleMask = useCallback((file: File) => {
    setMaskFile(file);
    setMaskPreview(URL.createObjectURL(file));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      const opts: SubmitOptions = {};
      if (baseFile) opts.image = baseFile;
      if (maskFile) opts.mask = maskFile;
      await onSubmit(opts);
    } finally {
      setSubmitting(false);
    }
  }, [baseFile, maskFile, onSubmit]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file?.type.startsWith("image/")) handleImage(file);
    },
    [handleImage]
  );

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Main Canvas</h2>
          <p className="text-sm text-muted-foreground">
            Drop an image to extend the scene
          </p>
        </div>
        <div className="flex items-center gap-2">
          {baseFile && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => maskRef.current?.click()}
            >
              <Eraser className="mr-2 h-4 w-4" />
              {maskFile ? "Replace Mask" : "Add Mask"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => imageRef.current?.click()}
            disabled={submitting}
          >
            <ImagePlus className="mr-2 h-4 w-4" />
            Upload Image
          </Button>
          {baseFile && (
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Generate
            </Button>
          )}
        </div>
        <input
          ref={imageRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImage(f);
          }}
        />
        <input
          ref={maskRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleMask(f);
          }}
        />
      </div>

      <Card
        className={`relative flex flex-1 items-center justify-center overflow-hidden transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-dashed border-border"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
      >
        <CardContent className="flex flex-col items-center gap-4 py-20">
          {displayImage ? (
            <div className="relative">
              <img
                src={displayImage}
                alt="Preview"
                className="max-h-[60vh] rounded-lg object-contain shadow-lg"
              />
              {maskPreview && (
                <img
                  src={maskPreview}
                  alt="Mask overlay"
                  className="absolute inset-0 h-full w-full rounded-lg object-contain opacity-30 mix-blend-screen"
                />
              )}
              {latestActive && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 animate-spin text-white" />
                    <span className="text-sm font-medium text-white">
                      {latestActive.message}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="rounded-full bg-muted p-4">
                <Upload className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="font-medium">Drag & drop an image here</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  PNG, JPG, or EXR up to 50 MB
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
