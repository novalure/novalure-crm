import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutomationGraph, evaluateAutomationCondition, nextAutomationBusinessTime, previewAutomation, validateAutomationGraph, type AutomationFacts, type AutomationGraph } from "../src/lib/automation/graph";

const facts: AutomationFacts = { phone: null, address: undefined, phase: "Neu", inquiry: "Ich suche eine Wohnung mit Balkon", exposeOpened: null, replied: null, booked: null, proofAccepted: null, searchProfileExists: null, matchScore: null, optedOut: false, personalContact: false };
test("graph rejects cycles, unreachable nodes, missing edges and duplicate ports", () => {
  assert.equal(validateAutomationGraph(createAutomationGraph()).nodes.length, 3);
  const graph = createAutomationGraph();
  assert.throws(() => validateAutomationGraph({ ...graph, edges: [{ from: "start", to: "task", port: "next" }, { from: "task", to: "task", port: "next" }] }), /Kreisverbindungen/);
  assert.throws(() => validateAutomationGraph({ ...graph, nodes: [...graph.nodes, { id: "orphan", type: "stop", title: "Orphan" }] }), /erreichbar/);
  assert.throws(() => validateAutomationGraph({ ...graph, edges: graph.edges.slice(0, 1) }), /Verbindungen/);
  assert.throws(() => validateAutomationGraph({ ...graph, edges: [...graph.edges, graph.edges[0]] }), /Verbindungen/);
  assert.throws(() => validateAutomationGraph({ ...graph, timezone: "Not/Timezone" }), /Zeitzone/);
});
test("tri-state conditions never treat unknown usage as not read", () => {
  assert.equal(evaluateAutomationCondition({ id: "if", title: "Opened", type: "condition", condition: "expose_opened" }, facts), null);
  assert.equal(evaluateAutomationCondition({ id: "if", title: "Address", type: "condition", condition: "missing_address" }, facts), null);
  assert.equal(evaluateAutomationCondition({ id: "if", title: "Phone", type: "condition", condition: "missing_phone" }, facts), true);
  assert.equal(evaluateAutomationCondition({ id: "if", title: "Contains", type: "condition", condition: "inquiry_contains", value: "Terrasse, balkon" }, facts), true);
  assert.equal(evaluateAutomationCondition({ id: "if", title: "Match", type: "condition", condition: "match_at_least", value: "80" }, { ...facts, matchScore: 79.9 }), false);
});
test("business time uses the stored country timezone over the DST weekend", () => {
  assert.equal(nextAutomationBusinessTime(new Date("2026-10-23T18:05:00Z"), { timezone: "Europe/Vienna", businessHours: true }).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(nextAutomationBusinessTime(new Date("2026-10-26T07:10:00Z"), { timezone: "Europe/Dublin", businessHours: true }).toISOString(), "2026-10-26T08:00:00.000Z");
  assert.equal(nextAutomationBusinessTime(new Date("2026-10-26T07:10:00Z"), { timezone: "Europe/Vienna", businessHours: false }).toISOString(), "2026-10-26T07:10:00.000Z");
});
test("preview and graph conditions preserve Yes/No branches and stop rules", () => {
  const graph: AutomationGraph = { ...createAutomationGraph(), businessHours: false, nodes: [{ id: "start", type: "start", title: "Start" }, { id: "if", type: "condition", title: "Phone?", condition: "has_phone" }, { id: "task", type: "task", title: "Call", dueDays: 0 }, { id: "end", type: "stop", title: "End" }], edges: [{ from: "start", to: "if", port: "next" }, { from: "if", to: "task", port: "yes" }, { from: "if", to: "end", port: "no" }, { from: "task", to: "end", port: "next" }] };
  assert.deepEqual(previewAutomation(graph, facts).steps.map((s) => s.nodeId), ["start", "if", "end"]);
  assert.deepEqual(previewAutomation(graph, { ...facts, phone: "123" }).steps.map((s) => s.nodeId), ["start", "if", "task", "end"]);
  assert.equal(previewAutomation(graph, { ...facts, optedOut: true }).stopped, "opt_out");
  assert.equal(previewAutomation(graph, { ...facts, personalContact: true }).stopped, "personal_contact");
});
test("draft preview ends at review instead of claiming a sent email", () => {
  const graph = createAutomationGraph(); graph.businessHours = false;
  graph.nodes[1] = { id: "task", type: "email_draft", title: "Draft", subject: "Hello", body: "Message" };
  const result = previewAutomation(graph, facts);
  assert.equal(result.steps.length, 2); assert.match(result.steps[1].result, /Entwurf/);
});
