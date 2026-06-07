// Flight Price Alert Service — Cloudflare Worker
// Uses SerpApi Google Flights API to check roundtrip prices for a family of 5.
//
// Required Worker secrets (set via Cloudflare dashboard or wrangler secret put):
//   SERPAPI_KEY     — your SerpApi API key (https://serpapi.com/dashboard)
//   RESEND_API_KEY  — your Resend API key
//   EMAIL_FROM      — verified sender address in Resend (e.g. "varsling@yourdomain.com")
//
// Cron trigger suggestion: "0 7 * * *" (every day at 07:00 UTC)

// ── Departure airports ────────────────────────────────────────────────────────

const DEPARTURE_AIRPORTS = ["OSL"];

// ── Passengers ────────────────────────────────────────────────────────────────
// Google Flights passengers: adults, children (2-11), infants_in_seat
// Ages: 9, 12, 14 → two adults (12+14 treated as adults by Google), one child (9)
// Note: Google Flights counts 12+ as adults. Adjust if you want different grouping.

const PASSENGERS = {
  adults: 4,        // age 12, 14 + two parents
  children: 1,      // age 9
  infants_in_seat: 0,
};

// ── Destinations ─────────────────────────────────────────────────────────────
// Each destination has:
//   iata          — IATA airport code
//   name          — human-readable name for emails
//   thresholdNOK  — alert if total roundtrip price for all passengers is below this
//   departureWindow — { earliest: "YYYY-MM-DD", latest: "YYYY-MM-DD" }
//   returnWindow    — { earliest: "YYYY-MM-DD", latest: "YYYY-MM-DD" }

const DESTINATIONS = [
  {
    iata: "SJO",
    name: "San José, Costa Rica",
    thresholdNOK: 50000,
    departureWindow: { earliest: "2026-12-27", latest: "2026-12-29" },
    returnWindow:    { earliest: "2027-01-16", latest: "2027-01-18" },
  },
  {
    iata: "LIR",
    name: "Liberia, Costa Rica",
    thresholdNOK: 50000,
    departureWindow: { earliest: "2026-12-27", latest: "2026-12-29" },
    returnWindow:    { earliest: "2027-01-16", latest: "2027-01-18" },
  },
  {
    iata: "DPS",
    name: "Bali, Indonesia",
    thresholdNOK: 50000,
    departureWindow: { earliest: "2026-12-27", latest: "2026-12-29" },
    returnWindow:    { earliest: "2027-01-16", latest: "2027-01-18" },
  },
  {
    iata: "JKT",
    name: "Jakarta, Indonesia",
    thresholdNOK: 50000,
    departureWindow: { earliest: "2026-12-27", latest: "2026-12-29" },
    returnWindow:    { earliest: "2027-01-16", latest: "2027-01-18" },
  },
  {
    iata: "MNL",
    name: "Manila, Filippinene",
    thresholdNOK: 50000,
    departureWindow: { earliest: "2026-12-27", latest: "2026-12-29" },
    returnWindow:    { earliest: "2027-01-16", latest: "2027-01-18" },
  },
];

// ── Shared settings ───────────────────────────────────────────────────────────

// How many departure dates to sample within the window (evenly spaced)
// 4 means roughly one per day across a 3-4 day window — increase for wider windows
const DEPARTURE_DATE_SAMPLES = 4;

const EMAIL_RECIPIENTS = [
  "andreas.e.ludviksen@gmail.com",
];

// ── SerpApi ───────────────────────────────────────────────────────────────────

const SERPAPI_BASE = "https://serpapi.com/search.json";

function buildPassengerParams() {
  const p = [];
  if (PASSENGERS.adults)         p.push(`adults=${PASSENGERS.adults}`);
  if (PASSENGERS.children)       p.push(`children=${PASSENGERS.children}`);
  if (PASSENGERS.infants_in_seat) p.push(`infants_in_seat=${PASSENGERS.infants_in_seat}`);
  return p.join("&");
}

// Generate evenly-spaced date samples within a window
function sampleDates(earliest, latest, count) {
  const start = new Date(earliest).getTime();
  const end   = new Date(latest).getTime();
  if (start >= end) return [earliest];

  const dates = [];
  for (let i = 0; i < count; i++) {
    const t = start + (end - start) * (i / Math.max(count - 1, 1));
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  // Deduplicate
  return [...new Set(dates)];
}

// Build all (departure, return) date pairs for a destination
function buildDatePairs(dest) {
  const departureDates = sampleDates(
    dest.departureWindow.earliest,
    dest.departureWindow.latest,
    DEPARTURE_DATE_SAMPLES,
  );

  const pairs = [];
  for (const dep of departureDates) {
    const returnEarliest = dest.returnWindow.earliest;
    const returnLatest   = dest.returnWindow.latest;

    if (returnEarliest > returnLatest) continue;

    const returnDates = sampleDates(returnEarliest, returnLatest, DEPARTURE_DATE_SAMPLES);
    for (const ret of returnDates) {
      pairs.push({ departure: dep, return: ret });
    }
  }
  return pairs;
}

async function fetchFlightPrice(origin, destination, outboundDate, returnDate, apiKey) {
  const passengerParams = buildPassengerParams();
  const url =
    `${SERPAPI_BASE}?engine=google_flights` +
    `&departure_id=${origin}` +
    `&arrival_id=${destination}` +
    `&outbound_date=${outboundDate}` +
    `&return_date=${returnDate}` +
    `&currency=NOK` +
    `&hl=no` +
    `&type=1` +            // 1 = round trip
    `&${passengerParams}` +
    `&api_key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpApi ${res.status} — ${origin}→${destination} ${outboundDate}`);

  const data = await res.json();

  // Collect best price from best_flights + other_flights
  const allFlights = [
    ...(data.best_flights  ?? []),
    ...(data.other_flights ?? []),
  ];

  if (!allFlights.length) return null;

  const prices = allFlights.map(f => f.price).filter(p => typeof p === "number");
  if (!prices.length) return null;

  const minPrice = Math.min(...prices);
  const best     = allFlights.find(f => f.price === minPrice);

  return {
    price:         minPrice,
    airline:       best?.flights?.[0]?.airline ?? "Ukjent",
    totalDuration: best?.total_duration ?? null,
    stops:         best?.flights?.length ? best.flights.length - 1 : null,
  };
}

// ── Check helpers ─────────────────────────────────────────────────────────────

async function checkRoute(origin, dest, apiKey) {
  const pairs  = buildDatePairs(dest);
  const hits   = [];
  let   errors = 0;

  for (const { departure, return: ret } of pairs) {
    try {
      const result = await fetchFlightPrice(origin, dest.iata, departure, ret, apiKey);
      if (!result) continue;

      console.log(
        `  ${origin}→${dest.iata} ${departure}→${ret}: ` +
        `${result.price.toLocaleString("nb-NO")} NOK`,
      );

      if (result.price < dest.thresholdNOK) {
        hits.push({ departure, return: ret, ...result });
      }
    } catch (e) {
      console.error(`  Error: ${e.message}`);
      errors++;
    }

    // Small delay to be polite to SerpApi
    await new Promise(r => setTimeout(r, 300));
  }

  if (!hits.length) return null;

  // Return the single best hit
  hits.sort((a, b) => a.price - b.price);
  return {
    origin,
    dest,
    bestHit:   hits[0],
    allHits:   hits,
    errors,
  };
}

// ── Email building ────────────────────────────────────────────────────────────

function fmtNOK(n) {
  return n.toLocaleString("nb-NO") + " NOK";
}

function fmtDuration(mins) {
  if (!mins) return "–";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}t ${m}m`;
}

function passengerSummary() {
  const parts = [];
  if (PASSENGERS.adults)         parts.push(`${PASSENGERS.adults} voksne`);
  if (PASSENGERS.children)       parts.push(`${PASSENGERS.children} barn`);
  if (PASSENGERS.infants_in_seat) parts.push(`${PASSENGERS.infants_in_seat} spedbarn`);
  return parts.join(", ");
}

function routeTableHtml(alert) {
  const { origin, dest, bestHit, allHits } = alert;

  const rows = allHits.slice(0, 8).map(hit => {
    const isLowest = hit.price === bestHit.price;
    const style    = isLowest
      ? 'style="background:#eaf7ea;color:#1a7a1a;font-weight:bold"'
      : '';
    const flag = isLowest ? " 🏆" : "";
    return (
      `<tr ${style}>` +
      `<td style="padding:4px 12px;font-family:monospace">${hit.departure}</td>` +
      `<td style="padding:4px 12px;font-family:monospace">${hit.return}</td>` +
      `<td style="padding:4px 12px;text-align:right;font-family:monospace">${fmtNOK(hit.price)}${flag}</td>` +
      `<td style="padding:4px 12px;text-align:center">${hit.airline}</td>` +
      `<td style="padding:4px 12px;text-align:center">${fmtDuration(hit.totalDuration)}</td>` +
      `</tr>`
    );
  }).join("\n");

  return `
<h3 style="margin:28px 0 6px;color:#1a4fa8">
  ✈️ ${origin} → ${dest.name} (${dest.iata})
  <span style="font-size:0.8em;font-weight:normal;color:#7f8c8d">
    beste pris: ${fmtNOK(bestHit.price)} · terskel: ${fmtNOK(dest.thresholdNOK)}
  </span>
</h3>
<table border="1" cellpadding="0" cellspacing="0"
  style="border-collapse:collapse;font-size:0.88em;min-width:500px">
  <tr style="background:#2c3e50;color:white">
    <th style="padding:5px 12px;text-align:left">Avreise</th>
    <th style="padding:5px 12px;text-align:left">Hjemreise</th>
    <th style="padding:5px 12px;text-align:right">Totalpris</th>
    <th style="padding:5px 12px;text-align:center">Flyselskap</th>
    <th style="padding:5px 12px;text-align:center">Reisetid</th>
  </tr>
  ${rows}
</table>`;
}

function routeBlockText(alert) {
  const { origin, dest, bestHit, allHits } = alert;
  const lines = allHits.slice(0, 8).map(hit => {
    const flag = hit.price === bestHit.price ? "  🏆" : "";
    return (
      `  ${hit.departure} → ${hit.return}` +
      `   ${fmtNOK(hit.price).padStart(16)}` +
      `   ${hit.airline}` +
      `   ${fmtDuration(hit.totalDuration)}${flag}`
    );
  });
  return (
    `${"─".repeat(60)}\n` +
    `[FLY] ${origin} → ${dest.name} (${dest.iata})  ` +
    `beste: ${fmtNOK(bestHit.price)} / terskel: ${fmtNOK(dest.thresholdNOK)}\n` +
    `${"─".repeat(60)}\n` +
    lines.join("\n")
  );
}

function buildEmail(alerts) {
  const generated = new Date().toUTCString();
  const pax       = passengerSummary();

  // Subject line: list best finds
  const highlights = alerts
    .map(a => `${a.origin}→${a.dest.iata} ${fmtNOK(a.bestHit.price)}`)
    .join(" · ");
  const subject = `✈️ Flyprisvarsel: ${highlights}`;

  const html = `
<html><body style="font-family:sans-serif;max-width:680px;margin:auto;color:#333">
  <h2 style="color:#2c3e50">✈️ Flyprisvarsel — under terskelpriser funnet!</h2>
  <p>
    Følgende ruter har priser under terskelen for <strong>${pax}</strong>
    (rundtur, totalpris alle passasjerer).
    Rader med 🏆 er den billigste kombinasjonen per rute.
  </p>
  <table style="border-collapse:collapse;margin-bottom:16px">
    <tr><td style="padding:3px 10px">👥 Passasjerer</td><td><strong>${pax}</strong></td></tr>
    <tr><td style="padding:3px 10px">💱 Valuta</td><td><strong>NOK</strong></td></tr>
  </table>
  ${alerts.map(routeTableHtml).join("")}
  <p style="color:#95a5a6;font-size:0.82em;margin-top:24px">
    Kilde: Google Flights via SerpApi · Generert ${generated}<br>
    Priser er veiledende og kan ha endret seg. Sjekk Google Flights for å booke.
  </p>
</body></html>`;

  const text = [
    `FLYPRISVARSEL — under terskelpriser funnet!`,
    `Passasjerer: ${pax}`,
    `Valuta: NOK`,
    "",
    ...alerts.map(routeBlockText),
    "",
    "Kilde: Google Flights via SerpApi",
    `Generert: ${generated}`,
    "Priser er veiledende — sjekk Google Flights for å booke.",
  ].join("\n");

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
    body: JSON.stringify({
      from:    env.EMAIL_FROM,
      to:      EMAIL_RECIPIENTS,
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  console.log("Alert sent to:", EMAIL_RECIPIENTS.join(", "));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(env) {
  console.log("Starting flight price check…");

  const alerts = [];

  for (const origin of DEPARTURE_AIRPORTS) {
    for (const dest of DESTINATIONS) {
      console.log(`Checking ${origin} → ${dest.iata} (${dest.name})…`);
      try {
        const alert = await checkRoute(origin, dest, env.SERPAPI_KEY);
        if (alert) {
          console.log(
            `  ⚠️  Hit! Beste pris: ${alert.bestHit.price.toLocaleString("nb-NO")} NOK` +
            ` (terskel: ${dest.thresholdNOK.toLocaleString("nb-NO")} NOK)`,
          );
          alerts.push(alert);
        } else {
          console.log(`  ✓  Ingen treff under terskel.`);
        }
      } catch (e) {
        console.error(`  Feil ved ${origin}→${dest.iata}: ${e.message}`);
      }
    }
  }

  if (!alerts.length) {
    console.log("Ingen varsler utløst. Ingen e-post sendt.");
    return;
  }

  console.log(`${alerts.length} varsel(er) utløst. Sender e-post…`);
  const { subject, html, text } = buildEmail(alerts);
  await sendEmail(env, subject, html, text);
  console.log("Ferdig.");
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
      return new Response("Flyprissjekk startet.\n", { status: 202 });
    }
    return new Response(
      "Flight Price Alert Worker kjører.\nGå til /run for manuell sjekk.\n",
      { status: 200 },
    );
  },
};
