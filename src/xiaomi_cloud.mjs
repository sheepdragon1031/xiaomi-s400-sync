import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  decryptRc4,
  generateEncParams,
  generateNonce,
  signedNonce,
} from "./xiaomi_crypto.mjs";

export const DEFAULT_REGIONS = ["tw", "sg", "cn"];
export const ALL_REGIONS = ["tw", "sg", "cn", "de", "us", "ru", "in", "i2"];

function randomChars(len, minCode, maxCode) {
  let out = "";
  for (let i = 0; i < len; i++) {
    const code = minCode + Math.floor(Math.random() * (maxCode - minCode + 1));
    out += String.fromCharCode(code);
  }
  return out;
}

export function generateAgent() {
  const agentId = randomChars(13, 65, 69); // A-E
  const randomText = randomChars(18, 97, 122); // a-z
  return `${randomText}-${agentId} APP/com.xiaomi.mihome APPV/10.5.201`;
}

export function parseXiaomiJson(text) {
  const cleaned = text.startsWith("&&&START&&&")
    ? text.slice("&&&START&&&".length)
    : text.replace("&&&START&&&", "");
  return JSON.parse(cleaned);
}

function parseSetCookies(headers, cookieMap) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];
  for (const raw of setCookies) {
    const firstPart = raw.split(";")[0];
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx > 0) {
      const name = firstPart.slice(0, eqIdx).trim();
      const val = firstPart.slice(eqIdx + 1).trim();
      cookieMap.set(name, val);
    }
  }
}

function formatCookieHeader(cookieMap) {
  return Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function tryOpenFileOnWindows(filePath) {
  if (process.platform !== "win32") return;
  try {
    execFile("cmd.exe", ["/c", "start", "", filePath], { windowsHide: true }, () => {});
  } catch {
    // Non-fatal: user can open qr.png manually.
  }
}

export class XiaomiCloudClient {
  constructor(session = null) {
    this.agent = session?.agent || generateAgent();
    this.sid = session?.sid || "xiaomiio";
    this.userId = session?.userId || null;
    this.cUserId = session?.cUserId || null;
    this.ssecurity = session?.ssecurity || null;
    this.serviceToken = session?.serviceToken || null;
  }

  hasValidSession() {
    return Boolean(this.userId && this.ssecurity && this.serviceToken);
  }

  toSessionObject() {
    return {
      agent: this.agent,
      sid: this.sid,
      userId: this.userId,
      cUserId: this.cUserId,
      ssecurity: this.ssecurity,
      serviceToken: this.serviceToken,
      savedAt: new Date().toISOString(),
    };
  }

  static async loadSession(sessionPath) {
    const raw = await fs.readFile(sessionPath, "utf8");
    const data = JSON.parse(raw);
    const client = new XiaomiCloudClient(data);
    if (!client.hasValidSession()) {
      throw new Error("Session file is incomplete");
    }
    return client;
  }

  async saveSession(sessionPath) {
    await fs.mkdir(path.dirname(sessionPath), { recursive: true });
    await fs.writeFile(sessionPath, JSON.stringify(this.toSessionObject(), null, 2), "utf8");
  }

  /**
   * Authenticates via Xiaomi Account QR code long-polling flow.
   * Matches QrCodeXiaomiCloudConnector in token_extractor.py and supports custom `sid` (e.g., `miothealth`).
   *
   * @param {{
   *   qrOutputPath: string,
   *   sid?: string,
   *   callback?: string,
   *   qs?: string,
   *   onQrReady?: (info: { qrPath: string, loginUrl: string, timeoutSec: number, sid: string }) => void
   * }} options
   */
  async loginWithQr({ qrOutputPath, sid = "xiaomiio", callback = null, qs = null, onQrReady }) {
    this.sid = sid;
    let resolvedCallback = callback;
    let resolvedQs = qs;

    if (!resolvedCallback || !resolvedQs) {
      if (sid === "xiaomiio") {
        resolvedCallback = resolvedCallback || "https://sts.api.io.mi.com/sts";
        resolvedQs = resolvedQs || "%3Fsid%3Dxiaomiio%26_json%3Dtrue";
      } else {
        const initRes = await fetch(
          `https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=${encodeURIComponent(sid)}`,
          { headers: { "User-Agent": this.agent } }
        );
        if (!initRes.ok) {
          throw new Error(`ServiceLogin init failed for sid=${sid}: HTTP ${initRes.status}`);
        }
        const initData = parseXiaomiJson(await initRes.text());
        resolvedCallback = resolvedCallback || initData.callback;
        resolvedQs = resolvedQs || initData.qs;
      }
    }

    const step1Params = new URLSearchParams({
      _qrsize: "480",
      qs: resolvedQs,
      callback: resolvedCallback,
      _hasLogo: "false",
      sid,
      serviceParam: "",
      _locale: "en_GB",
      _dc: String(Date.now()),
    });

    const step1Res = await fetch(
      `https://account.xiaomi.com/longPolling/loginUrl?${step1Params.toString()}`,
      {
        headers: { "User-Agent": this.agent },
      }
    );
    if (!step1Res.ok) {
      throw new Error(`QR login step 1 failed with HTTP ${step1Res.status}`);
    }

    const step1Data = parseXiaomiJson(await step1Res.text());
    if (!step1Data.qr || !step1Data.lp) {
      throw new Error(`QR login step 1 missing qr/lp fields: ${JSON.stringify(step1Data)}`);
    }

    const qrRes = await fetch(step1Data.qr, {
      headers: { "User-Agent": this.agent },
    });
    if (!qrRes.ok) {
      throw new Error(`Failed to download QR image: HTTP ${qrRes.status}`);
    }
    const qrBytes = Buffer.from(await qrRes.arrayBuffer());
    await fs.mkdir(path.dirname(qrOutputPath), { recursive: true });
    await fs.writeFile(qrOutputPath, qrBytes);
    tryOpenFileOnWindows(qrOutputPath);

    const timeoutSec = Number(step1Data.timeout) || 300;
    if (onQrReady) {
      onQrReady({
        qrPath: qrOutputPath,
        loginUrl: step1Data.loginUrl || step1Data.qr,
        timeoutSec,
        sid,
      });
    }

    const startedAt = Date.now();
    let lpData = null;

    while (Date.now() - startedAt < timeoutSec * 1000) {
      try {
        const lpRes = await fetch(step1Data.lp, {
          headers: { "User-Agent": this.agent },
          signal: AbortSignal.timeout(15000),
        });
        if (lpRes.status === 200) {
          lpData = parseXiaomiJson(await lpRes.text());
          break;
        }
      } catch (err) {
        if (err?.name !== "TimeoutError" && err?.name !== "AbortError") {
          throw new Error(`QR long-polling request failed: ${err.message}`);
        }
      }
    }

    if (!lpData) {
      throw new Error(`QR login timed out after ${timeoutSec} seconds`);
    }
    if (!lpData.location || !lpData.ssecurity || !lpData.userId) {
      throw new Error("QR long-polling response missing required auth fields");
    }

    this.userId = lpData.userId;
    this.cUserId = lpData.cUserId || null;
    this.ssecurity = lpData.ssecurity;

    // Step 4: Follow location redirects manually to capture Set-Cookie serviceToken.
    const cookieJar = new Map();
    let nextUrl = lpData.location;
    let finalOk = false;

    for (let hop = 0; hop < 8; hop++) {
      const headers = {
        "User-Agent": this.agent,
        "content-type": "application/x-www-form-urlencoded",
      };
      if (cookieJar.size > 0) {
        headers.Cookie = formatCookieHeader(cookieJar);
      }

      const stsRes = await fetch(nextUrl, {
        headers,
        redirect: "manual",
      });
      parseSetCookies(stsRes.headers, cookieJar);

      if (stsRes.status >= 300 && stsRes.status < 400) {
        const loc = stsRes.headers.get("location");
        if (!loc) break;
        nextUrl = new URL(loc, nextUrl).toString();
        continue;
      }

      if (stsRes.status === 200) {
        finalOk = true;
      }
      break;
    }

    const serviceToken = cookieJar.get("serviceToken");
    if (!finalOk || !serviceToken) {
      throw new Error("Failed to extract serviceToken from STS redirect response");
    }
    this.serviceToken = serviceToken;
  }

  static getApiUrl(region) {
    return `https://${region === "cn" ? "" : `${region}.`}api.io.mi.com/app`;
  }

  async executeApiCallEncrypted(region, endpointPath, dataPayload, options = {}) {
    if (!this.hasValidSession()) {
      throw new Error("Not authenticated with Xiaomi Cloud");
    }

    const baseUrl = options.baseUrl || XiaomiCloudClient.getApiUrl(region);
    const url = baseUrl + endpointPath;
    const params = {
      data: typeof dataPayload === "string" ? dataPayload : JSON.stringify(dataPayload),
    };

    const nonce = generateNonce();
    const sNonce = signedNonce(this.ssecurity, nonce);
    const fields = generateEncParams(
      url,
      "POST",
      sNonce,
      nonce,
      params,
      this.ssecurity,
      options.signPath ?? null
    );

    const headers = {
      "Accept-Encoding": "identity",
      "User-Agent": this.agent,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-xiaomi-protocal-flag-cli": "PROTOCAL-HTTP2",
      "MIOT-ENCRYPT-ALGORITHM": "ENCRYPT-RC4",
      Cookie: [
        `userId=${this.userId}`,
        `yetAnotherServiceToken=${this.serviceToken}`,
        `serviceToken=${this.serviceToken}`,
        "locale=zh_TW",
        "timezone=GMT+08:00",
        "is_daylight=0",
        "dst_offset=0",
        "channel=MI_APP_STORE",
      ].join("; "),
      ...(options.extraHeaders || {}),
    };

    const encodedFields = new URLSearchParams(fields).toString();
    const requestUrl = options.sendInBody ? url : `${url}?${encodedFields}`;
    const fetchOpts = options.sendInBody
      ? { method: "POST", headers, body: encodedFields }
      : { method: "POST", headers };

    const response = await fetch(requestUrl, fetchOpts);

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Xiaomi Cloud auth rejected (${response.status}). Session may be expired; re-run without --reuse-session.`
      );
    }
    if (!response.ok) {
      throw new Error(`Xiaomi Cloud HTTP ${response.status} on ${endpointPath} (${region})`);
    }

    const encryptedText = await response.text();
    const respKey = signedNonce(this.ssecurity, fields._nonce);
    let decryptedBuf = decryptRc4(respKey, encryptedText);

    if (decryptedBuf.length >= 2 && decryptedBuf[0] === 0x1f && decryptedBuf[1] === 0x8b) {
      decryptedBuf = zlib.gunzipSync(decryptedBuf);
    }

    return JSON.parse(decryptedBuf.toString("utf8"));
  }

  async getHomes(region) {
    return this.executeApiCallEncrypted(region, "/v2/homeroom/gethome", {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      limit: 300,
      app_ver: 7,
    });
  }

  async getDevCnt(region) {
    return this.executeApiCallEncrypted(region, "/v2/user/get_device_cnt", {
      fetch_own: true,
      fetch_share: true,
    });
  }

  async getHomeDevices(region, homeId, ownerId) {
    return this.executeApiCallEncrypted(region, "/v2/home/home_device_list", {
      home_owner: ownerId,
      home_id: homeId,
      limit: 200,
      get_split_device: true,
      support_smart_home: true,
    });
  }

  async getDeviceListPage(region, startDid = null) {
    const payload = {
      getVirtualModel: false,
      getHuamiDevices: 1,
      get_split_device: true,
      support_smart_home: true,
      limit: 200,
    };
    if (startDid) {
      payload.start_did = startDid;
    }
    return this.executeApiCallEncrypted(region, "/v2/home/device_list_page", payload);
  }

  /**
   * Discovers all unique devices in a region across home_device_list and device_list_page.
   * @param {string} region
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listAllDevicesInRegion(region) {
    const byDid = new Map();

    const homesRes = await this.getHomes(region);
    const homes = [];
    for (const h of homesRes?.result?.homelist || []) {
      homes.push({ homeId: h.id, ownerId: this.userId });
    }

    const cntRes = await this.getDevCnt(region);
    for (const h of cntRes?.result?.share?.share_family || []) {
      homes.push({ homeId: h.home_id, ownerId: h.home_owner });
    }

    for (const home of homes) {
      const devRes = await this.getHomeDevices(region, home.homeId, home.ownerId);
      for (const dev of devRes?.result?.device_info || []) {
        if (dev?.did && !byDid.has(dev.did)) {
          byDid.set(dev.did, dev);
        }
      }
    }

    // Also query device_list_page (with pagination) in case BLE-only devices omit home rooms.
    let startDid = null;
    for (let page = 0; page < 5; page++) {
      const pageRes = await this.getDeviceListPage(region, startDid);
      const list = pageRes?.result?.list || [];
      for (const dev of list) {
        if (dev?.did && !byDid.has(dev.did)) {
          byDid.set(dev.did, dev);
        }
      }
      if (!pageRes?.result?.has_more || !pageRes?.result?.next_start_did) {
        break;
      }
      startDid = pageRes.result.next_start_did;
    }

    return Array.from(byDid.values());
  }

  async getBeaconKey(region, did) {
    return this.executeApiCallEncrypted(region, "/v2/device/blt_get_beaconkey", {
      did,
      pdid: 1,
    });
  }

  async getUserDeviceData(region, { did, type, key, timeStart, timeEnd, limit = 50 }) {
    return this.executeApiCallEncrypted(region, "/user/get_user_device_data", {
      did,
      type,
      key,
      time_start: timeStart,
      time_end: timeEnd,
      limit,
    });
  }

  async getMiotProps(region, propRequests) {
    return this.executeApiCallEncrypted(region, "/miotspec/prop/get", {
      params: propRequests,
    });
  }
}
