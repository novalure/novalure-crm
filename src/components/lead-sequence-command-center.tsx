"use client";

import { useState, type ReactNode } from "react";
import type {
  ConsentRecord,
  Contact,
  Conversation,
  Deal,
  Lead,
  LeadSequenceChannel,
  LeadSequenceCondition,
  LeadSequenceDefinition,
  LeadSequenceEvent,
  LeadSequenceOwnerMode,
  LeadSequenceStep,
  LeadSequenceStopRule,
  LeadSequenceTrigger,
  Project,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import {
  getCrmSystemTextLabel,
  getLeadSequenceCommandCenterCopy,
  getLocale,
  type LanguageCode,
} from "@/lib/i18n";

type LeadSequenceCommandCenterProps = {
  consents: ConsentRecord[];
  contacts: Contact[];
  conversations: Conversation[];
  deals: Deal[];
  events: LeadSequenceEvent[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  sequences: LeadSequenceDefinition[];
  tasks: Task[];
  users: WorkspaceUser[];
};

type SimulationStatus = "blocked" | "ready" | "scheduled" | "skipped";
type SequenceEditorTab = "timeline" | "details" | "rules" | "simulator";
type SequenceDefinitionPatch = Partial<
  Pick<
    LeadSequenceDefinition,
    | "audience"
    | "businessHours"
    | "goal"
    | "maxTouchpoints14Days"
    | "minHoursBetweenTouches"
    | "name"
    | "projectId"
    | "status"
    | "trigger"
  >
>;

const sequenceChannels: LeadSequenceChannel[] = ["email", "whatsapp", "task", "call", "teams", "calendar"];
const sequenceTriggers: LeadSequenceTrigger[] = [
  "contact_created",
  "funnel_submitted",
  "document_sent",
  "document_opened",
  "meeting_booked",
  "no_reply",
];
const ownerModes: LeadSequenceOwnerMode[] = ["contact_owner", "project_owner", "team_rotation", "manual"];
const sequenceConditions: LeadSequenceCondition[] = [
  "always",
  "high_score",
  "document_opened",
  "document_not_opened",
  "no_reply",
  "whatsapp_allowed",
  "email_available",
  "meeting_not_booked",
];
const sequenceStopRules: LeadSequenceStopRule[] = [
  "reply_received",
  "meeting_booked",
  "opt_out",
  "bounce",
  "deal_won",
  "deal_lost",
  "manual_pause",
];

const fieldLabelClass = "grid min-w-0 gap-1 text-sm font-semibold text-slate-900";
const inputClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm";
const selectClass = "w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm";
const textareaClass =
  "min-h-24 w-full min-w-0 max-w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2 text-sm";

const sequenceStatusStyles = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-900",
  paused: "border-amber-200 bg-amber-50 text-amber-900",
  draft: "border-stone-200 bg-stone-50 text-stone-700",
} as const;

const channelStyles: Record<LeadSequenceChannel, string> = {
  email: "border-blue-200 bg-blue-50 text-blue-900",
  whatsapp: "border-emerald-200 bg-emerald-50 text-emerald-900",
  task: "border-stone-200 bg-stone-50 text-stone-800",
  call: "border-amber-200 bg-amber-50 text-amber-900",
  teams: "border-violet-200 bg-violet-50 text-violet-900",
  calendar: "border-cyan-200 bg-cyan-50 text-cyan-900",
};

const simulationStatusStyles: Record<SimulationStatus, string> = {
  blocked: "border-rose-200 bg-rose-50 text-rose-900",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
  scheduled: "border-blue-200 bg-blue-50 text-blue-900",
  skipped: "border-stone-200 bg-stone-50 text-stone-700",
};

function sortSteps(steps: LeadSequenceStep[]) {
  return [...steps].sort((a, b) => a.position - b.position);
}

function isCustomerTouch(channel: LeadSequenceChannel) {
  return channel === "email" || channel === "whatsapp" || channel === "calendar";
}

function formatTokenCount(template: string, count: number) {
  return template.replace("{{count}}", String(count));
}

function getContactFirstName(contact: Contact | undefined) {
  return contact?.name.split(" ")[0] ?? "";
}

function getContactOwnerName(lead: Lead | undefined, users: WorkspaceUser[], fallback: string) {
  return users.find((user) => user.id === lead?.assignedToUserId)?.name ?? fallback;
}

function addHours(date: Date, hours: number) {
  const next = new Date(date);
  next.setHours(next.getHours() + Math.max(0, hours));
  return next;
}

function moveStep(steps: LeadSequenceStep[], stepId: string, direction: -1 | 1) {
  const sorted = sortSteps(steps);
  const index = sorted.findIndex((step) => step.id === stepId);
  const targetIndex = index + direction;

  if (index < 0 || targetIndex < 0 || targetIndex >= sorted.length) {
    return steps;
  }

  const next = [...sorted];
  const [item] = next.splice(index, 1);
  next.splice(targetIndex, 0, item);

  return next.map((step, position) => ({ ...step, position: position + 1 }));
}

function reorderStep(steps: LeadSequenceStep[], draggedStepId: string, targetStepId: string) {
  if (draggedStepId === targetStepId) {
    return steps;
  }

  const sorted = sortSteps(steps);
  const draggedIndex = sorted.findIndex((step) => step.id === draggedStepId);
  const targetIndex = sorted.findIndex((step) => step.id === targetStepId);

  if (draggedIndex < 0 || targetIndex < 0) {
    return steps;
  }

  const next = [...sorted];
  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);

  return next.map((step, position) => ({ ...step, position: position + 1 }));
}

function buildSequenceStep(
  sequenceId: string,
  position: number,
  stepId: string,
  text: ReturnType<typeof getLeadSequenceCommandCenterCopy>,
): LeadSequenceStep {
  return {
    action: text.defaults.newStepAction,
    channel: "email",
    conditions: ["always"],
    delayHours: 24,
    delayLabel: text.defaults.newStepDelay,
    id: stepId,
    ownerMode: "contact_owner",
    position,
    sequenceId,
    stopRules: ["reply_received", "meeting_booked", "opt_out", "manual_pause"],
    templateBody: "",
    templateSubject: "",
    title: text.defaults.newStepTitle,
  };
}

function normalizePositions(steps: LeadSequenceStep[]) {
  return sortSteps(steps).map((step, index) => ({ ...step, position: index + 1 }));
}

function buildAvailableStepId(baseId: string, steps: LeadSequenceStep[]) {
  const existingIds = new Set(steps.map((step) => step.id));
  let candidate = baseId;
  let suffix = 2;

  while (existingIds.has(candidate)) {
    candidate = `${baseId}_${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function getSequenceStatusLabel(
  text: ReturnType<typeof getLeadSequenceCommandCenterCopy>,
  status: LeadSequenceDefinition["status"],
) {
  if (status === "active") return text.active;
  if (status === "paused") return text.paused;
  return text.draft;
}

function getSimulationStatusLabel(
  text: ReturnType<typeof getLeadSequenceCommandCenterCopy>,
  status: SimulationStatus,
) {
  if (status === "blocked") return text.blocked;
  if (status === "ready") return text.ready;
  if (status === "skipped") return text.skipped;
  return text.scheduled;
}

function hasWhatsAppAccess(input: {
  consents: ConsentRecord[];
  contact: Contact | undefined;
  conversations: Conversation[];
}) {
  if (!input.contact) return false;

  const hasConsent = input.consents.some(
    (consent) =>
      consent.contactId === input.contact?.id &&
      consent.channel === "WhatsApp" &&
      consent.status === "Opt-in",
  );
  const hasChannelContext = input.conversations.some(
    (conversation) =>
      conversation.contactId === input.contact?.id &&
      conversation.channel === "WhatsApp" &&
      conversation.direction === "inbound",
  );

  return hasConsent || hasChannelContext;
}

function simulateSteps(input: {
  consents: ConsentRecord[];
  contact: Contact | undefined;
  conversations: Conversation[];
  events: LeadSequenceEvent[];
  lead: Lead | undefined;
  sequence: LeadSequenceDefinition | undefined;
  text: ReturnType<typeof getLeadSequenceCommandCenterCopy>;
}) {
  if (!input.sequence || !input.contact) {
    return [];
  }

  const now = new Date();
  const hasEmail = Boolean(input.contact.email);
  const whatsappAllowed = hasWhatsAppAccess(input);
  const contactEvents = input.events.filter((event) => event.contactId === input.contact?.id);
  const hasOpenedDocument = contactEvents.some((event) => event.type === "document_opened");
  const hasMeeting = contactEvents.some((event) => event.type === "meeting_booked");
  const hasReply = contactEvents.some((event) => event.type === "reply_received");
  const hasBounce = contactEvents.some((event) => event.type === "email_bounced");
  const hasOptOut =
    contactEvents.some((event) => event.type === "opt_out") ||
    input.consents.some((consent) => consent.contactId === input.contact?.id && consent.status === "Opt-out");
  const customerTouchTimes: Date[] = [];

  return sortSteps(input.sequence.steps).map((step) => {
    const scheduledAt = addHours(now, step.delayHours);
    const hardStop =
      (hasReply && step.stopRules.includes("reply_received")) ||
      (hasMeeting && step.stopRules.includes("meeting_booked")) ||
      (hasOptOut && step.stopRules.includes("opt_out")) ||
      (hasBounce && step.stopRules.includes("bounce"));

    if (hardStop) {
      return {
        reason: input.text.statusReasons.stopMatched,
        scheduledAt,
        status: "blocked" as const,
        step,
      };
    }

    if (step.conditions.includes("email_available") && !hasEmail) {
      return {
        reason: input.text.statusReasons.missingEmail,
        scheduledAt,
        status: "blocked" as const,
        step,
      };
    }

    if (step.conditions.includes("whatsapp_allowed") && !whatsappAllowed) {
      return {
        reason: input.text.statusReasons.whatsappBlocked,
        scheduledAt,
        status: "blocked" as const,
        step,
      };
    }

    if (step.conditions.includes("high_score") && (input.lead?.score ?? 0) < 75) {
      return {
        reason: input.text.statusReasons.conditionReview,
        scheduledAt,
        status: "skipped" as const,
        step,
      };
    }

    if (step.conditions.includes("document_opened") && !hasOpenedDocument) {
      return {
        reason: input.text.statusReasons.conditionReview,
        scheduledAt,
        status: "skipped" as const,
        step,
      };
    }

    if (step.conditions.includes("document_not_opened") && hasOpenedDocument) {
      return {
        reason: input.text.statusReasons.conditionReview,
        scheduledAt,
        status: "skipped" as const,
        step,
      };
    }

    if (step.conditions.includes("meeting_not_booked") && hasMeeting) {
      return {
        reason: input.text.statusReasons.stopMatched,
        scheduledAt,
        status: "blocked" as const,
        step,
      };
    }

    if (isCustomerTouch(step.channel)) {
      const recentTouches = customerTouchTimes.filter(
        (touchTime) => scheduledAt.getTime() - touchTime.getTime() < 24 * 60 * 60 * 1000,
      );

      if (recentTouches.length >= 1) {
        return {
          reason: input.text.statusReasons.frequencyBlocked,
          scheduledAt,
          status: "blocked" as const,
          step,
        };
      }

      customerTouchTimes.push(scheduledAt);
      return {
        reason: "",
        scheduledAt,
        status: "scheduled" as const,
        step,
      };
    }

    return {
      reason: input.text.statusReasons.internalOnly,
      scheduledAt,
      status: "ready" as const,
      step,
    };
  });
}

function Pill({ children, className }: { children: ReactNode; className: string }) {
  return (
    <span className={`inline-flex w-fit items-center rounded-md border px-2 py-1 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

export function LeadSequenceCommandCenter({
  consents,
  contacts,
  conversations,
  deals,
  events,
  language,
  leads,
  projectLabel,
  projects,
  sequences,
  tasks,
  users,
}: LeadSequenceCommandCenterProps) {
  const text = getLeadSequenceCommandCenterCopy(language);
  const locale = getLocale(language);
  const [sequenceOverrides, setSequenceOverrides] = useState<Record<string, SequenceDefinitionPatch>>({});
  const [stepOverrides, setStepOverrides] = useState<Record<string, LeadSequenceStep[]>>({});
  const [selectedSequenceId, setSelectedSequenceId] = useState(sequences[0]?.id ?? "");
  const [selectedContactId, setSelectedContactId] = useState(contacts[0]?.id ?? "");
  const [selectedStepId, setSelectedStepId] = useState(sequences[0]?.steps[0]?.id ?? "");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<SequenceEditorTab>("timeline");
  const [editorNotice, setEditorNotice] = useState("");
  const [draggedStepId, setDraggedStepId] = useState<string | null>(null);

  const workingSequences = sequences.map((sequence) => ({
    ...sequence,
    ...sequenceOverrides[sequence.id],
    steps: stepOverrides[sequence.id] ?? sequence.steps,
  }));
  const effectiveSequenceId = workingSequences.some((sequence) => sequence.id === selectedSequenceId)
    ? selectedSequenceId
    : workingSequences[0]?.id ?? "";
  const effectiveContactId = contacts.some((contact) => contact.id === selectedContactId)
    ? selectedContactId
    : contacts[0]?.id ?? "";
  const selectedSequence = workingSequences.find((sequence) => sequence.id === effectiveSequenceId);
  const selectedContact = contacts.find((contact) => contact.id === effectiveContactId);
  const selectedLead = leads.find((lead) => lead.contactId === selectedContact?.id);
  const selectedProject = projects.find(
    (project) => project.id === (selectedSequence?.projectId ?? selectedContact?.projectId),
  );
  const selectedDeal = deals.find((deal) => deal.contactId === selectedContact?.id);
  const relatedTasks = tasks.filter((task) => task.contactId === selectedContact?.id && task.status === "open");
  const selectedEvents = events.filter((event) => event.contactId === selectedContact?.id);
  const sortedSteps = sortSteps(selectedSequence?.steps ?? []);
  const selectedStep = sortedSteps.find((step) => step.id === selectedStepId) ?? sortedSteps[0];
  const simulatedSteps = simulateSteps({
    consents,
    contact: selectedContact,
    conversations,
    events,
    lead: selectedLead,
    sequence: selectedSequence,
    text,
  });
  const customerTouches = sortedSteps.filter((step) => isCustomerTouch(step.channel)).length;
  const blockedSteps = simulatedSteps.filter((step) => step.status === "blocked").length;

  const metricItems = [
    {
      label: text.metrics.activeSequences,
      value: workingSequences.filter((sequence) => sequence.status === "active").length,
    },
    { label: text.metrics.plannedSteps, value: sortedSteps.length },
    { label: text.metrics.customerTouches, value: customerTouches },
    { label: text.metrics.blockedSteps, value: blockedSteps },
  ];

  const nextTouchpoint = simulatedSteps.find((step) => step.status === "scheduled" || step.status === "ready");

  function updateSelectedSteps(nextSteps: LeadSequenceStep[]) {
    if (!selectedSequence) return;
    setStepOverrides((current) => ({ ...current, [selectedSequence.id]: normalizePositions(nextSteps) }));
  }

  function selectSequence(sequenceId: string) {
    const sequence = workingSequences.find((item) => item.id === sequenceId);
    setSelectedSequenceId(sequenceId);
    setSelectedStepId(sequence?.steps[0]?.id ?? "");
    setEditorNotice("");
  }

  function updateSelectedSequence(patch: SequenceDefinitionPatch) {
    if (!selectedSequence) return;
    setSequenceOverrides((current) => ({
      ...current,
      [selectedSequence.id]: {
        ...current[selectedSequence.id],
        ...patch,
      },
    }));
  }

  function updateSelectedStep(stepId: string, patch: Partial<LeadSequenceStep>) {
    if (!selectedSequence) return;
    updateSelectedSteps(selectedSequence.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)));
  }

  function addStep() {
    if (!selectedSequence) return;
    const nextPosition = sortedSteps.length + 1;
    const nextStepId = buildAvailableStepId(`${selectedSequence.id}_step_${nextPosition}`, sortedSteps);
    const nextStep = buildSequenceStep(selectedSequence.id, nextPosition, nextStepId, text);
    updateSelectedSteps([...sortedSteps, nextStep]);
    setSelectedStepId(nextStep.id);
    setEditorTab("timeline");
    setEditorNotice(text.stepAddedNotice);
  }

  function duplicateStep(step: LeadSequenceStep) {
    if (!selectedSequence) return;
    const nextSteps = [...sortedSteps];
    const duplicateId = buildAvailableStepId(`${step.id}_copy`, nextSteps);
    const nextStep = {
      ...step,
      id: duplicateId,
      position: step.position + 1,
      title: `${step.title} ${text.copySuffix}`,
    };
    const sourceIndex = nextSteps.findIndex((item) => item.id === step.id);
    nextSteps.splice(sourceIndex + 1, 0, nextStep);
    updateSelectedSteps(nextSteps);
    setSelectedStepId(nextStep.id);
    setEditorNotice(text.stepDuplicatedNotice);
  }

  function removeStep(stepId: string) {
    if (!selectedSequence || selectedSequence.steps.length <= 1) return;
    const nextSteps = selectedSequence.steps.filter((step) => step.id !== stepId);
    updateSelectedSteps(nextSteps);
    setSelectedStepId(nextSteps[0]?.id ?? "");
    setEditorNotice(text.stepRemovedNotice);
  }

  function toggleCondition(step: LeadSequenceStep, condition: LeadSequenceCondition) {
    const current = step.conditions;
    const next: LeadSequenceCondition[] = current.includes(condition)
      ? current.filter((item) => item !== condition)
      : condition === "always"
        ? ["always"]
        : [...current.filter((item) => item !== "always"), condition];

    const conditions: LeadSequenceCondition[] = next.length ? next : ["always"];
    updateSelectedStep(step.id, { conditions });
  }

  function toggleStopRule(step: LeadSequenceStep, rule: LeadSequenceStopRule) {
    const current = step.stopRules;
    const next = current.includes(rule) ? current.filter((item) => item !== rule) : [...current, rule];

    updateSelectedStep(step.id, { stopRules: next.length ? next : ["manual_pause"] });
  }

  function saveSequenceDraft() {
    setEditorNotice(text.savedNotice);
  }

  function handleMoveStep(stepId: string, direction: -1 | 1) {
    if (!selectedSequence) return;
    updateSelectedSteps(moveStep(selectedSequence.steps, stepId, direction));
  }

  function handleDrop(targetStepId: string) {
    if (!selectedSequence || !draggedStepId) return;
    updateSelectedSteps(reorderStep(selectedSequence.steps, draggedStepId, targetStepId));
    setSelectedStepId(draggedStepId);
    setDraggedStepId(null);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-700">{projectLabel}</p>
          <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{text.title}</h3>
          <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">{text.description}</p>
        </div>
        <div className="grid gap-3">
          <button
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!selectedSequence}
            onClick={() => setEditorOpen(true)}
            type="button"
          >
            {text.openEditor}
          </button>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {metricItems.map((item) => (
              <div className="rounded-lg border border-stone-200 bg-white p-3" key={item.label}>
                <p className="text-lg font-semibold text-slate-950">{item.value}</p>
                <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
        <aside className="space-y-3">
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h4 className="text-base font-semibold text-slate-950">{text.templates}</h4>
              <Pill className="border-stone-200 bg-stone-50 text-stone-700">{workingSequences.length}</Pill>
            </div>
            <div className="mt-4 grid gap-2">
              {workingSequences.map((sequence) => (
                <button
                  className={`rounded-lg border p-3 text-left text-sm ${
                    effectiveSequenceId === sequence.id
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                  }`}
                  key={sequence.id}
                  onClick={() => selectSequence(sequence.id)}
                  type="button"
                >
                  <span className="block break-words font-semibold">{sequence.name}</span>
                  <span className={`mt-1 block break-words text-xs ${effectiveSequenceId === sequence.id ? "text-slate-300" : "text-stone-500"}`}>
                    {text.trigger}: {text.triggerLabels[sequence.trigger]}
                  </span>
                  <span className="mt-3 flex flex-wrap items-center gap-2">
                    <Pill className={sequenceStatusStyles[sequence.status]}>
                      {getSequenceStatusLabel(text, sequence.status)}
                    </Pill>
                    <Pill className={channelStyles[sequence.steps[0]?.channel ?? "email"]}>
                      {sequence.steps.length} {text.timeline}
                    </Pill>
                  </span>
                </button>
              ))}
              {!workingSequences.length ? (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noSequences}</p>
              ) : null}
            </div>
          </section>

          {selectedSequence ? (
            <section className="rounded-lg border border-stone-200 bg-white p-4">
              <h4 className="text-base font-semibold text-slate-950">{text.rules}</h4>
              <div className="mt-3 grid gap-2 text-sm">
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold text-slate-950">{text.businessHours}</p>
                  <p className="mt-1 text-stone-600">{selectedSequence.businessHours}</p>
                </div>
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold text-slate-950">{text.frequency}</p>
                  <p className="mt-1 text-stone-600">
                    {formatTokenCount(text.maxTouchpoints, selectedSequence.maxTouchpoints14Days)}
                  </p>
                  <p className="mt-1 text-stone-600">
                    {formatTokenCount(text.minDelay, selectedSequence.minHoursBetweenTouches)}
                  </p>
                </div>
              </div>
            </section>
          ) : null}
        </aside>

        <section className="rounded-lg border border-stone-200 bg-white p-4">
          {selectedSequence ? (
            <>
              <div className="flex flex-col gap-3 border-b border-stone-200 pb-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="break-words text-xl font-semibold text-slate-950">{selectedSequence.name}</h4>
                    <Pill className={sequenceStatusStyles[selectedSequence.status]}>
                      {getSequenceStatusLabel(text, selectedSequence.status)}
                    </Pill>
                  </div>
                  <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">{selectedSequence.goal}</p>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md bg-stone-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.audience}</p>
                    <p className="mt-1 font-semibold text-slate-950">{selectedSequence.audience}</p>
                  </div>
                  <div className="rounded-md bg-stone-50 p-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.trigger}</p>
                    <p className="mt-1 font-semibold text-slate-950">{text.triggerLabels[selectedSequence.trigger]}</p>
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {sortedSteps.map((step, index) => (
                  <article
                    className="rounded-lg border border-stone-200 bg-stone-50 p-4"
                    draggable
                    key={step.id}
                    onDragOver={(event) => event.preventDefault()}
                    onDragStart={() => setDraggedStepId(step.id)}
                    onDrop={() => handleDrop(step.id)}
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill className="border-slate-200 bg-white text-slate-800">{index + 1}</Pill>
                          <Pill className={channelStyles[step.channel]}>
                            {text.channelLabels[step.channel]}
                          </Pill>
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                            {step.delayLabel}
                          </span>
                        </div>
                        <h5 className="mt-3 break-words text-base font-semibold text-slate-950">{step.title}</h5>
                        <p className="mt-1 break-words text-sm text-stone-600">{step.action}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          aria-label={text.moveUp}
                          className="grid h-9 w-9 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={index === 0}
                          onClick={() => handleMoveStep(step.id, -1)}
                          title={text.moveUp}
                          type="button"
                        >
                          ^
                        </button>
                        <button
                          aria-label={text.moveDown}
                          className="grid h-9 w-9 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={index === sortedSteps.length - 1}
                          onClick={() => handleMoveStep(step.id, 1)}
                          title={text.moveDown}
                          type="button"
                        >
                          v
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.owner}</p>
                        <p className="mt-1 break-words text-sm font-semibold text-slate-900">{text.ownerLabels[step.ownerMode]}</p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.conditions}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {step.conditions.map((condition) => (
                            <Pill className="border-stone-200 bg-white text-stone-700" key={condition}>
                              {text.conditionLabels[condition]}
                            </Pill>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.stopRules}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {step.stopRules.slice(0, 3).map((rule) => (
                            <Pill className="border-rose-100 bg-white text-rose-800" key={rule}>
                              {text.stopRuleLabels[rule]}
                            </Pill>
                          ))}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
                {!sortedSteps.length ? (
                  <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noSteps}</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noSequences}</p>
          )}
        </section>

        <aside className="space-y-3">
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.simulator}</h4>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                {text.selectContact}
                <select
                  className="w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                  onChange={(event) => setSelectedContactId(event.target.value)}
                  value={effectiveContactId}
                >
                  {contacts.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.nextTouchpoint}</p>
                {nextTouchpoint ? (
                  <>
                    <p className="mt-2 break-words text-sm font-semibold text-slate-950">{nextTouchpoint.step.title}</p>
                    <p className="mt-1 text-sm text-stone-600">
                      {new Intl.DateTimeFormat(locale, {
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        month: "2-digit",
                      }).format(nextTouchpoint.scheduledAt)}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-stone-600">{text.noContact}</p>
                )}
              </div>
              {selectedContact ? (
                <div className="grid gap-2 text-sm">
                  <p className="rounded-md bg-stone-50 p-3">
                    <span className="font-semibold">{selectedContact.name}</span>
                    {selectedProject ? ` - ${selectedProject.name}` : ""}
                  </p>
                  <p className="rounded-md bg-stone-50 p-3">
                    {selectedLead?.score ?? 0} Score - {selectedLead?.status ?? selectedContact.role}
                  </p>
                  <p className="rounded-md bg-stone-50 p-3">
                    {getContactOwnerName(selectedLead, users, "Novalure")} - {selectedDeal?.stage ?? (selectedLead?.nextAction ? getCrmSystemTextLabel(selectedLead.nextAction, language) : "")}
                  </p>
                  <p className="rounded-md bg-stone-50 p-3">
                    {relatedTasks.length} {text.internalSteps} - {getContactFirstName(selectedContact)}
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.simulationHorizon}</h4>
            <div className="mt-3 space-y-2">
              {simulatedSteps.map((item) => (
                <div className="rounded-md border border-stone-200 p-3 text-sm" key={item.step.id}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 break-words font-semibold text-slate-950">{item.step.title}</p>
                    <Pill className={simulationStatusStyles[item.status]}>
                      {getSimulationStatusLabel(text, item.status)}
                    </Pill>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {text.channelLabels[item.step.channel]} - {item.step.delayLabel}
                  </p>
                  {item.reason ? <p className="mt-2 break-words text-xs text-stone-600">{item.reason}</p> : null}
                </div>
              ))}
              {!simulatedSteps.length ? (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noContact}</p>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.analytics}</h4>
            <div className="mt-3 space-y-2">
              {selectedEvents.length ? (
                selectedEvents.map((event) => (
                  <div className="rounded-md bg-stone-50 p-3 text-sm" key={event.id}>
                    <p className="font-semibold text-slate-950">{event.detail}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      {new Intl.DateTimeFormat(locale, {
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        month: "2-digit",
                      }).format(new Date(event.occurredAt))}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.emptyEvents}</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.complianceTitle}</h4>
            <div className="mt-3 grid gap-2">
              {text.complianceItems.map((item) => (
                <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-700" key={item}>
                  {item}
                </p>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {editorOpen && selectedSequence ? (
        <div aria-label={text.editorTitle} aria-modal="true" className="fixed inset-0 z-50 overflow-hidden bg-slate-950/45 p-2 sm:p-4" role="dialog">
          <div className="mx-auto flex h-[calc(100vh-1rem)] max-w-[1600px] min-w-0 flex-col rounded-lg bg-stone-100 shadow-2xl sm:h-[calc(100vh-2rem)]">
            <div className="flex shrink-0 flex-col gap-3 border-b border-stone-200 bg-white p-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{text.editorEyebrow}</p>
                <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{selectedSequence.name}</h3>
                <p className="mt-1 max-w-4xl break-words text-sm text-stone-600">{text.editorDescription}</p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onClick={addStep} type="button">
                  {text.addStep}
                </button>
                <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={saveSequenceDraft} type="button">
                  {text.save}
                </button>
                <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800" onClick={() => setEditorOpen(false)} type="button">
                  {text.closeEditor}
                </button>
              </div>
            </div>

            <div className="grid min-h-0 min-w-0 flex-1 gap-3 p-3 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_380px]">
              <aside className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto rounded-lg border border-stone-200 bg-white p-4">
                <div>
                  <p className="text-sm font-semibold text-slate-950">{text.templates}</p>
                  <div className="mt-3 grid gap-2">
                    {workingSequences.map((sequence) => (
                      <button
                        className={`min-w-0 rounded-lg border p-3 text-left text-sm ${
                          sequence.id === selectedSequence.id
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                        }`}
                        key={sequence.id}
                        onClick={() => selectSequence(sequence.id)}
                        type="button"
                      >
                        <span className="block break-words font-semibold">{sequence.name}</span>
                        <span className={`mt-1 block break-words text-xs ${sequence.id === selectedSequence.id ? "text-slate-300" : "text-stone-500"}`}>
                          {text.trigger}: {text.triggerLabels[sequence.trigger]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-950">{text.stepNavigator}</p>
                    <Pill className="border-stone-200 bg-stone-50 text-stone-700">{sortedSteps.length}</Pill>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {sortedSteps.map((step, index) => (
                      <button
                        className={`min-w-0 rounded-md border px-3 py-2 text-left text-xs font-semibold ${
                          selectedStep?.id === step.id
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-stone-200 bg-stone-50 text-slate-800 hover:border-slate-400 hover:bg-white"
                        }`}
                        key={step.id}
                        onClick={() => setSelectedStepId(step.id)}
                        type="button"
                      >
                        <span className="block uppercase tracking-[0.1em] opacity-70">
                          {text.step} {index + 1} - {text.channelLabels[step.channel]}
                        </span>
                        <span className="mt-1 block break-words">{step.title}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-950">
                  <p className="text-sm font-semibold">{text.editorRecommendationTitle}</p>
                  <div className="mt-2 grid gap-2 text-xs">
                    {text.editorRecommendations.map((item) => (
                      <p className="break-words" key={item}>{item}</p>
                    ))}
                  </div>
                </div>
              </aside>

              <main className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-4">
                <div className="flex flex-wrap gap-2">
                  {(["timeline", "details", "rules", "simulator"] as const).map((tab) => (
                    <button
                      className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                        editorTab === tab
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-300 bg-white text-slate-800 hover:border-emerald-200 hover:bg-emerald-50"
                      }`}
                      key={tab}
                      onClick={() => setEditorTab(tab)}
                      type="button"
                    >
                      {text.editorTabs[tab]}
                    </button>
                  ))}
                </div>

                {editorNotice ? (
                  <p className="rounded-md border border-emerald-100 bg-emerald-50 p-3 text-sm font-semibold text-emerald-950">{editorNotice}</p>
                ) : null}

                {editorTab === "timeline" ? (
                  <div className="grid min-w-0 gap-3">
                    <div className="rounded-lg border border-stone-200 bg-white p-4">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-950">{text.timelineEditorTitle}</p>
                          <p className="mt-1 break-words text-sm text-stone-600">{text.timelineEditorHint}</p>
                        </div>
                        <Pill className={sequenceStatusStyles[selectedSequence.status]}>{getSequenceStatusLabel(text, selectedSequence.status)}</Pill>
                      </div>
                    </div>

                    <div className="grid min-w-0 gap-3">
                      {sortedSteps.map((step, index) => (
                        <article
                          className={`grid min-w-0 cursor-pointer gap-3 rounded-lg border bg-white p-4 transition md:grid-cols-[44px_minmax(0,1fr)_96px] ${
                            selectedStep?.id === step.id ? "border-slate-950 shadow-sm ring-2 ring-slate-950/10" : "border-stone-200 hover:border-slate-400"
                          }`}
                          draggable
                          key={step.id}
                          onClick={() => setSelectedStepId(step.id)}
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={() => setDraggedStepId(step.id)}
                          onDrop={() => handleDrop(step.id)}
                        >
                          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-stone-200 bg-stone-50 text-sm font-semibold text-slate-900">
                            {index + 1}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Pill className={channelStyles[step.channel]}>{text.channelLabels[step.channel]}</Pill>
                              <span className="break-words text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{step.delayLabel}</span>
                            </div>
                            <h4 className="mt-2 break-words text-base font-semibold text-slate-950">{step.title}</h4>
                            <p className="mt-1 break-words text-sm text-stone-600">{step.action}</p>
                            <div className="mt-3 grid min-w-0 gap-2 lg:grid-cols-3">
                              <p className="min-w-0 rounded-md bg-stone-50 p-2 text-xs font-semibold text-stone-700">
                                {text.owner}: {text.ownerLabels[step.ownerMode]}
                              </p>
                              <p className="min-w-0 rounded-md bg-stone-50 p-2 text-xs font-semibold text-stone-700">
                                {text.conditions}: {step.conditions.length}
                              </p>
                              <p className="min-w-0 rounded-md bg-stone-50 p-2 text-xs font-semibold text-stone-700">
                                {text.stopRules}: {step.stopRules.length}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-1 md:grid md:content-start">
                            <button
                              aria-label={text.moveUp}
                              className="grid h-9 w-9 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={index === 0}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveStep(step.id, -1);
                              }}
                              title={text.moveUp}
                              type="button"
                            >
                              ^
                            </button>
                            <button
                              aria-label={text.moveDown}
                              className="grid h-9 w-9 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={index === sortedSteps.length - 1}
                              onClick={(event) => {
                                event.stopPropagation();
                                handleMoveStep(step.id, 1);
                              }}
                              title={text.moveDown}
                              type="button"
                            >
                              v
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}

                {editorTab === "details" ? (
                  <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                    <label className={fieldLabelClass}>
                      {text.sequenceName}
                      <input className={inputClass} onChange={(event) => updateSelectedSequence({ name: event.target.value })} value={selectedSequence.name} />
                    </label>
                    <label className={fieldLabelClass}>
                      {text.project}
                      <select className={selectClass} onChange={(event) => updateSelectedSequence({ projectId: event.target.value })} value={selectedSequence.projectId ?? ""}>
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>{project.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className={fieldLabelClass}>
                      {text.goal}
                      <textarea className={textareaClass} onChange={(event) => updateSelectedSequence({ goal: event.target.value })} value={selectedSequence.goal} />
                    </label>
                    <label className={fieldLabelClass}>
                      {text.audience}
                      <select className={selectClass} onChange={(event) => updateSelectedSequence({ audience: event.target.value as LeadSequenceDefinition["audience"] })} value={selectedSequence.audience}>
                        {Array.from(new Set(["Alle", ...workingSequences.map((sequence) => sequence.audience)])).map((audience) => (
                          <option key={audience} value={audience}>{audience}</option>
                        ))}
                      </select>
                    </label>
                    <label className={fieldLabelClass}>
                      {text.trigger}
                      <select className={selectClass} onChange={(event) => updateSelectedSequence({ trigger: event.target.value as LeadSequenceTrigger })} value={selectedSequence.trigger}>
                        {sequenceTriggers.map((trigger) => (
                          <option key={trigger} value={trigger}>{text.triggerLabels[trigger]}</option>
                        ))}
                      </select>
                    </label>
                    <label className={fieldLabelClass}>
                      {text.status}
                      <select className={selectClass} onChange={(event) => updateSelectedSequence({ status: event.target.value as LeadSequenceDefinition["status"] })} value={selectedSequence.status}>
                        <option value="active">{text.active}</option>
                        <option value="paused">{text.paused}</option>
                        <option value="draft">{text.draft}</option>
                      </select>
                    </label>
                  </div>
                ) : null}

                {editorTab === "rules" ? (
                  <div className="grid min-w-0 gap-4 xl:grid-cols-2">
                    <section className="rounded-lg border border-stone-200 bg-white p-4">
                      <p className="text-sm font-semibold text-slate-950">{text.frequency}</p>
                      <div className="mt-3 grid min-w-0 gap-3">
                        <label className={fieldLabelClass}>
                          {text.businessHours}
                          <input className={inputClass} onChange={(event) => updateSelectedSequence({ businessHours: event.target.value })} value={selectedSequence.businessHours} />
                        </label>
                        <label className={fieldLabelClass}>
                          {text.maxTouchpointsLabel}
                          <input className={inputClass} min={1} onChange={(event) => updateSelectedSequence({ maxTouchpoints14Days: Number(event.target.value) })} type="number" value={selectedSequence.maxTouchpoints14Days} />
                        </label>
                        <label className={fieldLabelClass}>
                          {text.minDelayLabel}
                          <input className={inputClass} min={1} onChange={(event) => updateSelectedSequence({ minHoursBetweenTouches: Number(event.target.value) })} type="number" value={selectedSequence.minHoursBetweenTouches} />
                        </label>
                      </div>
                    </section>
                    <section className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                      <p className="text-sm font-semibold">{text.complianceTitle}</p>
                      <div className="mt-3 grid gap-2 text-sm">
                        {text.complianceItems.map((item) => (
                          <p className="break-words rounded-md bg-white/70 p-3" key={item}>{item}</p>
                        ))}
                      </div>
                    </section>
                  </div>
                ) : null}

                {editorTab === "simulator" ? (
                  <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                    <section className="rounded-lg border border-stone-200 bg-white p-4">
                      <label className={fieldLabelClass}>
                        {text.selectContact}
                        <select className={selectClass} onChange={(event) => setSelectedContactId(event.target.value)} value={effectiveContactId}>
                          {contacts.map((contact) => (
                            <option key={contact.id} value={contact.id}>{contact.name}</option>
                          ))}
                        </select>
                      </label>
                      <p className="mt-3 break-words rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.simulatorHint}</p>
                    </section>
                    <section className="grid min-w-0 gap-2">
                      {simulatedSteps.map((item) => (
                        <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm" key={item.step.id}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 break-words font-semibold text-slate-950">{item.step.title}</p>
                            <Pill className={simulationStatusStyles[item.status]}>{getSimulationStatusLabel(text, item.status)}</Pill>
                          </div>
                          <p className="mt-1 break-words text-xs text-stone-500">{text.channelLabels[item.step.channel]} - {item.step.delayLabel}</p>
                          {item.reason ? <p className="mt-2 break-words text-xs text-stone-600">{item.reason}</p> : null}
                        </div>
                      ))}
                    </section>
                  </div>
                ) : null}
              </main>

              <aside className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto rounded-lg border border-stone-200 bg-white p-4 lg:col-span-2 xl:col-span-1">
                <p className="text-sm font-semibold text-slate-950">{text.inspector}</p>
                {selectedStep ? (
                  <div className="grid min-w-0 gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill className={channelStyles[selectedStep.channel]}>{text.channelLabels[selectedStep.channel]}</Pill>
                      <Pill className="border-stone-200 bg-stone-50 text-stone-700">{selectedStep.delayLabel}</Pill>
                    </div>
                    <label className={fieldLabelClass}>
                      {text.stepTitle}
                      <input className={inputClass} onChange={(event) => updateSelectedStep(selectedStep.id, { title: event.target.value })} value={selectedStep.title} />
                    </label>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {text.delayLabel}
                        <input className={inputClass} onChange={(event) => updateSelectedStep(selectedStep.id, { delayLabel: event.target.value })} value={selectedStep.delayLabel} />
                      </label>
                      <label className={fieldLabelClass}>
                        {text.delayHours}
                        <input className={inputClass} onChange={(event) => updateSelectedStep(selectedStep.id, { delayHours: Number(event.target.value) })} type="number" value={selectedStep.delayHours} />
                      </label>
                    </div>
                    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                      <label className={fieldLabelClass}>
                        {text.channel}
                        <select className={selectClass} onChange={(event) => updateSelectedStep(selectedStep.id, { channel: event.target.value as LeadSequenceChannel })} value={selectedStep.channel}>
                          {sequenceChannels.map((channel) => (
                            <option key={channel} value={channel}>{text.channelLabels[channel]}</option>
                          ))}
                        </select>
                      </label>
                      <label className={fieldLabelClass}>
                        {text.owner}
                        <select className={selectClass} onChange={(event) => updateSelectedStep(selectedStep.id, { ownerMode: event.target.value as LeadSequenceOwnerMode })} value={selectedStep.ownerMode}>
                          {ownerModes.map((ownerMode) => (
                            <option key={ownerMode} value={ownerMode}>{text.ownerLabels[ownerMode]}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <label className={fieldLabelClass}>
                      {text.action}
                      <textarea className={textareaClass} onChange={(event) => updateSelectedStep(selectedStep.id, { action: event.target.value })} value={selectedStep.action} />
                    </label>
                    <label className={fieldLabelClass}>
                      {text.subject}
                      <input className={inputClass} onChange={(event) => updateSelectedStep(selectedStep.id, { templateSubject: event.target.value })} value={selectedStep.templateSubject ?? ""} />
                    </label>
                    <label className={fieldLabelClass}>
                      {text.message}
                      <textarea className={textareaClass} onChange={(event) => updateSelectedStep(selectedStep.id, { templateBody: event.target.value })} value={selectedStep.templateBody ?? ""} />
                    </label>
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.conditions}</p>
                      <div className="mt-2 grid gap-2">
                        {sequenceConditions.map((condition) => (
                          <label className="flex min-w-0 items-start gap-2 text-sm font-semibold" key={condition}>
                            <input checked={selectedStep.conditions.includes(condition)} className="mt-1 shrink-0" onChange={() => toggleCondition(selectedStep, condition)} type="checkbox" />
                            <span className="min-w-0 break-words">{text.conditionLabels[condition]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.stopRules}</p>
                      <div className="mt-2 grid gap-2">
                        {sequenceStopRules.map((rule) => (
                          <label className="flex min-w-0 items-start gap-2 text-sm font-semibold" key={rule}>
                            <input checked={selectedStep.stopRules.includes(rule)} className="mt-1 shrink-0" onChange={() => toggleStopRule(selectedStep, rule)} type="checkbox" />
                            <span className="min-w-0 break-words">{text.stopRuleLabels[rule]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold" onClick={() => duplicateStep(selectedStep)} type="button">
                        {text.duplicate}
                      </button>
                      <button className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900 disabled:cursor-not-allowed disabled:opacity-40" disabled={sortedSteps.length <= 1} onClick={() => removeStep(selectedStep.id)} type="button">
                        {text.remove}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-600">{text.noSteps}</p>
                )}
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
