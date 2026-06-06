// Wave & Wind Alert Service — Cloudflare Worker
// Paste this into the Cloudflare Workers dashboard editor and click Deploy.

// ── Wave alert locations ──────────────────────────────────────────────────────

const WAVE_LOCATIONS = [
  { name: "Sokken, Grimstad", lat: 58.2520, lon: 8.4664 },
  { name: "Lista, Farsund",   lat: 58.1091, lon: 6.5685 },
];

const WAVE_THRESHOLD_METERS = 2.0;

// ── Wind alert locations ──────────────────────────────────────────────────────

const WIND_LOCATIONS = [
  { name: "Kaldvellfjorden, Lillesand", lat: 58.2724, lon: 8.4276 },
];

const WIND_THRESHOLD_MS = 10.0;

// ── Shared settings ───────────────────────────────────────────────────────────

const FORECAST_DAYS = 10;

const EMAIL_RECIPIENTS = [
  "andreas.e.ludviksen@gmail.com",   // ← replace with real addresses
  "lars.tofte@gmail.com",
];

// ── MET Norway API ────────────────────────────────────────────────────────────

const OCEAN_API  = "https://api.met.no/weatherapi/oceanforecast/2.0/complete";
const USER_AGENT = "WaveWindAlertWorker/1.0 github.com/yourname/wave-alert";
const HOURS_AHEAD = FORECAST_DAYS * 24;

async function fetchForecast(lat, lon) {
  const url = `${OCEAN_API}?lat=${lat}&lon=${lon}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`MET API ${res.status} for (${lat}, ${lon})`);

  const data = await res.json();
  const now  = Date.now();
  const entries = [];

  for (const item of data.properties.timeseries) {
    const dt = new Date(item.time);
    const hoursAhead = (dt.getTime() - now) / 3_600_000;
    if (hoursAhead < 0 || hoursAhead > HOURS_AHEAD) continue;

    const details = item?.data?.instant?.details ?? {};
    entries.push({
      time:       dt,
      waveHeight: details.sea_surface_wave_height ?? null,
      windSpeed:  details.wind_speed ?? null,
    });
  }
  return entries;
}

// ── Check helpers ─────────────────────────────────────────────────────────────

async function checkWaveLocation(loc) {
  const entries = await fetchForecast(loc.lat, loc.lon);
  const valid   = entries.filter(e => e.waveHeight !== null);
  if (!valid.length) return null;

  const maxValue = Math.max(...valid.map(e => e.waveHeight));
  if (maxValue < WAVE_THRESHOLD_METERS) return null;

  return { name: loc.name, type: "wave", threshold: WAVE_THRESHOLD_METERS,
           unit: "m", entries: valid, maxValue };
}

async function checkWindLocation(loc) {
  const entries = await fetchForecast(loc.lat, loc.lon);
  const valid   = entries.filter(e => e.windSpeed !== null);
  if (!valid.length) return null;

  const maxValue = Math.max(...valid.map(e => e.windSpeed));
  if (maxValue < WIND_THRESHOLD_MS) return null;

  return { name: loc.name, type: "wind", threshold: WIND_THRESHOLD_MS,
           unit: "m/s", entries: valid, maxValue };
}

// ── Email building ────────────────────────────────────────────────────────────

function fmt(dt) {
  return dt.toISOString().replace("T", "  ").slice(0, 16) + " UTC";
}

function getValue(entry, type) {
  return type === "wave" ? entry.waveHeight : entry.windSpeed;
}

function locationTableHtml(loc) {
  const isWave    = loc.type === "wave";
  const typeLabel = isWave ? "Bølgehøyde" : "Vindhastighet";
  const typeIcon  = isWave ? "🌊" : "💨";
  const typeColor = isWave ? "#1a6fa8" : "#7d5a00";

  const rows = loc.entries.map(e => {
    const val = getValue(e, loc.type);
    if (val === null) return "";
    const high     = val >= loc.threshold;
    const rowStyle = high ? 'style="background:#fdecea;color:#c0392b;font-weight:bold"' : '';
    const flag     = high ? " ⚠️" : "";
    return (
      `<tr ${rowStyle}>` +
      `<td style="padding:4px 12px;font-family:monospace">${fmt(e.time)}</td>` +
      `<td style="padding:4px 12px;text-align:right;font-family:monospace">${val.toFixed(1)} ${loc.unit}${flag}</td>` +
      `</tr>`
    );
  }).filter(Boolean).join("\n");

  return `
<h3 style="margin:28px 0 6px;color:${typeColor}">
  ${typeIcon} ${loc.name}
  <span style="font-size:0.8em;font-weight:normal;color:#7f8c8d">
    (${isWave ? "bølge" : "vind"} — maks ${loc.maxValue.toFixed(1)} ${loc.unit})
  </span>
</h3>
<table border="1" cellpadding="0" cellspacing="0"
  style="border-collapse:collapse;font-size:0.88em;min-width:320px">
  <tr style="background:#2c3e50;color:white">
    <th style="padding:5px 12px;text-align:left">Tidspunkt</th>
    <th style="padding:5px 12px;text-align:right">${typeLabel}</th>
  </tr>
  ${rows}
</table>`;
}

function locationBlockText(loc) {
  const typeLabel = loc.type === "wave" ? "BØLGE" : "VIND";
  const lines = loc.entries
    .map(e => {
      const val = getValue(e, loc.type);
      if (val === null) return null;
      const flag = val >= loc.threshold ? "  ⚠" : "";
      return `  ${fmt(e.time)}   ${val.toFixed(1)} ${loc.unit}${flag}`;
    })
    .filter(Boolean);
  return `${"─".repeat(48)}\n[${typeLabel}] ${loc.name}  (maks ${loc.maxValue.toFixed(1)} ${loc.unit})\n${"─".repeat(48)}\n${lines.join("\n")}`;
}

function buildEmail(triggered) {
  const waveTriggered = triggered.filter(t => t.type === "wave");
  const windTriggered = triggered.filter(t => t.type === "wind");
  const generated     = new Date().toUTCString();

  const parts = [];
  if (waveTriggered.length) {
    const names = waveTriggered.map(t => t.name).join(", ");
    const max   = Math.max(...waveTriggered.map(t => t.maxValue));
    parts.push(`🌊 Bølger opp til ${max.toFixed(1)} m (${names})`);
  }
  if (windTriggered.length) {
    const names = windTriggered.map(t => t.name).join(", ");
    const max   = Math.max(...windTriggered.map(t => t.maxValue));
    parts.push(`💨 Vind opp til ${max.toFixed(1)} m/s (${names})`);
  }

  const subject = `⚠️ Værvarsling: ${parts.join(" · ")} — neste ${FORECAST_DAYS} dager`;

  const html = `
<html><body style="font-family:sans-serif;max-width:640px;margin:auto;color:#333">
  <h2 style="color:#2c3e50">⚠️ Værvarsling – ${FORECAST_DAYS}-dagersprognose</h2>
  <p>Ett eller flere varsler er utløst for de neste ${FORECAST_DAYS} dagene.
     Rader markert i rødt overskrider terskelen.</p>
  <table style="border-collapse:collapse;margin-bottom:16px">
    ${waveTriggered.length ? `<tr><td style="padding:3px 10px">🌊 Bølgeterskel</td><td><strong>≥ ${WAVE_THRESHOLD_METERS} m</strong></td></tr>` : ""}
    ${windTriggered.length ? `<tr><td style="padding:3px 10px">💨 Vindterskel</td><td><strong>≥ ${WIND_THRESHOLD_MS} m/s</strong></td></tr>` : ""}
  </table>
  ${triggered.map(locationTableHtml).join("")}
  <p style="color:#95a5a6;font-size:0.82em;margin-top:24px">
    Kilde: MET Norway Oceanforecast API · Generert ${generated}
  </p>
</body></html>`;

  const text = [
    `VÆRVARSLING – ${FORECAST_DAYS}-DAGERSPROGNOSE`,
    waveTriggered.length ? `Bølgeterskel: >= ${WAVE_THRESHOLD_METERS} m` : "",
    windTriggered.length ? `Vindterskel:   >= ${WIND_THRESHOLD_MS} m/s` : "",
    "",
    ...triggered.map(locationBlockText),
    "",
    "Kilde: MET Norway Oceanforecast API",
    `Generert: ${generated}`,
  ].filter(l => l !== null).join("\n");

  return { subject, html, text };
}

// ── Resend ────────────────────────────────────────────────────────────────────

async function sendEmail(env, subject, html, text) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: EMAIL_RECIPIENTS, subject, html, text }),
  });

  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  console.log("Alert sent to:", EMAIL_RECIPIENTS.join(", "));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(env) {
  console.log(`Starting alert check — ${FORECAST_DAYS}-day window`);

  const triggered = [];

  for (const loc of WAVE_LOCATIONS) {
    console.log(`Checking waves: ${loc.name}`);
    try {
      const result = await checkWaveLocation(loc);
      if (result) {
        console.log(`  ⚠️  Max wave: ${result.maxValue.toFixed(1)} m`);
        triggered.push(result);
      } else {
        console.log(`  ✓  Below threshold`);
      }
    } catch (e) {
      console.error(`  Error: ${e}`);
    }
  }

  for (const loc of WIND_LOCATIONS) {
    console.log(`Checking wind: ${loc.name}`);
    try {
      const result = await checkWindLocation(loc);
      if (result) {
        console.log(`  ⚠️  Max wind: ${result.maxValue.toFixed(1)} m/s`);
        triggered.push(result);
      } else {
        console.log(`  ✓  Below threshold`);
      }
    } catch (e) {
      console.error(`  Error: ${e}`);
    }
  }

  if (!triggered.length) {
    console.log("All clear — no alerts triggered. No email sent.");
    return;
  }

  console.log(`${triggered.length} alert(s) triggered. Sending email...`);
  const { subject, html, text } = buildEmail(triggered);
  await sendEmail(env, subject, html, text);
  console.log("Done.");
}

// ── Cloudflare Worker entry point ─────────────────────────────────────────────

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/run") {
      ctx.waitUntil(run(env));
      return new Response("Alert check triggered.\n", { status: 202 });
    }
    return new Response(
      "Wave & Wind Alert Worker is running.\nVisit /run to trigger a manual check.\n",
      { status: 200 }
    );
  },
};