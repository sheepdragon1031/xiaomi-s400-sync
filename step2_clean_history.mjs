import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCleanedSummary,
  buildHealthConnectPayload,
  cleanAndFilterRecords,
  recordsToOpenScaleCsv,
  summarizeMembers,
} from "./src/history_cleaner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "output");
const DEFAULT_INPUT_PATH = path.join(OUTPUT_DIR, "history_records.local.json");
const CLEANED_HC_PATH = path.join(OUTPUT_DIR, "cleaned_health_connect.local.json");
const CLEANED_OPENSCALE_PATH = path.join(OUTPUT_DIR, "cleaned_openscale.local.csv");
const CLEANED_SUMMARY_PATH = path.join(OUTPUT_DIR, "cleaned_summary.json");

function printHelp() {
  console.log(`Xiaomi Body Composition Scale S400 - Step 2 Member Filter & Zero-Value Cleaner

Usage:
  node step2_clean_history.mjs [options]

Options:
  --list-members          List discovered household members with index, count & weight range
  --member-index <n>      Select member by 1-based index shown in --list-members
  --member <name>         Select member by exact member_id string
  --all-members           Keep all members (skip member filtering)
  --input <path>          Input records JSON (default: output/history_records.local.json)
  --help, -h              Show this help message

Outputs:
  output/cleaned_health_connect.local.json  Cleaned JSON ready for Health Connect import (gitignored)
  output/cleaned_openscale.local.csv        Cleaned CSV formatted for openScale import (gitignored)
  output/cleaned_summary.json               Secret-free cleaning summary & true non-zero coverage
`);
}

function parseArgs(argv) {
  const opts = {
    listMembers: false,
    member: null,
    memberIndex: null,
    allMembers: false,
    input: DEFAULT_INPUT_PATH,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--list-members") {
      opts.listMembers = true;
    } else if (arg === "--all-members") {
      opts.allMembers = true;
    } else if (arg === "--member") {
      opts.member = argv[++i];
      if (!opts.member) throw new Error("--member requires a value");
    } else if (arg.startsWith("--member=")) {
      opts.member = arg.slice("--member=".length);
    } else if (arg === "--member-index") {
      const val = argv[++i];
      opts.memberIndex = Number(val);
      if (!Number.isInteger(opts.memberIndex) || opts.memberIndex < 1) {
        throw new Error(`Invalid --member-index "${val}". Must be a positive integer.`);
      }
    } else if (arg.startsWith("--member-index=")) {
      const val = arg.slice("--member-index=".length);
      opts.memberIndex = Number(val);
      if (!Number.isInteger(opts.memberIndex) || opts.memberIndex < 1) {
        throw new Error(`Invalid --member-index "${val}". Must be a positive integer.`);
      }
    } else if (arg === "--input") {
      const val = argv[++i];
      if (!val) throw new Error("--input requires a path");
      opts.input = path.resolve(val);
    } else if (arg.startsWith("--input=")) {
      opts.input = path.resolve(arg.slice("--input=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printMemberTable(members) {
  console.log("\n偵測到的家庭成員清單：");
  for (const m of members) {
    const range =
      m.minWeightKg !== null && m.maxWeightKg !== null
        ? `${m.minWeightKg}～${m.maxWeightKg} kg (平均 ${m.avgWeightKg} kg)`
        : "N/A";
    const dates =
      m.earliest && m.latest
        ? `${m.earliest.slice(0, 10)} ～ ${m.latest.slice(0, 10)}`
        : "N/A";
    console.log(
      `  [${m.index}] member="${m.member_id}" | 筆數=${m.count} | 體重範圍=${range} | 日期=${dates}`
    );
  }
  console.log("\n請依你的體重區間挑選對應編號，執行下列指令完成過濾與清洗：");
  for (const m of members) {
    console.log(`  node step2_clean_history.mjs --member-index ${m.index}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  let records;
  try {
    const raw = await fs.readFile(opts.input, "utf8");
    records = JSON.parse(raw);
    if (!Array.isArray(records)) {
      throw new Error("Input JSON root must be an array");
    }
  } catch (err) {
    console.error(`無法讀取歷史紀錄檔 (${opts.input})：${err.message}`);
    console.error("請先執行 node step1_5_history.mjs --reuse-session 撈取歷史紀錄。");
    process.exitCode = 1;
    return;
  }

  const members = summarizeMembers(records);
  if (opts.listMembers) {
    printMemberTable(members);
    return;
  }

  const hasSelection =
    opts.allMembers || opts.member !== null || opts.memberIndex !== null;
  if (members.length > 1 && !hasSelection) {
    console.log(`檔案內共有 ${members.length} 位成員的紀錄，為避免兩人數據混在一起，請先指定目標成員：`);
    printMemberTable(members);
    return;
  }

  const result = cleanAndFilterRecords(records, {
    memberId: opts.member,
    memberIndex: opts.memberIndex,
    allMembers: opts.allMembers,
  });

  const hcPayload = buildHealthConnectPayload(result.records);
  const openScaleCsv = recordsToOpenScaleCsv(result.records);
  const summary = buildCleanedSummary(result);

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(CLEANED_HC_PATH, JSON.stringify(hcPayload, null, 2), "utf8");
  await fs.writeFile(CLEANED_OPENSCALE_PATH, openScaleCsv, "utf8");
  await fs.writeFile(CLEANED_SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");

  const scrubbedTotal = Object.values(result.stats.scrubbedCountsByField).reduce(
    (sum, n) => sum + n,
    0
  );
  const cov = result.stats.fieldCoverage;

  console.log("\n=== Step 2 過濾與 0 值清洗完成 ===");
  console.log(
    `- 篩選對象：${result.allMembers ? "全部成員" : `成員 #${result.selectedMemberIndex} (${result.selectedMember})`}`
  );
  console.log(
    `- 筆數統計：原始 ${result.stats.inputCount} 筆 → 篩選成員後 ${result.stats.afterMemberFilterCount} 筆 → 清洗去重後保留 ${result.stats.cleanedCount} 筆（剔除無效 ${result.stats.droppedInvalidCount} 筆）`
  );
  console.log(`- 已將 ${scrubbedTotal} 個無效 0 值欄位清成空值 (null)，細節如下：`);
  console.log(
    `  體脂率=${result.stats.scrubbedCountsByField.body_fat_pct} | 肌肉量=${result.stats.scrubbedCountsByField.muscle_mass_kg} | 去脂體重=${result.stats.scrubbedCountsByField.lean_body_mass_kg} | 心率=${result.stats.scrubbedCountsByField.heart_rate_bpm}`
  );
  console.log(`- 清洗後「真實非 0」可用筆數：`);
  console.log(
    `  體重=${cov.weight_kg} | 體脂率=${cov.body_fat_pct} | 肌肉量=${cov.muscle_mass_kg} | 去脂體重=${cov.lean_body_mass_kg} | 心率=${cov.heart_rate_bpm}`
  );
  console.log(`- 時間範圍：${summary.earliest || "N/A"} ～ ${summary.latest || "N/A"}`);
  console.log(`\n輸出檔案：`);
  console.log(`- Health Connect 匯入用 JSON：${CLEANED_HC_PATH}`);
  console.log(`- openScale 匯入用 CSV     ：${CLEANED_OPENSCALE_PATH}`);
  console.log(`- 去敏清洗摘要 JSON        ：${CLEANED_SUMMARY_PATH}`);
}

main().catch((err) => {
  console.error(`\n執行失敗：${err.message}`);
  process.exitCode = 1;
});
