import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCrmEntityDeepLink,
  getPageWindow,
  parseCrmEntityDeepLink,
  parseListQueryState,
  serializeListQueryState,
} from "../src/lib/list-query-state.ts";

const options = {
  allowedFilters: ["status", "owner"],
  allowedSorts: ["updatedAt", "name"],
  defaultPageSize: 25,
  defaultSort: "updatedAt",
  maxPageSize: 100,
};

test("list query parsing bounds inputs and ignores unknown filters", () => {
  const state = parseListQueryState(
    "/?workspaceId=w-1&q=%20Villa%20%20Wien%20&page=-4&pageSize=999&sort=unsafe&direction=asc&filter.status=active,paused&filter.unknown=secret",
    options,
  );

  assert.deepEqual(state, {
    direction: "asc",
    filters: { status: ["active", "paused"] },
    page: 1,
    pageSize: 100,
    query: "Villa Wien",
    sort: "updatedAt",
  });
});

test("list query serialization is stable and preserves CRM scope", () => {
  const state = parseListQueryState(
    "/?workspaceId=w-1&projectId=p-1&q=Anna&page=2&pageSize=25&sort=name&direction=asc&filter.status=active",
    options,
  );
  const result = serializeListQueryState("/?workspaceId=w-1&projectId=p-1#contacts", state);

  assert.equal(
    result,
    "/?workspaceId=w-1&projectId=p-1&q=Anna&page=2&pageSize=25&sort=name&direction=asc&filter.status=active#contacts",
  );
});

test("entity deep links preserve explicit workspace and project scope", () => {
  assert.equal(
    buildCrmEntityDeepLink({
      currentUrl: "/?lang=de",
      entityId: "contact:123",
      entityType: "contact",
      projectId: "project-1",
      section: "contacts",
      tab: "timeline",
      workspaceId: "workspace-1",
    }),
    "/?lang=de&workspaceId=workspace-1&projectId=project-1&entity=contact&entityId=contact%3A123&tab=timeline#contacts",
  );

  assert.deepEqual(
    parseCrmEntityDeepLink(
      "/?workspaceId=workspace-1&projectId=project-1&entity=contact&entityId=contact%3A123&tab=timeline#contacts",
    ),
    {
      entityId: "contact:123",
      entityType: "contact",
      projectId: "project-1",
      tab: "timeline",
      workspaceId: "workspace-1",
    },
  );
  assert.equal(parseCrmEntityDeepLink("/?workspaceId=workspace-1&entity=unknown&entityId=x"), null);
});

test("closing deep links survive a full URL reload with exact project scope", () => {
  const url = buildCrmEntityDeepLink({
    currentUrl: "/?lang=de",
    entityId: "11111111-1111-4111-8111-111111111119",
    entityType: "closing",
    projectId: "11111111-1111-4111-8111-111111111118",
    section: "objectsMandates",
    workspaceId: "11111111-1111-4111-8111-111111111117",
  });

  assert.equal(
    url,
    "/?lang=de&workspaceId=11111111-1111-4111-8111-111111111117&projectId=11111111-1111-4111-8111-111111111118&entity=closing&entityId=11111111-1111-4111-8111-111111111119#objectsMandates",
  );
  assert.deepEqual(parseCrmEntityDeepLink(url), {
    entityId: "11111111-1111-4111-8111-111111111119",
    entityType: "closing",
    projectId: "11111111-1111-4111-8111-111111111118",
    tab: null,
    workspaceId: "11111111-1111-4111-8111-111111111117",
  });
});

test("page window never renders an unbounded or impossible page", () => {
  assert.deepEqual(getPageWindow({ page: 99, pageSize: 25, total: 51 }), {
    from: 51,
    hasNext: false,
    hasPrevious: true,
    page: 3,
    pageCount: 3,
    to: 51,
  });
  assert.deepEqual(getPageWindow({ page: 1, pageSize: 25, total: 0 }), {
    from: 0,
    hasNext: false,
    hasPrevious: false,
    page: 1,
    pageCount: 1,
    to: 0,
  });
});
