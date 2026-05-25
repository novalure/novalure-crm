"use client";

import { useEffect, useRef, useState } from "react";
import { getMediaLibraryPickerCopy, type LanguageCode } from "@/lib/i18n";

export type CrmMediaAsset = {
  id: string;
  name: string;
  originalName: string;
  folder: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  alt?: string;
  createdAt: string;
  isPublic?: boolean;
  publicUrl?: string | null;
};

type MediaQuota = {
  limitBytes: number;
  maxFileBytes: number;
  remainingBytes: number;
  usedBytes: number;
};

type MediaLibraryPickerProps = {
  currentUrl?: string;
  folder: string;
  language: LanguageCode;
  onSelect: (asset: CrmMediaAsset) => void;
};

type MediaResponse = {
  assets: CrmMediaAsset[];
  quota: MediaQuota;
};

const defaultQuota: MediaQuota = {
  limitBytes: 1024 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  remainingBytes: 1024 * 1024 * 1024,
  usedBytes: 0,
};

export function MediaLibraryPicker({ currentUrl, folder, language, onSelect }: MediaLibraryPickerProps) {
  const copy = getMediaLibraryPickerCopy(language);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<CrmMediaAsset[]>([]);
  const [quota, setQuota] = useState<MediaQuota>(defaultQuota);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/media")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: MediaResponse | null) => {
        if (!active || !payload) return;
        setAssets(payload.assets);
        setQuota(payload.quota);
      })
      .catch(() => {
        if (active) setError(copy.loadError);
      });

    return () => {
      active = false;
    };
  }, [copy.loadError]);

  async function uploadImage(file: File) {
    setError("");

    if (!file.type.startsWith("image/")) {
      setError(copy.imageRequired);
      return;
    }

    if (file.size > quota.maxFileBytes) {
      setError(copy.tooLarge(formatBytes(quota.maxFileBytes)));
      return;
    }

    if (file.size > quota.remainingBytes) {
      setError(copy.quotaExceeded(formatBytes(quota.remainingBytes)));
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("folder", folder);
    formData.append("name", file.name);
    formData.append("alt", file.name.replace(/\.[^.]+$/, ""));
    formData.append("public", "true");

    setUploading(true);
    try {
      const response = await fetch("/api/media", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as { asset?: CrmMediaAsset; error?: string; quota?: MediaQuota };
      if (!response.ok || !payload.asset) throw new Error(payload.error || copy.uploadFailed);
      setAssets((current) => [payload.asset as CrmMediaAsset, ...current]);
      if (payload.quota) setQuota(payload.quota);
      onSelect(toPublicSelection(payload.asset));
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : copy.uploadFailed);
    } finally {
      setUploading(false);
    }
  }

  const usedPercent = Math.min(100, Math.round((quota.usedBytes / quota.limitBytes) * 100));

  return (
    <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.title}</p>
          <p className="mt-1 text-xs text-stone-600">
            {copy.quota(
              formatBytes(quota.usedBytes),
              formatBytes(quota.limitBytes),
              formatBytes(quota.maxFileBytes),
            )}
          </p>
        </div>
        <label className="cursor-pointer rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
          {uploading ? copy.uploading : copy.upload}
          <input
            accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file);
            }}
            ref={fileInputRef}
            type="file"
          />
        </label>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-stone-200">
        <span className="block h-full rounded-full bg-slate-950" style={{ width: `${usedPercent}%` }} />
      </div>

      {error ? <p className="rounded-md bg-red-50 p-2 text-xs font-semibold text-red-900">{error}</p> : null}

      <div className="grid max-h-64 gap-2 overflow-auto">
        {assets.length ? (
          assets.map((asset) => (
            <button
              className={`grid grid-cols-[64px_minmax(0,1fr)] gap-3 rounded-md border p-2 text-left text-xs ${
                currentUrl === (asset.publicUrl ?? asset.url) ? "border-slate-950 bg-white" : "border-stone-200 bg-white"
              }`}
              key={asset.id}
              onClick={() => onSelect(toPublicSelection(asset))}
              type="button"
            >
              <span
                aria-label={asset.alt || asset.name}
                className="h-14 rounded bg-stone-100 bg-cover bg-center"
                role="img"
                style={{ backgroundImage: `url("${asset.publicUrl ?? asset.url}")` }}
              />
              <span className="min-w-0">
                <strong className="block truncate text-slate-950">{asset.name}</strong>
                <span className="block truncate text-stone-500">{asset.folder}</span>
                <span className="block text-stone-500">{formatBytes(asset.sizeBytes)}</span>
              </span>
            </button>
          ))
        ) : (
          <p className="rounded-md bg-white p-3 text-xs font-semibold text-stone-500">{copy.empty}</p>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex >= 2 ? 1 : 0)} ${units[unitIndex]}`;
}

function toPublicSelection(asset: CrmMediaAsset): CrmMediaAsset {
  return {
    ...asset,
    url: asset.publicUrl ?? asset.url,
  };
}
