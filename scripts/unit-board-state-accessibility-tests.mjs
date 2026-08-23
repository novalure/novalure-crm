#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const unitBoard = await readFile(new URL("../src/components/unit-board.tsx", import.meta.url), "utf8");
const workspace = await readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");

test("unit mutations and create CTAs are capability-aware", () => {
  assert.match(unitBoard, /canManage: boolean/);
  assert.match(workspace, /canManage=\{hasProductCapability\(sessionProductRole, "reservations:write"\)\}/);
  assert.match(unitBoard, /if \(!canManage\) return/);
  assert.match(unitBoard, /units\.length === 0 && canManage/);
  assert.doesNotMatch(unitBoard, /projects\[0\]\?\.id/);
});

test("loading, error, no-record and no-filter-match states are distinct", () => {
  assert.match(unitBoard, /LoadingState/);
  assert.match(unitBoard, /ErrorState/);
  assert.match(unitBoard, /EmptyState/);
  assert.match(unitBoard, /Keine Filtertreffer/);
  assert.match(unitBoard, /Ihre Rolle besitzt keinen Erstellzugriff/);
  assert.match(workspace, /liveCoreData\.moduleErrors\?\.propertyUnits/);
});

test("unit action controls reflow and preserve 44px targets", () => {
  assert.doesNotMatch(unitBoard, /flex min-w-36 flex-col gap-2/);
  assert.match(unitBoard, /flex w-56 min-w-0 flex-col gap-2/);
  assert.match(unitBoard, /min-h-11 whitespace-normal break-words/);
  assert.match(unitBoard, /min-w-60 px-4 py-3/);
});

test("relationship viewing and offer actions are UI fail-closed while launch scope is off", () => {
  for (const handler of ["createViewingSlot", "createOfferMilestone", "markOfferLost"]) {
    assert.match(
      unitBoard,
      new RegExp(`function ${handler}\\([^)]*\\) \\{\\s*if \\(!canManage \\|\\| !reservationRelationshipSyncLaunchEnabled\\) return;`),
    );
  }

  const guardedButtons = unitBoard.match(
    /disabled=\{!canManage \|\| !reservationRelationshipSyncLaunchEnabled/g,
  ) ?? [];
  assert.ok(guardedButtons.length >= 7, "all reservation, viewing and offer buttons must be disabled");
});
