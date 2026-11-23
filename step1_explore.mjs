import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_REGIONS,
  DEFAULT_REGIONS,
  XiaomiCloudClient,
} from "./src/xiaomi_cloud.mjs";
import {
  fetchMiotSpecForModel,
  redactSensitiveFields,
  runDeviceDataProbes,
} from "./src/miot_probe.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, ".session.json");
const QR_PATH = path.join(__dirname, "qr.png");
const OUTPUT_DIR = path.join(__dirname, "output");
const CREDS_PATH = path.join(OUTPUT_DIR, "s400_credentials.local.json");
const RAW_PROBE_PATH = path.join(OUTPUT_DIR, "raw_probe.local.json");
const SUMMARY_PATH = path.join(OUTPUT_DIR, "probe_summary.json");

const SCALE_MODELS = new Set(["yunmai.scales.ms104", "yunmai.scales.ms103"]);

function printHelp() {
  console.log(`Xiaomi Body Composition Scale S400 - Step 1 Explorer

Usage:
  node step1_explore.mjs [options]

Options:
  --region <tw|sg|cn|all|...>  Target Xiaomi Cloud region (default: scans tw, sg, cn)
  --did <did>                  Manually specify the target scale Device ID
  --reuse-session              Reuse saved .session.json instead of QR login
  --help, -h                   Show this help message

Outputs:
  output/s400_credentials.local.json  Local device MAC, token & BLE bindkey (gitignored)
  output/raw_probe.local.json         Full raw API probe payloads (gitignored)
  output/probe_summary.json           Secret-free summary of MIoT spec & cloud history
`);
}

function parseArgs(argv) {
  const opts = {
    region: null,
    did: null,
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
    } else if (arg === "--did") {
      opts.did = argv[++i];
      if (!opts.did) throw new Error("--did requires a value");
    } else if (arg.startsWith("--did=")) {
      opts.did = arg.slice("--did=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function resolveRegions(regionArg) {
  if (!regionArg) return DEFAULT_REGIONS;
  if (regionArg === "all") return ALL_REGIONS;
  if (!ALL_REGIONS.includes(regionArg)) {
    throw new Error(`Invalid region "${regionArg}". Valid: ${ALL_REGIONS.join(", ")}, all`);
  }
  return [regionArg];
}

function isLikelyS400(device) {
  const model = String(device?.model || "").toLowerCase();
  const name = String(device?.name || "").toLowerCase();
  if (SCALE_MODELS.has(model)) return true;
  return (
    model.includes("scale") ||
    name.includes("s400") ||
    name.includes("體脂") ||
    name.includes("体脂")
  );
}

async function authenticate(reuseSession) {
  if (reuseSession) {
    try {
      const client = await XiaomiCloudClient.loadSession(SESSION_PATH);
      console.log("已載入本地 .session.json，略過 QR Code 登入。");
      return client;
    } catch (err) {
      console.log(`無法重用既有 Session (${err.message})，改用 QR Code 登入...`);
    }
  }

  const client = new XiaomiCloudClient();
  await client.loginWithQr({
    qrOutputPath: QR_PATH,
    onQrReady: ({ qrPath, loginUrl, timeoutSec }) => {
      console.log("\n=== 請使用手機「米家 (Xiaomi Home)」App 掃描 QR Code 登入 ===");
      console.log(`QR Code 圖片已儲存並嘗試開啟：${qrPath}`);
      console.log(`若圖片未自動開啟，請手動打開上述圖片，或用瀏覽器開啟登入連結：`);
      console.log(`  ${loginUrl}`);
      console.log(`等待掃描確認中（逾時 ${timeoutSec} 秒）...\n`);
    },
  });

  await client.saveSession(SESSION_PATH);
  console.log("登入成功！已暫存 Session 至 .session.json。");
  return client;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const regions = resolveRegions(opts.region);
  const client = await authenticate(opts.reuseSession);

  console.log(`\n正在搜尋裝置（區域：${regions.join(", ")}）...`);
  const discovered = [];
  for (const region of regions) {
    try {
      const devices = await client.listAllDevicesInRegion(region);
      for (const dev of devices) {
        discovered.push({ region, device: dev });
      }
    } catch (err) {
      console.warn(`[${region}] 讀取裝置清單失敗：${err.message}`);
    }
  }

  if (discovered.length === 0) {
    console.error("在指定區域找不到任何米家裝置，請嘗試加上 --region all。");
    process.exitCode = 1;
    return;
  }

  console.log(`\n共發現 ${discovered.length} 個裝置：`);
  for (const { region, device } of discovered) {
    console.log(
      `  - [${region}] name="${device.name}" | model="${device.model}" | did="${device.did}" | mac="${device.mac || "N/A"}"`
    );
  }

  let targets = [];
  if (opts.did) {
    targets = discovered.filter(({ device }) => device.did === opts.did);
  } else {
    targets = discovered.filter(({ device }) => isLikelyS400(device));
  }

  if (targets.length !== 1) {
    console.error(
      targets.length === 0
        ? "\n未自動比對到 S400 體脂計。"
        : `\n比對到 ${targets.length} 個疑似體脂計裝置，無法自動擇一。`
    );
    console.error("請從上方清單確認正確的 Device ID 後，使用下列指令指定執行：");
    console.error("  node step1_explore.mjs --reuse-session --did <你的DID>");
    process.exitCode = 1;
    return;
  }

  const { region, device } = targets[0];
  console.log(`\n鎖定目標裝置：[${region}] ${device.name} (${device.model}, did=${device.did})`);

  console.log("正在擷取 BLE Bindkey (/v2/device/blt_get_beaconkey)...");
  const beaconRes = await client.getBeaconKey(region, device.did);
  const beaconkey = beaconRes?.result?.beaconkey || null;

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const credentialsPayload = {
    region,
    did: device.did,
    name: device.name,
    model: device.model,
    mac: device.mac || null,
    token: device.token || null,
    beaconkey,
    beaconRawResult: beaconRes?.result || null,
    fetchedAt: new Date().toISOString(),
  };
  await fs.writeFile(CREDS_PATH, JSON.stringify(credentialsPayload, null, 2), "utf8");

  console.log(`正在查詢 MIoT-Spec 規格 (${device.model})...`);
  let specSummary = null;
  try {
    specSummary = await fetchMiotSpecForModel(device.model);
  } catch (err) {
    console.warn(`取得 MIoT-Spec 失敗（將僅使用預設探勘清單）：${err.message}`);
  }

  console.log("正在探勘小米雲端歷史紀錄端點 (/user/get_user_device_data & /miotspec/prop/get)...");
  const probeOutcome = await runDeviceDataProbes(client, region, device.did, specSummary);

  await fs.writeFile(
    RAW_PROBE_PATH,
    JSON.stringify(
      {
        region,
        model: device.model,
        device: redactSensitiveFields(device),
        specSummary,
        ...probeOutcome.raw,
      },
      null,
      2
    ),
    "utf8"
  );

  const summaryPayload = {
    generatedAt: new Date().toISOString(),
    region,
    model: device.model,
    hasMac: Boolean(device.mac),
    hasBeaconKey: Boolean(beaconkey),
    beaconKeyLength: beaconkey ? beaconkey.length : 0,
    miotSpecSummary: specSummary
      ? {
          urn: specSummary.urn,
          description: specSummary.description,
          servicesCount: specSummary.services.length,
          propertiesCount: specSummary.properties.length,
          eventsCount: specSummary.events.length,
          services: specSummary.services,
          properties: specSummary.properties,
          events: specSummary.events,
        }
      : null,
    nonEmptyProbes: probeOutcome.nonEmptyProbes,
    emptyProbesCount: probeOutcome.emptyProbesCount,
    errorCodes: probeOutcome.errorCodes,
  };
  await fs.writeFile(SUMMARY_PATH, JSON.stringify(summaryPayload, null, 2), "utf8");

  console.log("\n=== Step 1 探勘完成 ===");
  console.log(`1. 裝置金鑰與 MAC 已本機儲存（已設 gitignore）：${CREDS_PATH}`);
  console.log(`   - MAC 取得：${device.mac ? "成功" : "無"}`);
  console.log(
    `   - BLE Bindkey 取得：${beaconkey ? `成功 (長度 ${beaconkey.length})` : "失敗/無"}`
  );
  console.log(`2. 雲端歷史資料探勘摘要（不含敏感金鑰）：${SUMMARY_PATH}`);
  console.log(`   - 有回傳資料的端點/欄位數：${probeOutcome.nonEmptyProbes.length}`);
  console.log(`   - 空回應探勘數：${probeOutcome.emptyProbesCount}`);
  console.log("\n接下來請開啟或告訴我已執行完成，讓我檢視 output/probe_summary.json 來分析歷史欄位！");
}

main().catch((err) => {
  console.error(`\n執行失敗：${err.message}`);
  process.exitCode = 1;
});
