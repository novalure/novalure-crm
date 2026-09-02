import {
  BrokerDomainError,
  type ClosingStatus,
  type MatchDecisionStatus,
  type OfferStatus,
  type PaymentStatus,
  type SearchProfileStatus,
  type ViewingStatus,
} from "./contracts";

type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;

export const searchProfileTransitions: TransitionMap<SearchProfileStatus> = Object.freeze({
  draft: ["active", "archived"],
  active: ["paused", "expired", "archived"],
  paused: ["active", "expired", "archived"],
  expired: ["active", "archived"],
  archived: [],
});

export const matchDecisionTransitions: TransitionMap<MatchDecisionStatus> = Object.freeze({
  new: ["shortlisted", "declined", "archived"],
  shortlisted: ["new", "declined", "archived"],
  declined: ["new", "archived"],
  archived: ["new"],
});

export const offerTransitions: TransitionMap<OfferStatus> = Object.freeze({
  draft: ["ready", "withdrawn"],
  ready: ["draft", "withdrawn"],
  withdrawn: [],
});

export const viewingTransitions: TransitionMap<ViewingStatus> = Object.freeze({
  planned: ["confirmed", "completed", "cancelled", "no_show"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
});

export const closingTransitions: TransitionMap<ClosingStatus> = Object.freeze({
  draft: ["reviewed", "cancelled"],
  reviewed: ["draft", "signed", "cancelled"],
  signed: ["invoiced", "reversed"],
  invoiced: ["paid", "reversed"],
  paid: ["reversed"],
  cancelled: [],
  reversed: [],
});

export const paymentTransitions: TransitionMap<PaymentStatus> = Object.freeze({
  unpaid: ["partially_paid", "paid", "overdue"],
  partially_paid: ["paid", "overdue", "refunded"],
  paid: ["refunded"],
  overdue: ["partially_paid", "paid", "refunded"],
  refunded: [],
});

export function assertTransition<State extends string>(
  machine: TransitionMap<State>,
  from: State,
  to: State,
  entity: string,
) {
  if (from === to) return;
  if (!machine[from]?.includes(to)) {
    throw new BrokerDomainError(
      "invalid_transition",
      `${entity} cannot transition from ${from} to ${to}.`,
      409,
      { entity, from, to },
    );
  }
}

export function assertInitialState<State extends string>(
  actual: State,
  expected: State,
  entity: string,
) {
  if (actual !== expected) {
    throw new BrokerDomainError(
      "invalid_initial_status",
      `A new ${entity} must start in ${expected}.`,
      409,
      { actual, entity, expected },
    );
  }
}

export function assertMutableState<State extends string>(
  current: State,
  terminalStates: readonly State[],
  entity: string,
) {
  if (terminalStates.includes(current)) {
    throw new BrokerDomainError(
      "terminal_state",
      `${entity} in ${current} is immutable.`,
      409,
      { current, entity },
    );
  }
}
