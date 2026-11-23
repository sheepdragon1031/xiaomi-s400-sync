import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_REGIONS, XiaomiCloudClient } from "./src/xiaomi_cloud.mjs";
import {
  buildHistorySummary,
  deduplicateAndSortRecords,
  fetchMiFitnessScaleHistory,
  fetchXiaomiHomeScaleHistory,
  recordsToCsv,
} from "./src/xiaomi_health.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MIHOME_PATH = path.join(__dirname, ".session.json");
const SESSION_HEALTH_PATH = path.join(__dirname, ".session.health.json");
const QR_MIHOME_PATH = path.join(__dirname, "qr.png");
const QR_HEALTH_PATH = path.join(__dirname, "qr_health.png");
const OUTPUT_DIR = path.join(__dirname, "output");
const CREDS_PATH = path.join(OUTPUT_DIR, "s400_credentials.local.json");
const HISTORY_RAW_PATH = path.join(OUTPUT_DIR, "history_raw.local.json");
const HISTORY_JSON_PATH = path.join(OUTPUT_DIR, "history_records.local.json");
const HISTORY_CSV_PATH = path.join(OUTPUT_DIR, "history_records.local.csv");
const HISTORY_SUMMARY_PATH = path.join(OUTPUT_DIR, "history_summary.json");

function printHelp() {
  console.log(`Xiaomi Body Composition Scale S400 - Step 1.5 Cloud History Extractor

Usage:
  node step1_5_history.mjs [options]

Options:
  --region <tw|sg|cn|...>         Target region (default: from s400_credentials.local.json or tw)
  --model <model>                 Scale model (default: from s400_credentials.local.json or yunmai.scales.ms104)
  --source <auto|xiaomihome|mifitness>
                                  Cloud history source (default: auto)
  --reuse-session                 Reuse saved .session.json / .session.health.json
  --help, -h                      Show this help message

Outputs:
  output/history_raw.local.json      Raw API items (gitignored)
  output/history_records.local.json  Normalized records JSON (gitignored)
  output/history_records.local.csv   Normalized records UTF-8 CSV (gitignored)
  output/history_summary.json        Secret-free summary & field coverage
`);
}

function parseArgs(argv) {
  const opts = {
    region: null,
    model: null,
    source: "auto",
    reuseSession: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--reuse-session") {
      opts.reuseSession = true;
    } else if (arg === "--region") {
      opts.region = argv[++i];
      if (!opts.region) throw new Error("--region requires a value");
    } else if (arg.startsWith("--region=")) {
      opts.region = arg.slice("--region=".length);
    } else if (arg === "--model") {
      opts.model = argv[++i];
      if (!opts.model) throw new Error("--model requires a value");
    } else if (arg.startsWith("--model=")) {
      opts.model = arg.slice("--model=".length);
    } else if (arg === "--source") {
      opts.source = argv[++i];
      if (!opts.source) throw new Error("--source requires a value");
    } else if (arg.startsWith("--source=")) {
      opts.source = arg.slice("--source=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["auto", "xiaomihome", "mifitness"].includes(opts.source)) {
    throw new Error(`Invalid --source "${opts.source}". Valid: auto, xiaomihome, mifitness`);
  }
  if (opts.region && !ALL_REGIONS.includes(opts.region)) {
    throw new Error(`Invalid --region "${opts.region}". Valid: ${ALL_REGIONS.join(", ")}`);
  }
  return opts;
}

async function loadLocalCredentials() {
  try {
    const raw = await fs.readFile(CREDS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function authenticateForSid({ sid, sessionPath, qrOutputPath, reuseSession, label }) {
  if (reuseSession) {
    try {
      const client = await XiaomiCloudClient.loadSession(sessionPath);
      console.log(`已載入 ${label} 本地 Session (${path.basename(sessionPath)})。`);
      return client;
    } catch (err) {
      console.log(`無法重用 ${label} Session (${err.message})，改用 QR Code 登入...`);
    }
  }

  const client = new XiaomiCloudClient();
  await client.loginWithQr({
    sid,
    qrOutputPath,
    onQrReady: ({ qrPath, loginUrl, timeoutSec }) => {
      console.log(`\n=== 請使用手機「米家 / 小米運動健康」掃描 QR Code 登入 (${label}) ===`);
      console.log(`QR Code 圖片已儲存並嘗試開啟：${qrPath}`);
      console.log(`若圖片未自動開啟，請手動打開上述圖片，或用瀏覽器開啟登入連結：`);
      console.log(`  ${loginUrl}`);
      console.log(`等待掃描確認中（逾時 ${timeoutSec} 秒）...\n`);
    },
  });

  await client.saveSession(sessionPath);
  console.log(`${label} 登入成功！已儲存 Session 至 ${path.basename(sessionPath)}。`);
  return client;
}

function expandCandidateRegions(primaryRegion) {
  if (primaryRegion === "tw") {
    return ["tw", "sg"];
  }
  return [primaryRegion];
}

async function tryXiaomiHome({ candidateRegions, model, reuseSession, attempts }) {
  const client = await authenticateForSid({
    sid: "xiaomiio",
    sessionPath: SESSION_MIHOME_PATH,
    qrOutputPath: QR_MIHOME_PATH,
    reuseSession,
    label: "米家 (xiaomihome)",
  });

  const allRaw = [];
  const allRecords = [];
  let matchedRegion = null;

  for (const reg of candidateRegions) {
    try {
      console.log(`正在查詢米家健康雲端紀錄 (${reg}, model=${model})...`);
      const res = await fetchXiaomiHomeScaleHistory(client, { region: reg, model });
      attempts.push({
        source: "xiaomihome",
        region: reg,
        ok: true,
        count: res.records.length,
      });
      if (res.records.length > 0) {
        allRaw.push(...res.rawItems);
        allRecords.push(...res.records);
        matchedRegion = matchedRegion || reg;
        break;
      }
    } catch (err) {
      attempts.push({
        source: "xiaomihome",
        region: reg,
        ok: false,
        error: err.message,
      });
      console.warn(`[xiaomihome/${reg}] 查詢失敗：${err.message}`);
    }
  }

  return { rawItems: allRaw, records: allRecords, matchedRegion };
}

async function tryMiFitness({ candidateRegions, reuseSession, attempts }) {
  const client = await authenticateForSid({
    sid: "miothealth",
    sessionPath: SESSION_HEALTH_PATH,
    qrOutputPath: QR_HEALTH_PATH,
    reuseSession,
    label: "小米運動健康 (mifitness)",
  });

  const allRaw = [];
  const allRecords = [];
  let matchedRegion = null;

  for (const reg of candidateRegions) {
    try {
      console.log(`正在查詢 Mi Fitness 雲端體重紀錄 (${reg})...`);
      const res = await fetchMiFitnessScaleHistory(client, { region: reg });
      attempts.push({
        source: "mifitness",
        region: reg,
        ok: true,
        count: res.records.length,
      });
      if (res.records.length > 0) {
        allRaw.push(...res.rawItems);
        allRecords.push(...res.records);
        matchedRegion = matchedRegion || reg;
        break;
      }
    } catch (err) {
      attempts.push({
        source: "mifitness",
        region: reg,
        ok: false,
        error: err.message,
      });
      console.warn(`[mifitness/${reg}] 查詢失敗：${err.message}`);
    }
  }

  return { rawItems: allRaw, records: allRecords, matchedRegion };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const creds = await loadLocalCredentials();
  const region = opts.region || creds?.region || "tw";
  const model = opts.model || creds?.model || "yunmai.scales.ms104";
  const candidateRegions = expandCandidateRegions(region);

  console.log(`目標區域：${region}（候選端點區域：${candidateRegions.join(", ")}）`);
  console.log(`目標型號：${model}`);
  console.log(`資料來源模式：${opts.source}\n`);

  const attempts = [];
  let rawItems = [];
  let collected = [];
  let sourceUsed = null;
  let matchedRegion = region;

  if (opts.source === "auto" || opts.source === "xiaomihome") {
    const res = await tryXiaomiHome({
      candidateRegions,
      model,
      reuseSession: opts.reuseSession,
      attempts,
    });
    if (res.records.length > 0) {
      rawItems = res.rawItems;
      collected = res.records;
      sourceUsed = "xiaomihome";
      matchedRegion = res.matchedRegion || region;
    }
  }

  if (
    collected.length === 0 &&
    (opts.source === "auto" || opts.source === "mifitness")
  ) {
    if (opts.source === "auto") {
      console.log("\n米家端點未查到歷史紀錄，改嘗試 Mi Fitness (hlth.io.mi.com) 端點...");
    }
    const res = await tryMiFitness({
      candidateRegions,
      reuseSession: opts.reuseSession,
      attempts,
    });
    if (res.records.length > 0) {
      rawItems = res.rawItems;
      collected = res.records;
      sourceUsed = "mifitness";
      matchedRegion = res.matchedRegion || region;
    }
  }

  const records = deduplicateAndSortRecords(collected);
  const summary = buildHistorySummary(records, {
    sourceUsed,
    region: matchedRegion,
    model,
    attempts,
  });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    HISTORY_RAW_PATH,
    JSON.stringify({ region: matchedRegion, model, sourceUsed, rawItems }, null, 2),
    "utf8"
  );
  await fs.writeFile(HISTORY_JSON_PATH, JSON.stringify(records, null, 2), "utf8");
  await fs.writeFile(HISTORY_CSV_PATH, recordsToCsv(records), "utf8");
  await fs.writeFile(HISTORY_SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");

  console.log("\n=== Step 1.5 歷史資料擷取完成 ===");
  console.log(`- 命中來源：${sourceUsed || "無資料"} (區域：${matchedRegion})`);
  console.log(`- 去重後總筆數：${summary.totalRecords}`);
  console.log(`- 時間範圍：${summary.earliest || "N/A"} ～ ${summary.latest || "N/A"}`);
  console.log(
    `- 核心四項覆蓋筆數：體重=${summary.fieldCoverage.weight_kg} | 體脂率=${summary.fieldCoverage.body_fat_pct} | 肌肉量=${summary.fieldCoverage.muscle_mass_kg} | 去脂體重=${summary.fieldCoverage.lean_body_mass_kg} | 心率=${summary.fieldCoverage.heart_rate_bpm}`
  );
  console.log(`- 成員數：${summary.distinctMembersCount} | 來源裝置數：${summary.distinctSourcesCount}`);
  console.log(`- 完整紀錄 JSON：${HISTORY_JSON_PATH}`);
  console.log(`- 完整紀錄 CSV ：${HISTORY_CSV_PATH}`);
  console.log(`- 去敏摘要 JSON：${HISTORY_SUMMARY_PATH}`);
  console.log("\n請告訴我已執行完成，讓我檢視 output/history_summary.json 來確認欄位與多成員狀況！");
}

main().catch((err) => {
  console.error(`\n執行失敗：${err.message}`);
  process.exitCode = 1;
});
