import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FunnelBlueprint, FunnelVersion } from "@/lib/funnel-schema";

type StoredFunnel = {
  blueprint: FunnelBlueprint;
  versions: FunnelVersion[];
  updatedAt: string;
};

type StoreShape = Record<string, StoredFunnel>;

const storeDirectory = path.join(process.cwd(), ".data");
const storePath = path.join(storeDirectory, "funnels.json");

async function readStore(): Promise<StoreShape> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as StoreShape;
  } catch {
    return {};
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(storeDirectory, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getStoredFunnel(funnelId: string) {
  const store = await readStore();
  return store[funnelId] ?? null;
}

export async function saveStoredFunnel(blueprint: FunnelBlueprint, label = "Designer-Speicherung") {
  const store = await readStore();
  const now = new Date().toISOString();
  const existing = store[blueprint.id];
  const nextVersion: FunnelVersion = {
    id: `${blueprint.id}_version_${Date.now()}`,
    label,
    createdAt: now,
    blueprint,
  };
  const versions = [nextVersion, ...(existing?.versions ?? [])].slice(0, 25);

  store[blueprint.id] = {
    blueprint,
    versions,
    updatedAt: now,
  };

  await writeStore(store);
  return store[blueprint.id];
}

export async function restoreStoredFunnelVersion(funnelId: string, versionId: string) {
  const store = await readStore();
  const stored = store[funnelId];
  const version = stored?.versions.find((item) => item.id === versionId);
  if (!stored || !version) return null;

  stored.blueprint = version.blueprint;
  stored.updatedAt = new Date().toISOString();
  await writeStore(store);
  return stored;
}
