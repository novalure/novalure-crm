import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAuthorizedStudioProjectId,
  getStudioNavigationPreferenceKey,
  selectStudioWebsiteEnquiries,
  STUDIO_PROJECT_ID,
  STUDIO_WORKSPACE_ID,
} from "../src/lib/studio-navigation";

const otherWorkspaceId = "41051f92-750c-41ae-9f67-177c0a11a070";
const otherProjectId = "5cd6f077-ec49-419a-a4cc-b10239d5c314";
const preferenceKey = "novalure-crm-navigation-preset-v1";
const studioProject = { id: STUDIO_PROJECT_ID, workspaceId: STUDIO_WORKSPACE_ID };
const foreignProject = { id: STUDIO_PROJECT_ID, workspaceId: otherWorkspaceId };
const unrelatedProject = { id: otherProjectId, workspaceId: STUDIO_WORKSPACE_ID };

test("Studio selects its authorized project rather than the first available project", () => {
  assert.equal(
    getAuthorizedStudioProjectId(STUDIO_WORKSPACE_ID, [unrelatedProject, studioProject]),
    STUDIO_PROJECT_ID,
  );
});

test("Studio project selection denies missing access and foreign workspace matches", () => {
  const deniedCases = [
    { workspaceId: STUDIO_WORKSPACE_ID, projects: [] },
    { workspaceId: STUDIO_WORKSPACE_ID, projects: [unrelatedProject] },
    { workspaceId: STUDIO_WORKSPACE_ID, projects: [foreignProject] },
    { workspaceId: STUDIO_WORKSPACE_ID, projects: [foreignProject, unrelatedProject] },
    { workspaceId: otherWorkspaceId, projects: [studioProject] },
    { workspaceId: otherWorkspaceId, projects: [foreignProject] },
    { workspaceId: "", projects: [studioProject] },
  ];
  for (const { workspaceId, projects } of deniedCases) {
    assert.equal(getAuthorizedStudioProjectId(workspaceId, projects), null);
  }
});

test("Studio preferences are isolated by user with encoded key components", () => {
  const userId = "user:/ä?#%";
  const key = getStudioNavigationPreferenceKey(preferenceKey, userId, STUDIO_WORKSPACE_ID);
  assert.equal(key, `${preferenceKey}:${encodeURIComponent(userId)}:${encodeURIComponent(STUDIO_WORKSPACE_ID)}`);
  assert.notEqual(key, getStudioNavigationPreferenceKey(preferenceKey, "another-user", STUDIO_WORKSPACE_ID));
  assert.notEqual(key, getStudioNavigationPreferenceKey("another-preference", userId, STUDIO_WORKSPACE_ID));
  assert.notEqual(
    getStudioNavigationPreferenceKey(preferenceKey, "user:admin", STUDIO_WORKSPACE_ID),
    getStudioNavigationPreferenceKey(preferenceKey, "user%3Aadmin", STUDIO_WORKSPACE_ID),
  );
});

test("other workspaces keep their legacy preference key without reusing Studio preferences", () => {
  for (const workspaceId of [otherWorkspaceId, "", "workspace-other"]) {
    assert.equal(getStudioNavigationPreferenceKey(preferenceKey, "user", workspaceId), preferenceKey);
  }
  assert.notEqual(getStudioNavigationPreferenceKey(preferenceKey, "user", STUDIO_WORKSPACE_ID), preferenceKey);
});

const enquiries = [
  { id: "real-explicit", hasStudioEnquiry: true, syntheticTest: false },
  { id: "real-unmarked", hasStudioEnquiry: true },
  { id: "accepted-studio-test", hasStudioEnquiry: true, syntheticTest: true },
  { id: "ordinary-business", hasStudioEnquiry: false, syntheticTest: false },
  { id: "ordinary-test", hasStudioEnquiry: false, syntheticTest: true },
  { id: "unclassified-test", syntheticTest: true },
  { id: "legacy-lead" },
];
for (const enquiry of enquiries) Object.freeze(enquiry);
Object.freeze(enquiries);

test("business enquiries include only real Studio submissions, including unmarked records", () => {
  const businessEnquiries = selectStudioWebsiteEnquiries(enquiries);
  assert.deepEqual(businessEnquiries, [enquiries[0], enquiries[1]]);
  assert.deepEqual(selectStudioWebsiteEnquiries(enquiries, false), businessEnquiries);
  assert.equal(businessEnquiries[0], enquiries[0], "selection preserves original records");
  assert.deepEqual(selectStudioWebsiteEnquiries([]), []);
});

test("the separate test view retains only accepted synthetic Studio enquiries", () => {
  const testEnquiries = selectStudioWebsiteEnquiries(enquiries, true);
  assert.deepEqual(testEnquiries, [enquiries[2]]);
  assert.equal(testEnquiries[0], enquiries[2], "selection preserves the accepted test enquiry");
  assert.deepEqual(selectStudioWebsiteEnquiries([], true), []);
});
