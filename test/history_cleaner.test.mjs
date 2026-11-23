import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCleanedSummary,
  buildHealthConnectPayload,
  cleanAndFilterRecords,
  cleanRecord,
  formatLocalDateTime,
  recordsToOpenScaleCsv,
  summarizeMembers,
} from "../src/history_cleaner.mjs";

const SAMPLE_RECORDS = [
  {
    timestamp_iso: "2026-04-21T01:37:42.000Z",
    timestamp_sec: 1776735462,
    weight_kg: 80.5,
    body_fat_pct: 0,
    muscle_mass_kg: 0,
    skeletal_muscle_kg: 0,
    lean_body_mass_kg: 0,
    heart_rate_bpm: 0,
    bmi: 25.99,
    water_pct: 0,
    bone_mass_kg: 0,
    visceral_fat: 0,
    bmr_kcal: 0,
    impedance_low: 0,
    impedance_high: 0,
    member_id: "UserA",
    source_did: "blt.1.abc",
  },
  {
    timestamp_iso: "2026-11-23T15:16:03.000Z",
    timestamp_sec: 1795446963,
    weight_kg: 85.4,
    body_fat_pct: 25.4,
    muscle_mass_kg: 60.2,
    skeletal_muscle_kg: 34,
    lean_body_mass_kg: null,
    heart_rate_bpm: 107,
    bmi: 27.6,
    water_pct: 54.3,
    bone_mass_kg: 3.5,
    visceral_fat: 10,
    bmr_kcal: 1746,
    impedance_low: 454,
    impedance_high: 402.6,
    member_id: "UserA",
    source_did: "blt.1.abc",
  },
  {
    timestamp_iso: "2026-06-01T00:00:00.000Z",
    timestamp_sec: 1780272000,
    weight_kg: 52.3,
    body_fat_pct: 22.1,
    muscle_mass_kg: 38.4,
    skeletal_muscle_kg: 21.0,
    lean_body_mass_kg: 40.74,
    heart_rate_bpm: 75,
    bmi: 20.1,
    water_pct: 55.0,
    bone_mass_kg: 2.3,
    visceral_fat: 4,
    bmr_kcal: 1210,
    member_id: "UserB",
    source_did: "blt.1.abc",
  },
  {
    timestamp_iso: "2026-07-01T00:00:00.000Z",
    timestamp_sec: 1782864000,
    weight_kg: 0,
    body_fat_pct: 20,
    member_id: "UserA",
    source_did: "blt.1.abc",
  },
];

test("summarizeMembers groups by member_id sorted by count descending with weight range", () => {
  const members = summarizeMembers(SAMPLE_RECORDS);
  assert.equal(members.length, 2);
  assert.equal(members[0].index, 1);
  assert.equal(members[0].member_id, "UserA");
  assert.equal(members[0].count, 3);
  assert.equal(members[0].minWeightKg, 80.5);
  assert.equal(members[0].maxWeightKg, 85.4);
  assert.equal(members[1].index, 2);
  assert.equal(members[1].member_id, "UserB");
  assert.equal(members[1].count, 1);
});

test("cleanRecord drops zero weights, scrubs zero/out-of-range fields, and derives lean mass", () => {
  assert.equal(cleanRecord({ timestamp_sec: 1780000000, weight_kg: 0 }), null);
  assert.equal(cleanRecord({ timestamp_sec: null, weight_kg: 70 }), null);

  const zeroFieldsRes = cleanRecord(SAMPLE_RECORDS[0]);
  assert.ok(zeroFieldsRes);
  assert.equal(zeroFieldsRes.cleaned.weight_kg, 80.5);
  assert.equal(zeroFieldsRes.cleaned.body_fat_pct, null);
  assert.equal(zeroFieldsRes.cleaned.muscle_mass_kg, null);
  assert.equal(zeroFieldsRes.cleaned.lean_body_mass_kg, null);
  assert.equal(zeroFieldsRes.cleaned.heart_rate_bpm, null);
  assert.ok(zeroFieldsRes.scrubbedFields.includes("body_fat_pct"));
  assert.ok(zeroFieldsRes.scrubbedFields.includes("heart_rate_bpm"));

  const outOfRangeRes = cleanRecord({
    timestamp_sec: 1780000000,
    weight_kg: 70,
    body_fat_pct: 105,
    heart_rate_bpm: 10,
  });
  assert.equal(outOfRangeRes.cleaned.body_fat_pct, null);
  assert.equal(outOfRangeRes.cleaned.heart_rate_bpm, null);

  const derivedRes = cleanRecord(SAMPLE_RECORDS[1]);
  assert.equal(derivedRes.cleaned.lean_body_mass_kg, 63.71);
});

test("cleanAndFilterRecords filters by memberIndex and computes accurate scrubbed/coverage stats", () => {
  assert.throws(() => cleanAndFilterRecords(SAMPLE_RECORDS), /Multiple members found/);
  assert.throws(() => cleanAndFilterRecords(SAMPLE_RECORDS, { memberIndex: 99 }), /Invalid --member-index/);

  const res = cleanAndFilterRecords(SAMPLE_RECORDS, { memberIndex: 1 });
  assert.equal(res.selectedMember, "UserA");
  assert.equal(res.records.length, 2);
  assert.equal(res.stats.inputCount, 4);
  assert.equal(res.stats.afterMemberFilterCount, 3);
  assert.equal(res.stats.droppedInvalidCount, 1);
  assert.equal(res.stats.scrubbedCountsByField.body_fat_pct, 1);
  assert.equal(res.stats.scrubbedCountsByField.heart_rate_bpm, 1);
  assert.equal(res.stats.fieldCoverage.weight_kg, 2);
  assert.equal(res.stats.fieldCoverage.body_fat_pct, 1);
  assert.equal(res.stats.fieldCoverage.heart_rate_bpm, 1);
  assert.ok(res.records[0].timestamp_sec < res.records[1].timestamp_sec);
});

test("formatLocalDateTime and recordsToOpenScaleCsv format native openScale quoted CSV with 0.0 fallbacks", () => {
  assert.equal(formatLocalDateTime(1776735462, 480), "2026-04-21 09:37");

  const res = cleanAndFilterRecords(SAMPLE_RECORDS, { memberId: "UserA" });
  const csv = recordsToOpenScaleCsv(res.records);
  const lines = csv.trim().split("\r\n");

  assert.equal(
    lines[0],
    '"dateTime","weight","fat","water","muscle","lbm","bone","visceralFat","calories","comment"'
  );
  assert.equal(
    lines[1],
    '"2026-04-21 09:37",80.5,0.0,0.0,0.0,0.0,0.0,0.0,0.0,""'
  );
  assert.equal(
    lines[2],
    '"2026-11-23 23:16",85.4,25.4,54.3,70.49,63.71,3.5,10,1746,""'
  );
});

test("buildHealthConnectPayload and buildCleanedSummary emit clean redacted structures", () => {
  const res = cleanAndFilterRecords(SAMPLE_RECORDS, { memberIndex: 2 });
  const hc = buildHealthConnectPayload(res.records);
  assert.equal(hc.schemaVersion, 1);
  assert.equal(hc.recordCount, 1);
  assert.equal(hc.records[0].weight_kg, 52.3);
  assert.equal(hc.records[0].heart_rate_bpm, 75);
  assert.equal("member_id" in hc.records[0], false);

  const summary = buildCleanedSummary(res);
  assert.equal(summary.selectedMemberIndex, 2);
  assert.equal(summary.samples[0].member_id, "[REDACTED]");
  assert.equal(summary.samples[0].source_did, "[REDACTED]");
});
