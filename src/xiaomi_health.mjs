function toNum(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? round2(n) : null;
}

function toInt(val) {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toEpochSeconds(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function computeLeanBodyMass(weightKg, bodyFatPct) {
  if (
    typeof weightKg !== "number" ||
    typeof bodyFatPct !== "number" ||
    weightKg <= 0 ||
    bodyFatPct <= 0 ||
    bodyFatPct >= 100
  ) {
    return null;
  }
  return round2(weightKg * (1 - bodyFatPct / 100));
}

function buildCanonicalRecord(fields) {
  const tsSec = toEpochSeconds(fields.timestampSec);
  const weightKg = fields.weight_kg ?? null;
  const bodyFatPct = fields.body_fat_pct ?? null;
  const leanMass =
    fields.lean_body_mass_kg ?? computeLeanBodyMass(weightKg, bodyFatPct);

  return {
    timestamp_iso: tsSec ? new Date(tsSec * 1000).toISOString() : null,
    timestamp_sec: tsSec,
    weight_kg: weightKg,
    body_fat_pct: bodyFatPct,
    muscle_mass_kg: fields.muscle_mass_kg ?? null,
    skeletal_muscle_kg: fields.skeletal_muscle_kg ?? null,
    lean_body_mass_kg: leanMass,
    heart_rate_bpm: fields.heart_rate_bpm ?? null,
    bmi: fields.bmi ?? null,
    water_pct: fields.water_pct ?? null,
    bone_mass_kg: fields.bone_mass_kg ?? null,
    visceral_fat: fields.visceral_fat ?? null,
    bmr_kcal: fields.bmr_kcal ?? null,
    impedance_low: fields.impedance_low ?? null,
    impedance_high: fields.impedance_high ?? null,
    source_did: fields.source_did ?? null,
    member_id: fields.member_id ?? null,
    from_source: fields.from_source ?? null,
  };
}

/**
 * Parses one item returned by Xiaomi Home `/eco/common/scale/getUserDataByPage`
 * or `/eco/scale/getData` (supporting fromSource 1, 2, 3).
 *
 * @param {Record<string, any>} item
 * @returns {Record<string, any> | null}
 */
export function parseXiaomiHomeScaleItem(item) {
  if (!item || typeof item.data !== "string") return null;
  const v2 = JSON.parse(item.data);

  if (item.fromSource === 3 || v2.bodyResData !== undefined) {
    const v3 =
      typeof v2.bodyResData === "string" && v2.bodyResData.length > 0
        ? JSON.parse(v2.bodyResData)
        : {};
    const rawTime = v2.time ?? item.createTime;
    const member =
      v2.user?.name ||
      v2.mid ||
      (item.accountId ? String(item.accountId) : null);

    return buildCanonicalRecord({
      timestampSec: rawTime,
      weight_kg: toNum(v2.weight),
      body_fat_pct: toNum(v3.bfp),
      muscle_mass_kg: toNum(v3.slm),
      skeletal_muscle_kg: toNum(v3.smm),
      lean_body_mass_kg: toNum(v3.ffm),
      heart_rate_bpm: toInt(v2.heartRate),
      bmi: toNum(v2.bmi ?? v3.bmi),
      water_pct: toNum(v3.bwp),
      bone_mass_kg: toNum(v3.bmc),
      visceral_fat: toNum(v3.vfl),
      bmr_kcal: toInt(v3.bmr),
      impedance_low: toNum(v2.bodyRes),
      impedance_high: toNum(v2.bodyRes2),
      source_did: item.did || null,
      member_id: member,
      from_source: `xiaomihome_v${item.fromSource ?? 3}`,
    });
  }

  // fromSource 1, 2, or generic fallback
  const member =
    v2.user?.name ||
    v2.user?.deviceId ||
    (item.accountId ? String(item.accountId) : null);

  return buildCanonicalRecord({
    timestampSec: item.createTime ?? v2.time,
    weight_kg: toNum(v2.weight),
    body_fat_pct: toNum(v2.bfp),
    muscle_mass_kg: toNum(v2.slm),
    skeletal_muscle_kg: toNum(v2.smm),
    lean_body_mass_kg: toNum(v2.ffm),
    heart_rate_bpm: toInt(v2.heartRate),
    bmi: toNum(v2.bmi),
    water_pct: toNum(v2.bwp),
    bone_mass_kg: toNum(v2.bmc),
    visceral_fat: toNum(v2.vfl),
    bmr_kcal: toInt(v2.bmr),
    impedance_low: toNum(v2.bodyRes),
    impedance_high: toNum(v2.bodyRes2),
    source_did: item.did || v2.user?.deviceId || null,
    member_id: member,
    from_source: `xiaomihome_v${item.fromSource ?? 0}`,
  });
}

/**
 * Parses one item returned by Mi Fitness `/app/v1/data/get_fitness_data_by_time`.
 *
 * @param {Record<string, any>} item
 * @returns {Record<string, any> | null}
 */
export function parseMiFitnessDataItem(item) {
  if (!item || item.key !== "weight" || typeof item.value !== "string") {
    return null;
  }
  const v2 = JSON.parse(item.value);
  return buildCanonicalRecord({
    timestampSec: v2.time ?? item.time,
    weight_kg: toNum(v2.weight),
    body_fat_pct: toNum(v2.body_fat_rate),
    muscle_mass_kg: toNum(v2.muscle_mass),
    skeletal_muscle_kg: toNum(v2.skeletal_muscle_mass),
    lean_body_mass_kg: toNum(v2.fat_free_body),
    heart_rate_bpm: toInt(v2.bpm),
    bmi: toNum(v2.bmi),
    water_pct: toNum(v2.moisture_rate),
    bone_mass_kg: toNum(v2.bone_mass),
    visceral_fat: toNum(v2.visceral_fat),
    bmr_kcal: toInt(v2.basal_metabolism),
    impedance_low: null,
    impedance_high: null,
    source_did: item.sid || null,
    member_id: null,
    from_source: "mifitness",
  });
}

export function getMiFitnessBaseUrl(region) {
  if (!region || region === "cn") {
    return "https://hlth.io.mi.com";
  }
  return `https://${region}.hlth.io.mi.com`;
}

/**
 * Fetches all Xiaomi Home scale weight history for a model using an authenticated `xiaomiio` session.
 * Mirrors XiaomiClient.GetModelWeights in AlexxIT/SmartScaleConnect.
 *
 * @param {import("./xiaomi_cloud.mjs").XiaomiCloudClient} client
 * @param {{ region: string, model: string, maxPages?: number }} opts
 */
export async function fetchXiaomiHomeScaleHistory(client, { region, model, maxPages = 200 }) {
  const rawItems = [];
  const records = [];
  let beginTime = Date.now();

  for (let page = 0; page < maxPages && beginTime > 0; page++) {
    const isCn = !region || region === "cn";
    const endpoint = isCn
      ? "/eco/scale/getData"
      : "/eco/common/scale/getUserDataByPage";

    const payload = isCn
      ? {
          param: { endTime: 1, beginTime },
          model,
          uid: Number(client.userId),
          did: 0,
        }
      : {
          endTime: 1,
          beginTime,
          model,
          uid: String(client.userId),
          did: 0,
          accountId: 0,
        };

    const res = await client.executeApiCallEncrypted(region, endpoint, payload, {
      extraHeaders: { "MIOT-REQUEST-MODEL": model },
      sendInBody: true,
    });

    if (res?.code !== 0) {
      throw new Error(
        `Xiaomi Home scale history failed (${region}, code=${res?.code}): ${res?.message || "unknown error"}`
      );
    }

    const items = Array.isArray(res?.result) ? res.result : [];
    rawItems.push(...items);

    for (const item of items) {
      const parsed = parseXiaomiHomeScaleItem(item);
      if (parsed && parsed.weight_kg !== null) {
        records.push(parsed);
      }
    }

    if (items.length < 20) {
      break;
    }
    const nextBegin = Number(items[items.length - 1]?.createTime || 0);
    if (!nextBegin || nextBegin >= beginTime) {
      break;
    }
    beginTime = nextBegin;
  }

  return { rawItems, records };
}

/**
 * Fetches all Mi Fitness weight history using an authenticated `miothealth` session.
 * Mirrors XiaomiClient.getAllWeights in AlexxIT/SmartScaleConnect.
 *
 * @param {import("./xiaomi_cloud.mjs").XiaomiCloudClient} client
 * @param {{ region: string, maxPages?: number }} opts
 */
export async function fetchMiFitnessScaleHistory(client, { region, maxPages = 200 }) {
  const baseUrl = getMiFitnessBaseUrl(region);
  const endpoint = "/app/v1/data/get_fitness_data_by_time";
  const endTimeSec = Math.floor(Date.now() / 1000) + 86400;

  const rawItems = [];
  const records = [];
  let nextKey = null;

  for (let page = 0; page < maxPages; page++) {
    const payload = {
      start_time: 1,
      end_time: endTimeSec,
      key: "weight",
    };
    if (nextKey) {
      payload.next_key = nextKey;
    }

    const res = await client.executeApiCallEncrypted(region, endpoint, payload, {
      baseUrl,
      signPath: endpoint,
      sendInBody: true,
    });

    if (res?.code !== 0) {
      throw new Error(
        `Mi Fitness history failed (${region}, code=${res?.code}): ${res?.message || "unknown error"}`
      );
    }

    const dataList = Array.isArray(res?.result?.data_list) ? res.result.data_list : [];
    rawItems.push(...dataList);

    for (const item of dataList) {
      const parsed = parseMiFitnessDataItem(item);
      if (parsed && parsed.weight_kg !== null) {
        records.push(parsed);
      }
    }

    if (!res?.result?.has_more || !res?.result?.next_key) {
      break;
    }
    nextKey = res.result.next_key;
  }

  return { rawItems, records };
}

export function deduplicateAndSortRecords(records) {
  const seen = new Set();
  const unique = [];

  for (const rec of records) {
    if (!rec || rec.weight_kg === null) continue;
    const key = `${rec.timestamp_sec ?? ""}|${rec.weight_kg}|${rec.member_id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rec);
  }

  unique.sort((a, b) => (a.timestamp_sec ?? 0) - (b.timestamp_sec ?? 0));
  return unique;
}

const CSV_COLUMNS = [
  "timestamp_iso",
  "timestamp_sec",
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
  "impedance_low",
  "impedance_high",
  "member_id",
  "source_did",
  "from_source",
];

function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function recordsToCsv(records) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const rec of records) {
    lines.push(CSV_COLUMNS.map((col) => escapeCsvCell(rec[col])).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function redactHistoryRecord(rec) {
  return {
    ...rec,
    member_id: rec.member_id ? "[REDACTED]" : null,
    source_did: rec.source_did ? "[REDACTED]" : null,
  };
}

export function buildHistorySummary(records, { sourceUsed, region, model, attempts = [] }) {
  const coverageFields = [
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

  const fieldCoverage = {};
  for (const field of coverageFields) {
    fieldCoverage[field] = records.filter(
      (r) => r[field] !== null && r[field] !== undefined
    ).length;
  }

  const members = new Set(records.map((r) => r.member_id).filter(Boolean));
  const sources = new Set(records.map((r) => r.source_did).filter(Boolean));
  const timestamps = records.map((r) => r.timestamp_sec).filter((t) => typeof t === "number");

  const samples = [];
  if (records.length > 0) samples.push(redactHistoryRecord(records[0]));
  if (records.length > 1) samples.push(redactHistoryRecord(records[records.length - 1]));

  return {
    generatedAt: new Date().toISOString(),
    sourceUsed,
    region,
    model,
    totalRecords: records.length,
    earliest: timestamps.length > 0 ? new Date(Math.min(...timestamps) * 1000).toISOString() : null,
    latest: timestamps.length > 0 ? new Date(Math.max(...timestamps) * 1000).toISOString() : null,
    fieldCoverage,
    distinctMembersCount: members.size,
    distinctSourcesCount: sources.size,
    attempts,
    samples,
  };
}
