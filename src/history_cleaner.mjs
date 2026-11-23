import { computeLeanBodyMass } from "./xiaomi_health.mjs";

const SECONDARY_NUMERIC_FIELDS = [
  "body_fat_pct",
  "muscle_mass_kg",
  "skeletal_muscle_kg",
  "lean_body_mass_kg",
  "heart_rate_bpm",
  "bmi",
  "water_pct",
  "bone_mass_kg",
  "visceral_fat",
  "bmr_kcal",
  "impedance_low",
  "impedance_high",
];

const COVERAGE_FIELDS = [
  "weight_kg",
  "body_fat_pct",
  "muscle_mass_kg",
  "skeletal_muscle_kg",
  "lean_body_mass_kg",
  "heart_rate_bpm",
  "bmi",
  "water_pct",
  "bone_mass_kg",
  "visceral_fat",
  "bmr_kcal",
];

const OPENSCALE_COLUMNS = [
  "dateTime",
  "weight",
  "fat",
  "water",
  "muscle",
  "lbm",
  "bone",
  "visceralFat",
  "calories",
  "comment",
];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function getMemberLabel(rec) {
  return rec?.member_id ? String(rec.member_id) : "(未命名)";
}

/**
 * Groups records by `member_id` and returns summary rows sorted by count descending.
 *
 * @param {Array<Record<string, any>>} records
 */
export function summarizeMembers(records) {
  const groups = new Map();

  for (const rec of records || []) {
    if (!rec) continue;
    const label = getMemberLabel(rec);
    if (!groups.has(label)) {
      groups.set(label, {
        member_id: label,
        count: 0,
        weights: [],
        timestamps: [],
      });
    }
    const g = groups.get(label);
    g.count += 1;
    if (typeof rec.weight_kg === "number" && Number.isFinite(rec.weight_kg) && rec.weight_kg > 0) {
      g.weights.push(rec.weight_kg);
    }
    if (typeof rec.timestamp_sec === "number" && Number.isFinite(rec.timestamp_sec) && rec.timestamp_sec > 0) {
      g.timestamps.push(rec.timestamp_sec);
    }
  }

  const sorted = Array.from(groups.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.member_id.localeCompare(b.member_id);
  });

  return sorted.map((g, idx) => {
    const minW = g.weights.length > 0 ? Math.min(...g.weights) : null;
    const maxW = g.weights.length > 0 ? Math.max(...g.weights) : null;
    const avgW =
      g.weights.length > 0
        ? round2(g.weights.reduce((acc, v) => acc + v, 0) / g.weights.length)
        : null;
    const earliest =
      g.timestamps.length > 0 ? new Date(Math.min(...g.timestamps) * 1000).toISOString() : null;
    const latest =
      g.timestamps.length > 0 ? new Date(Math.max(...g.timestamps) * 1000).toISOString() : null;

    return {
      index: idx + 1,
      member_id: g.member_id,
      count: g.count,
      minWeightKg: minW,
      maxWeightKg: maxW,
      avgWeightKg: avgW,
      earliest,
      latest,
    };
  });
}

/**
 * Cleans one raw normalized history record:
 * - Drops invalid/zero weights or missing timestamps.
 * - Converts 0 / negative / out-of-range secondary metrics into `null`.
 * - Derives `lean_body_mass_kg` from weight & body fat when missing.
 *
 * @param {Record<string, any>} rec
 * @returns {{ cleaned: Record<string, any>, scrubbedFields: string[] } | null}
 */
export function cleanRecord(rec) {
  if (
    !rec ||
    typeof rec.timestamp_sec !== "number" ||
    !Number.isFinite(rec.timestamp_sec) ||
    rec.timestamp_sec <= 0 ||
    typeof rec.weight_kg !== "number" ||
    !Number.isFinite(rec.weight_kg) ||
    rec.weight_kg <= 0
  ) {
    return null;
  }

  const cleaned = {
    ...rec,
    timestamp_iso: rec.timestamp_iso || new Date(rec.timestamp_sec * 1000).toISOString(),
    weight_kg: round2(rec.weight_kg),
  };

  const scrubbedFields = [];

  for (const field of SECONDARY_NUMERIC_FIELDS) {
    const rawVal = cleaned[field];
    if (rawVal === null || rawVal === undefined) {
      cleaned[field] = null;
      continue;
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num) || num <= 0) {
      cleaned[field] = null;
      scrubbedFields.push(field);
    } else {
      cleaned[field] = field === "heart_rate_bpm" || field === "bmr_kcal" ? Math.round(num) : round2(num);
    }
  }

  if (cleaned.body_fat_pct !== null && (cleaned.body_fat_pct <= 0 || cleaned.body_fat_pct >= 100)) {
    cleaned.body_fat_pct = null;
    scrubbedFields.push("body_fat_pct");
  }

  if (cleaned.heart_rate_bpm !== null && (cleaned.heart_rate_bpm < 20 || cleaned.heart_rate_bpm > 260)) {
    cleaned.heart_rate_bpm = null;
    scrubbedFields.push("heart_rate_bpm");
  }

  if (cleaned.lean_body_mass_kg === null && cleaned.body_fat_pct !== null) {
    cleaned.lean_body_mass_kg = computeLeanBodyMass(cleaned.weight_kg, cleaned.body_fat_pct);
  }

  return { cleaned, scrubbedFields };
}

/**
 * Filters records by member and cleans zero/invalid values, returning sorted deduplicated records and stats.
 *
 * @param {Array<Record<string, any>>} records
 * @param {{ memberId?: string | null, memberIndex?: number | null, allMembers?: boolean }} [options]
 */
export function cleanAndFilterRecords(
  records,
  { memberId = null, memberIndex = null, allMembers = false } = {}
) {
  const members = summarizeMembers(records);
  let selectedMember = null;
  let selectedMemberIndex = null;

  if (!allMembers) {
    if (memberIndex !== null && memberIndex !== undefined) {
      const found = members.find((m) => m.index === memberIndex);
      if (!found) {
        throw new Error(
          `Invalid --member-index ${memberIndex}. Available indices: 1..${members.length}`
        );
      }
      selectedMember = found.member_id;
      selectedMemberIndex = found.index;
    } else if (memberId !== null && memberId !== undefined) {
      const found = members.find((m) => m.member_id === memberId);
      if (!found) {
        throw new Error(`Member "${memberId}" not found in records.`);
      }
      selectedMember = found.member_id;
      selectedMemberIndex = found.index;
    } else if (members.length === 1) {
      selectedMember = members[0].member_id;
      selectedMemberIndex = members[0].index;
    } else if (members.length > 1) {
      throw new Error(
        `Multiple members found (${members.length}). Specify --member-index, --member, or --all-members.`
      );
    }
  }

  const memberFiltered = allMembers
    ? records.filter(Boolean)
    : records.filter((r) => r && getMemberLabel(r) === selectedMember);

  const scrubbedCountsByField = {};
  for (const f of SECONDARY_NUMERIC_FIELDS) {
    scrubbedCountsByField[f] = 0;
  }

  let droppedInvalidCount = 0;
  const seen = new Set();
  const cleanedRecords = [];

  for (const rec of memberFiltered) {
    const res = cleanRecord(rec);
    if (!res) {
      droppedInvalidCount += 1;
      continue;
    }
    for (const field of res.scrubbedFields) {
      scrubbedCountsByField[field] = (scrubbedCountsByField[field] || 0) + 1;
    }
    const c = res.cleaned;
    const dedupKey = `${c.timestamp_sec}|${c.weight_kg}|${c.member_id ?? ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    cleanedRecords.push(c);
  }

  cleanedRecords.sort((a, b) => a.timestamp_sec - b.timestamp_sec);

  const fieldCoverage = {};
  for (const f of COVERAGE_FIELDS) {
    fieldCoverage[f] = cleanedRecords.filter(
      (r) => r[f] !== null && r[f] !== undefined
    ).length;
  }

  return {
    selectedMember,
    selectedMemberIndex,
    allMembers,
    records: cleanedRecords,
    stats: {
      inputCount: records.length,
      afterMemberFilterCount: memberFiltered.length,
      cleanedCount: cleanedRecords.length,
      droppedInvalidCount,
      scrubbedCountsByField,
      fieldCoverage,
    },
  };
}

/**
 * Formats a Unix second timestamp into `YYYY-MM-DD HH:MM` in the target UTC offset (default UTC+8).
 *
 * @param {number} tsSec
 * @param {number} [tzOffsetMinutes=480]
 * @returns {string}
 */
export function formatLocalDateTime(tsSec, tzOffsetMinutes = 480) {
  const shifted = new Date((tsSec + tzOffsetMinutes * 60) * 1000);
  const pad2 = (n) => String(n).padStart(2, "0");
  const yyyy = shifted.getUTCFullYear();
  const mm = pad2(shifted.getUTCMonth() + 1);
  const dd = pad2(shifted.getUTCDate());
  const hh = pad2(shifted.getUTCHours());
  const min = pad2(shifted.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function quoteCsvText(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function formatOpenScaleNum(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "0.0";
  }
  return String(Number(value));
}

/**
 * Exports cleaned records to openScale-compatible CSV (without BOM so openScale Android reads headers cleanly).
 * Uses `0.0` for missing numeric fields and quoted headers/dateTime/comment matching native openScale exports.
 *
 * @param {Array<Record<string, any>>} records
 * @param {number} [tzOffsetMinutes=480]
 * @returns {string}
 */
export function recordsToOpenScaleCsv(records, tzOffsetMinutes = 480) {
  const lines = [OPENSCALE_COLUMNS.map(quoteCsvText).join(",")];

  for (const rec of records) {
    const musclePct =
      rec.muscle_mass_kg !== null &&
      rec.muscle_mass_kg !== undefined &&
      rec.weight_kg > 0
        ? round2((rec.muscle_mass_kg / rec.weight_kg) * 100)
        : null;

    const row = [
      quoteCsvText(formatLocalDateTime(rec.timestamp_sec, tzOffsetMinutes)),
      formatOpenScaleNum(rec.weight_kg),
      formatOpenScaleNum(rec.body_fat_pct),
      formatOpenScaleNum(rec.water_pct),
      formatOpenScaleNum(musclePct),
      formatOpenScaleNum(rec.lean_body_mass_kg),
      formatOpenScaleNum(rec.bone_mass_kg),
      formatOpenScaleNum(rec.visceral_fat),
      formatOpenScaleNum(rec.bmr_kcal),
      quoteCsvText(""),
    ];

    lines.push(row.join(","));
  }

  return lines.join("\r\n") + "\r\n";
}

/**
 * Builds clean Health Connect import payload containing only relevant health metrics.
 *
 * @param {Array<Record<string, any>>} records
 */
export function buildHealthConnectPayload(records) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    records: records.map((rec) => ({
      timestamp_iso: rec.timestamp_iso,
      timestamp_sec: rec.timestamp_sec,
      weight_kg: rec.weight_kg,
      body_fat_pct: rec.body_fat_pct ?? null,
      lean_body_mass_kg: rec.lean_body_mass_kg ?? null,
      muscle_mass_kg: rec.muscle_mass_kg ?? null,
      skeletal_muscle_kg: rec.skeletal_muscle_kg ?? null,
      heart_rate_bpm: rec.heart_rate_bpm ?? null,
      bone_mass_kg: rec.bone_mass_kg ?? null,
      water_pct: rec.water_pct ?? null,
      bmr_kcal: rec.bmr_kcal ?? null,
    })),
  };
}

function redactCleanedSample(rec) {
  const copy = { ...rec };
  if ("member_id" in copy) copy.member_id = copy.member_id ? "[REDACTED]" : null;
  if ("source_did" in copy) copy.source_did = copy.source_did ? "[REDACTED]" : null;
  return copy;
}

/**
 * Builds a secret-free summary of the cleaning pass.
 *
 * @param {ReturnType<typeof cleanAndFilterRecords>} result
 */
export function buildCleanedSummary(result) {
  const timestamps = result.records.map((r) => r.timestamp_sec);
  const samples = [];
  if (result.records.length > 0) {
    samples.push(redactCleanedSample(result.records[0]));
  }
  if (result.records.length > 1) {
    samples.push(redactCleanedSample(result.records[result.records.length - 1]));
  }

  return {
    generatedAt: new Date().toISOString(),
    selectedMemberIndex: result.selectedMemberIndex,
    allMembers: result.allMembers,
    stats: result.stats,
    earliest:
      timestamps.length > 0
        ? new Date(Math.min(...timestamps) * 1000).toISOString()
        : null,
    latest:
      timestamps.length > 0
        ? new Date(Math.max(...timestamps) * 1000).toISOString()
        : null,
    samples,
  };
}
