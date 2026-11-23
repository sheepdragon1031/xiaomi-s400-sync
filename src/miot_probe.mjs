const MIOT_INSTANCES_URL = "https://miot-spec.org/miot-spec-v2/instances?status=released";
const MIOT_INSTANCE_URL = "https://miot-spec.org/miot-spec-v2/instance?type=";

const PROP_KEYWORD_RE =
  /weight|fat|body|heart|impedance|muscle|bone|water|visceral|bmi|bmr|data|record|history|measure|user|profile|scale/i;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchMiotSpecForModel(model) {
  const listRes = await fetch(MIOT_INSTANCES_URL);
  if (!listRes.ok) {
    throw new Error(`Failed to fetch MIoT instances list: HTTP ${listRes.status}`);
  }
  const listData = await listRes.json();
  const instances = listData?.instances || [];

  // Prefer the latest version if multiple instances exist for the same model.
  const matched = instances
    .filter((inst) => inst.model === model)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));

  if (matched.length === 0) {
    return null;
  }

  const chosen = matched[0];
  const specRes = await fetch(`${MIOT_INSTANCE_URL}${encodeURIComponent(chosen.type)}`);
  if (!specRes.ok) {
    throw new Error(`Failed to fetch MIoT spec for ${chosen.type}: HTTP ${specRes.status}`);
  }
  const spec = await specRes.json();
  return summarizeMiotSpec(chosen.type, spec);
}

export function summarizeMiotSpec(urn, spec) {
  const services = [];
  const properties = [];
  const events = [];

  for (const svc of spec?.services || []) {
    services.push({
      iid: svc.iid,
      type: svc.type,
      description: svc.description,
    });
    for (const prop of svc.properties || []) {
      properties.push({
        siid: svc.iid,
        piid: prop.iid,
        type: prop.type,
        description: prop.description,
        format: prop.format,
        access: prop.access || [],
        unit: prop.unit || null,
      });
    }
    for (const ev of svc.events || []) {
      events.push({
        siid: svc.iid,
        eiid: ev.iid,
        type: ev.type,
        description: ev.description,
        arguments: ev.arguments || [],
      });
    }
  }

  return { urn, description: spec?.description || "", services, properties, events };
}

export function buildProbePlan(specSummary) {
  const eventKeys = new Set(["6", "4106", "weight", "body_composition", "measure"]);
  const propKeys = new Set(["weight", "body_fat", "heart_rate"]);
  const storeKeys = new Set([
    "weight",
    "records",
    "history",
    "scale_data",
    "user_info",
    "device_data",
  ]);

  if (specSummary) {
    for (const ev of specSummary.events) {
      eventKeys.add(`${ev.siid}.${ev.eiid}`);
      eventKeys.add(`event.${ev.siid}.${ev.eiid}`);
    }
    for (const prop of specSummary.properties) {
      const hay = `${prop.type} ${prop.description}`;
      if (PROP_KEYWORD_RE.test(hay)) {
        propKeys.add(`${prop.siid}.${prop.piid}`);
        propKeys.add(`prop.${prop.siid}.${prop.piid}`);
      }
    }
  }

  const probes = [];
  for (const key of eventKeys) probes.push({ type: "event", key });
  for (const key of propKeys) probes.push({ type: "prop", key });
  for (const key of storeKeys) probes.push({ type: "store", key });
  return probes;
}

export function redactSensitiveFields(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (
        k === "uid" ||
        k === "did" ||
        k === "userId" ||
        k === "token" ||
        k === "beaconkey" ||
        k === "mac"
      ) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSensitiveFields(v);
      }
    }
    return out;
  }
  return value;
}

function extractRecordsFromResponse(res) {
  const result = res?.result;
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") {
    if (Array.isArray(result.list)) return result.list;
    if (Array.isArray(result.records)) return result.records;
    if (Object.keys(result).length > 0) return [result];
  }
  return [];
}

function extractTimestampRange(records) {
  const times = [];
  for (const rec of records) {
    const ts = rec?.time ?? rec?.timestamp ?? rec?.ts;
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      times.push(ts > 1e12 ? Math.floor(ts / 1000) : ts);
    }
  }
  if (times.length === 0) return { earliest: null, latest: null };
  const min = Math.min(...times);
  const max = Math.max(...times);
  return {
    earliest: new Date(min * 1000).toISOString(),
    latest: new Date(max * 1000).toISOString(),
  };
}

export async function runDeviceDataProbes(client, region, did, specSummary, { delayMs = 150 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const threeYearsAgoSec = nowSec - 3 * 365 * 24 * 60 * 60;
  const plan = buildProbePlan(specSummary);

  const rawProbes = [];
  const nonEmptyProbes = [];
  const errorCodes = {};
  let emptyProbesCount = 0;

  for (const item of plan) {
    let response = null;
    let errorMessage = null;
    try {
      response = await client.getUserDeviceData(region, {
        did,
        type: item.type,
        key: item.key,
        timeStart: threeYearsAgoSec,
        timeEnd: nowSec,
        limit: 50,
      });
    } catch (err) {
      errorMessage = err.message;
    }

    rawProbes.push({
      endpoint: "/user/get_user_device_data",
      type: item.type,
      key: item.key,
      response,
      error: errorMessage,
    });

    if (response && response.code !== undefined && response.code !== 0) {
      const codeKey = String(response.code);
      errorCodes[codeKey] = (errorCodes[codeKey] || 0) + 1;
    }

    const records = extractRecordsFromResponse(response);
    if (records.length > 0) {
      const { earliest, latest } = extractTimestampRange(records);
      nonEmptyProbes.push({
        endpoint: "/user/get_user_device_data",
        type: item.type,
        key: item.key,
        code: response?.code ?? null,
        count: records.length,
        earliest,
        latest,
        samples: records.slice(0, 2).map(redactSensitiveFields),
      });
    } else {
      emptyProbesCount++;
    }

    await sleep(delayMs);
  }

  // Probe live MIoT readable properties via /miotspec/prop/get.
  let miotPropResult = null;
  if (specSummary) {
    const readableProps = specSummary.properties
      .filter((p) => Array.isArray(p.access) && p.access.includes("read"))
      .map((p) => ({ did, siid: p.siid, piid: p.piid }));

    if (readableProps.length > 0) {
      const chunks = [];
      for (let i = 0; i < readableProps.length; i += 15) {
        chunks.push(readableProps.slice(i, i + 15));
      }
      const combined = [];
      for (const chunk of chunks) {
        try {
          const res = await client.getMiotProps(region, chunk);
          combined.push(res);
          const list = Array.isArray(res?.result) ? res.result : [];
          const nonEmptyProps = list.filter((p) => p.code === 0 && p.value !== undefined);
          if (nonEmptyProps.length > 0) {
            nonEmptyProbes.push({
              endpoint: "/miotspec/prop/get",
              type: "miot_props",
              key: `${chunk[0].siid}.${chunk[0].piid}..`,
              code: res?.code ?? null,
              count: nonEmptyProps.length,
              earliest: null,
              latest: null,
              samples: nonEmptyProps.slice(0, 5).map(redactSensitiveFields),
            });
          }
        } catch (err) {
          combined.push({ error: err.message });
        }
        await sleep(delayMs);
      }
      miotPropResult = combined;
    }
  }

  return {
    raw: {
      userDeviceData: rawProbes,
      miotProps: miotPropResult,
    },
    nonEmptyProbes,
    emptyProbesCount,
    errorCodes,
  };
}
