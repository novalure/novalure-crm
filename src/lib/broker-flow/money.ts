import { BrokerDomainError, asRecord, enumValue, optionalString, requiredString } from "./contracts";

export const allocationTypes = ["percentage", "absolute"] as const;
export const commissionSides = ["buyer", "seller", "referral"] as const;
export const commissionSourceSides = ["buyer", "seller"] as const;

export function parseMinorUnits(value: unknown, field: string, options: { allowZero?: boolean } = {}) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BrokerDomainError(
      "invalid_money",
      `${field} must be supplied as an exact non-negative integer minor-unit value.`,
    );
  }
  const normalized = typeof value === "number" ? String(value) : requiredString(value, field, 32);
  if (!/^(?:0|[1-9][0-9]{0,17})$/u.test(normalized)) {
    throw new BrokerDomainError("invalid_money", `${field} must be a non-negative integer minor-unit string.`);
  }
  const amount = BigInt(normalized);
  if (!options.allowZero && amount === BigInt(0)) {
    throw new BrokerDomainError("invalid_money", `${field} must be greater than zero.`);
  }
  return amount;
}

export function parseBasisPoints(value: unknown, field = "basisPoints") {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BrokerDomainError("invalid_basis_points", `${field} must be an integer between 0 and 10000.`);
  }
  const normalized = typeof value === "number" ? String(value) : requiredString(value, field, 16);
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(normalized)) {
    throw new BrokerDomainError("invalid_basis_points", `${field} must be an integer between 0 and 10000.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new BrokerDomainError("invalid_basis_points", `${field} must be an integer between 0 and 10000.`);
  }
  return parsed;
}

export type CommissionSplitInput = Readonly<{
  allocationType: (typeof allocationTypes)[number];
  amountMinor: bigint | null;
  basisPoints: number | null;
  label: string | null;
  side: (typeof commissionSides)[number];
  sourceSide: (typeof commissionSourceSides)[number];
  userId: string | null;
}>;

export type ValidatedCommissionSplit = CommissionSplitInput & Readonly<{ computedAmountMinor: bigint }>;

export function parseCommissionSplits(value: unknown, parseUserId: (value: unknown, field: string) => string | null) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new BrokerDomainError("invalid_commission_splits", "commissionSplits must contain 1-100 rows.");
  }
  const splits = value.map((entry, index): CommissionSplitInput => {
    const row = asRecord(entry, `commissionSplits[${index}]`);
    const allocationType = enumValue(row.allocationType, "allocationType", allocationTypes);
    const side = enumValue(row.side, "side", commissionSides);
    if (side === "referral" && (row.sourceSide === undefined || row.sourceSide === null || row.sourceSide === "")) {
      throw new BrokerDomainError(
        "commission_source_side_required",
        `commissionSplits[${index}].sourceSide must identify the buyer or seller commission funding the referral.`,
      );
    }
    const sourceSide = enumValue(
      row.sourceSide ?? side,
      `commissionSplits[${index}].sourceSide`,
      commissionSourceSides,
    );
    if (side !== "referral" && sourceSide !== side) {
      throw new BrokerDomainError(
        "commission_source_side_mismatch",
        `A ${side} allocation must be funded by the ${side} commission.`,
      );
    }
    const split = {
      allocationType,
      amountMinor: allocationType === "absolute" ? parseMinorUnits(row.amountMinor, "amountMinor", { allowZero: true }) : null,
      basisPoints: allocationType === "percentage" ? parseBasisPoints(row.basisPoints) : null,
      label: optionalString(row.label, 160),
      side,
      sourceSide,
      userId: parseUserId(row.userId, `commissionSplits[${index}].userId`),
    };
    if (!split.userId && !split.label) {
      throw new BrokerDomainError(
        "commission_recipient_required",
        `commissionSplits[${index}] requires a userId or label.`,
      );
    }
    return split;
  });
  const recipientKeys = splits.map((split) =>
    `${split.sourceSide}:${split.side}:${split.userId ?? `label:${split.label?.toLowerCase()}`}`,
  );
  if (new Set(recipientKeys).size !== recipientKeys.length) {
    throw new BrokerDomainError(
      "duplicate_commission_recipient",
      "A commission recipient may only occur once per side.",
    );
  }
  return splits;
}

export function validateCommissionSplits(
  totals: Readonly<{ buyerCommissionMinor: bigint; sellerCommissionMinor: bigint }>,
  splits: readonly CommissionSplitInput[],
) {
  if (totals.buyerCommissionMinor < BigInt(0) || totals.sellerCommissionMinor < BigInt(0)) {
    throw new BrokerDomainError("invalid_commission_total", "Commission totals cannot be negative.");
  }

  const validated = new Map<number, ValidatedCommissionSplit>();
  for (const sourceSide of commissionSourceSides) {
    const totalMinor = sourceSide === "buyer" ? totals.buyerCommissionMinor : totals.sellerCommissionMinor;
    const sideRows = splits
      .map((split, index) => ({ index, split }))
      .filter((row) => row.split.sourceSide === sourceSide);
    if (totalMinor === BigInt(0) && sideRows.length === 0) continue;
    if (totalMinor > BigInt(0) && sideRows.length === 0) {
      throw new BrokerDomainError(
        "commission_side_missing",
        `${sourceSide} commission requires at least one allocation.`,
        400,
        { sourceSide, totalMinor: totalMinor.toString() },
      );
    }

    const allocationType = sideRows[0]?.split.allocationType;
    if (!allocationType || sideRows.some((row) => row.split.allocationType !== allocationType)) {
      throw new BrokerDomainError(
        "mixed_allocation_types",
        `Use either percentage or absolute allocations within the ${sourceSide} source side.`,
      );
    }

    if (allocationType === "absolute") {
      const sum = sideRows.reduce((current, row) => current + (row.split.amountMinor ?? BigInt(0)), BigInt(0));
      if (sum !== totalMinor) {
        throw new BrokerDomainError(
          "commission_sum_mismatch",
          `Absolute ${sourceSide} allocations must equal the ${sourceSide} commission exactly.`,
          400,
          { allocatedMinor: sum.toString(), sourceSide, totalMinor: totalMinor.toString() },
        );
      }
      for (const row of sideRows) {
        validated.set(row.index, { ...row.split, computedAmountMinor: row.split.amountMinor ?? BigInt(0) });
      }
      continue;
    }

    const basisPointTotal = sideRows.reduce((current, row) => current + (row.split.basisPoints ?? 0), 0);
    if (basisPointTotal !== 10_000) {
      throw new BrokerDomainError(
        "commission_basis_points_mismatch",
        `Percentage ${sourceSide} allocations must equal exactly 10000 basis points.`,
        400,
        { basisPointTotal, sourceSide },
      );
    }

    const preliminary = sideRows.map((row) => {
      const numerator = totalMinor * BigInt(row.split.basisPoints ?? 0);
      return {
        amount: numerator / BigInt(10_000),
        index: row.index,
        remainder: numerator % BigInt(10_000),
        split: row.split,
      };
    });
    let undistributed = totalMinor - preliminary.reduce((sum, row) => sum + row.amount, BigInt(0));
    const remainderOrder = [...preliminary].sort((left, right) => {
      if (left.remainder === right.remainder) return left.index - right.index;
      return left.remainder > right.remainder ? -1 : 1;
    });
    for (const row of remainderOrder) {
      if (undistributed <= BigInt(0)) break;
      row.amount += BigInt(1);
      undistributed -= BigInt(1);
    }
    for (const row of preliminary) {
      validated.set(row.index, { ...row.split, computedAmountMinor: row.amount });
    }
  }

  return splits.map((_split, index) => {
    const row = validated.get(index);
    if (!row) {
      throw new BrokerDomainError("invalid_commission_split", "Commission split could not be reconciled.");
    }
    return row;
  });
}

export function validateClosingMoney(input: {
  baseAmountMinor: bigint;
  buyerCommissionMinor: bigint;
  grossCommissionMinor: bigint;
  netCommissionMinor: bigint;
  sellerCommissionMinor: bigint;
  taxMinor: bigint;
}) {
  if (input.grossCommissionMinor > input.baseAmountMinor) {
    throw new BrokerDomainError(
      "commission_exceeds_base",
      "Gross commission cannot exceed the closing base amount.",
      400,
      { baseAmountMinor: input.baseAmountMinor.toString(), grossCommissionMinor: input.grossCommissionMinor.toString() },
    );
  }
  if (input.netCommissionMinor + input.taxMinor !== input.grossCommissionMinor) {
    throw new BrokerDomainError(
      "gross_commission_mismatch",
      "Net commission plus tax must equal gross commission exactly.",
    );
  }
  if (input.buyerCommissionMinor + input.sellerCommissionMinor !== input.grossCommissionMinor) {
    throw new BrokerDomainError(
      "commission_side_mismatch",
      "Buyer and seller commission must equal gross commission exactly.",
    );
  }
}
