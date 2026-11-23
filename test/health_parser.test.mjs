import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistorySummary,
  computeLeanBodyMass,
  deduplicateAndSortRecords,
  parseMiFitnessDataItem,
  parseXiaomiHomeScaleItem,
  recordsToCsv,
} from "../src/xiaomi_health.mjs";

test("parseXiaomiHomeScaleItem parses fromSource=3 S400 nested bodyResData", () => {
  const item = {
    model: "yunmai.scales.ms104",
    did: "blt.1.1opcjvj9l4000",
    accountId: 12345,
    createTime: 1755927448000,
    fromSource: 3,
    data: JSON.stringify({
      time: "1755927448000",
      weight: "69.8",
      bmi: "23.6",
      heartRate: 64,
      bodyRes: "412.5",
      bodyRes2: "381.0",
      user: { name: "Alice, TW" },
      bodyResData: JSON.stringify({
        bfp: "19.6",
        slm: "53.3",
        smm: "24.2",
        ffm: "56.1",
        bwp: "51.0",
        bmc: "2.8",
        vfl: "11",
        bmr: "1582",
      }),
    }),
  };

  const rec = parseXiaomiHomeScaleItem(item);
  assert.ok(rec);
  assert.equal(rec.timestamp_sec, 1755927448);
  assert.equal(rec.timestamp_iso, "2025-08-23T05:37:28.000Z");
  assert.equal(rec.weight_kg, 69.8);
  assert.equal(rec.body_fat_pct, 19.6);
  assert.equal(rec.muscle_mass_kg, 53.3);
  assert.equal(rec.skeletal_muscle_kg, 24.2);
  assert.equal(rec.lean_body_mass_kg, 56.1);
  assert.equal(rec.heart_rate_bpm, 64);
  assert.equal(rec.bmi, 23.6);
  assert.equal(rec.water_pct, 51.0);
  assert.equal(rec.bone_mass_kg, 2.8);
  assert.equal(rec.visceral_fat, 11);
  assert.equal(rec.bmr_kcal, 1582);
  assert.equal(rec.impedance_low, 412.5);
  assert.equal(rec.impedance_high, 381);
  assert.equal(rec.member_id, "Alice, TW");
  assert.equal(rec.source_did, "blt.1.1opcjvj9l4000");
});

test("parseXiaomiHomeScaleItem parses fromSource=1 and derives lean_body_mass_kg when ffm missing", () => {
  const item = {
    did: "blt.1.abc",
    createTime: 1755000000000,
    fromSource: 1,
    data: JSON.stringify({
      weight: 80.0,
      bmi: 24.5,
      bfp: 20.0,
      slm: 60.5,
      smm: 35.1,
      heartRate: 72,
      user: { name: "Bob" },
    }),
  };

  const rec = parseXiaomiHomeScaleItem(item);
  assert.equal(rec.weight_kg, 80);
  assert.equal(rec.body_fat_pct, 20);
  assert.equal(rec.muscle_mass_kg, 60.5);
  assert.equal(rec.lean_body_mass_kg, computeLeanBodyMass(80, 20)); // 64
  assert.equal(rec.heart_rate_bpm, 72);
});

test("parseMiFitnessDataItem parses weight records and ignores other keys", () => {
  assert.equal(parseMiFitnessDataItem({ key: "steps", value: "{}" }), null);

  const item = {
    sid: "blt.3.xyz",
    key: "weight",
    time: 1732550224,
    value: JSON.stringify({
      time: 1732550224,
      weight: 69.8,
      body_fat_rate: 19.6,
      muscle_mass: 53.3,
      skeletal_muscle_mass: 24.2,
      fat_free_body: 56.1,
      bpm: 62,
      bmi: 23.6,
      moisture_rate: 51.0,
      bone_mass: 2.8,
      visceral_fat: 11,
      basal_metabolism: 1582,
    }),
  };

  const rec = parseMiFitnessDataItem(item);
  assert.equal(rec.timestamp_sec, 1732550224);
  assert.equal(rec.weight_kg, 69.8);
  assert.equal(rec.body_fat_pct, 19.6);
  assert.equal(rec.muscle_mass_kg, 53.3);
  assert.equal(rec.lean_body_mass_kg, 56.1);
  assert.equal(rec.heart_rate_bpm, 62);
  assert.equal(rec.source_did, "blt.3.xyz");
});

test("deduplicateAndSortRecords sorts ascending and deduplicates identical records", () => {
  const r1 = { timestamp_sec: 2000, weight_kg: 70, member_id: "A" };
  const r2 = { timestamp_sec: 1000, weight_kg: 71, member_id: "A" };
  const r3 = { timestamp_sec: 2000, weight_kg: 70, member_id: "A" };
  const r4 = { timestamp_sec: 2000, weight_kg: 70, member_id: "B" };

  const res = deduplicateAndSortRecords([r1, r2, r3, r4]);
  assert.equal(res.length, 3);
  assert.deepEqual(
    res.map((r) => `${r.timestamp_sec}:${r.member_id}`),
    ["1000:A", "2000:A", "2000:B"]
  );
});

test("recordsToCsv emits UTF-8 BOM and RFC-4180 escaped rows", () => {
  const csv = recordsToCsv([
    {
      timestamp_iso: "2025-08-23T05:37:28.000Z",
      timestamp_sec: 1755927448,
      weight_kg: 69.8,
      body_fat_pct: 19.6,
      muscle_mass_kg: 53.3,
      skeletal_muscle_kg: 24.2,
      lean_body_mass_kg: 56.1,
      heart_rate_bpm: 64,
      bmi: 23.6,
      water_pct: 51,
      bone_mass_kg: 2.8,
      visceral_fat: 11,
      bmr_kcal: 1582,
      impedance_low: null,
      impedance_high: null,
      member_id: 'Alice, "TW"',
      source_did: "blt.1.abc",
      from_source: "xiaomihome_v3",
    },
  ]);

  assert.ok(csv.startsWith("\uFEFFtimestamp_iso,timestamp_sec,weight_kg"));
  assert.ok(csv.includes('"Alice, ""TW"""'));
});

test("buildHistorySummary redacts member_id/source_did and counts coverage accurately", () => {
  const summary = buildHistorySummary(
    [
      {
        timestamp_sec: 1000,
        weight_kg: 70,
        body_fat_pct: 20,
        muscle_mass_kg: 52,
        skeletal_muscle_kg: 25,
        lean_body_mass_kg: 56,
        heart_rate_bpm: 68,
        member_id: "secret-user",
        source_did: "blt.1.secret",
      },
      {
        timestamp_sec: 2000,
        weight_kg: 69.5,
        body_fat_pct: null,
        muscle_mass_kg: null,
        skeletal_muscle_kg: null,
        lean_body_mass_kg: null,
        heart_rate_bpm: null,
        member_id: "secret-user",
        source_did: "blt.1.secret",
      },
    ],
    { sourceUsed: "xiaomihome", region: "tw", model: "yunmai.scales.ms104", attempts: [] }
  );

  assert.equal(summary.totalRecords, 2);
  assert.equal(summary.fieldCoverage.weight_kg, 2);
  assert.equal(summary.fieldCoverage.body_fat_pct, 1);
  assert.equal(summary.fieldCoverage.muscle_mass_kg, 1);
  assert.equal(summary.fieldCoverage.heart_rate_bpm, 1);
  assert.equal(summary.distinctMembersCount, 1);
  assert.equal(summary.samples.length, 2);
  assert.equal(summary.samples[0].member_id, "[REDACTED]");
  assert.equal(summary.samples[0].source_did, "[REDACTED]");
});
