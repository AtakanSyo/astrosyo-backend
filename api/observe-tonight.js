const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=cloud_cover,precipitation,wind_speed_10m` +
    `&timezone=auto`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Weather API request failed");
  return await res.json();
}

const fs = require("fs");
const path = require("path");

let MESSIER_CACHE = null;

function loadMessier() {
  if (MESSIER_CACHE) return MESSIER_CACHE;
  const p = path.join(process.cwd(), "data", "messier.json");
  const raw = fs.readFileSync(p, "utf8");
  MESSIER_CACHE = JSON.parse(raw);
  return MESSIER_CACHE;
}

const Astronomy = require("astronomy-engine");
const { DateTime } = require("luxon");

function toDateInWeatherTZ(isoLocal, tz) {
  // isoLocal looks like: "2026-02-08T22:00"
  // Interpret it as time in that timezone
  return DateTime.fromISO(isoLocal, { zone: tz || "UTC" }).toJSDate();
}

function altitudeDeg(lat, lon, date, raDeg, decDeg) {
  const observer = new Astronomy.Observer(lat, lon, 0);

  // Horizon(date, observer, ra, dec, refraction)
  const hor = Astronomy.Horizon(
    date,
    observer,
    raDeg,
    decDeg,
    "normal"   // or "none" if you want geometric altitude
  );

  return hor.altitude; // degrees
}

function pickTargets({ lat, lon, date, apertureMm, max = 8 }) {
  const messier = loadMessier();

  const scored = [];
  for (const o of messier) {
    const ra = Number(o.ra_deg);
    const dec = Number(o.dec_deg);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;

    const alt = altitudeDeg(lat, lon, date, ra, dec);

    // hard filter: below horizon / too low (you can tune)
    if (alt < 15) continue;

    const mag = Number(o.apparent_magnitude);
    const major = Number(o.size_major_arcmin);

    // ----- simple scoring (tune later) -----
    // altitude dominates
    let score = alt * 2.0;

    // reward brighter objects (lower mag)
    if (Number.isFinite(mag)) score += (10 - mag) * 3.0;

    // aperture helps faint stuff a bit
    if (Number.isFinite(apertureMm)) score += Math.min(2.0, (apertureMm - 80) / 80);

    // small bonus for larger apparent size (nice visually)
    if (Number.isFinite(major)) score += Math.min(2.0, major / 30);

    // tiny type-based bonus (optional)
    const t = (o.object_type || "").toLowerCase();
    if (t.includes("globular")) score += 0.6;
    if (t.includes("open cluster")) score += 0.4;
    if (t.includes("nebula")) score += 0.7;

    scored.push({
      ...o,
      altitude_deg: Math.round(alt * 10) / 10,
      score: Math.round(score * 10) / 10,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max);
}

function computeBestWindow(weather, hours = 12, windowHours = 2) {
  const times = weather.hourly.time.slice(0, hours);
  const clouds = weather.hourly.cloud_cover.slice(0, hours);
  const precip = weather.hourly.precipitation.slice(0, hours);
  const wind = weather.hourly.wind_speed_10m.slice(0, hours);

  if (times.length < windowHours) return null;

  // score: lower is better
  // clouds dominates, precipitation is heavily penalized, wind lightly
  const scoreAt = (i) => {
    const c = avg(clouds.slice(i, i + windowHours));
    const p = sum(precip.slice(i, i + windowHours));
    const w = avg(wind.slice(i, i + windowHours));
    return c * 1.0 + p * 100.0 + w * 0.2;
  };

  let bestI = 0;
  let bestScore = scoreAt(0);

  for (let i = 1; i <= times.length - windowHours; i++) {
    const s = scoreAt(i);
    if (s < bestScore) {
      bestScore = s;
      bestI = i;
    }
  }

  const start = times[bestI];
  const end = times[bestI + windowHours - 1];

  return {
    start,
    end,
    window_hours: windowHours,
    avg_cloud_cover_percent: Math.round(avg(clouds.slice(bestI, bestI + windowHours))),
    total_precip_mm: round1(sum(precip.slice(bestI, bestI + windowHours))),
    avg_wind_kmh: round1(avg(wind.slice(bestI, bestI + windowHours))),
    score: round1(bestScore),
  };
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
}
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
function round1(x) {
  return Math.round(x * 10) / 10;
}

function hemiLat(lat) {
  return lat >= 0 ? "N" : "S";
}
function hemiLon(lon) {
  return lon >= 0 ? "E" : "W";
}
function formatLatLon(lat, lon, digits = 4) {
  const alat = Math.abs(lat).toFixed(digits);
  const alon = Math.abs(lon).toFixed(digits);
  return `${alat}° ${hemiLat(lat)}, ${alon}° ${hemiLon(lon)}`;
}

/**
 * Very small helper: get a "local-ish" current time string.
 * Open-Meteo hourly.time is already in the requested timezone (timezone=auto).
 * We'll use the first hourly time as the local baseline.
 */
function localNowFromWeather(weather) {
  const t0 = weather?.hourly?.time?.[0];
  if (!t0) return null;
  // t0 looks like "2026-02-08T10:00" in local timezone
  return t0;
}

function summarizeTonight(weather) {
  const clouds = weather.hourly.cloud_cover.slice(0, 6);
  const precip = weather.hourly.precipitation.slice(0, 6);

  const avgCloud = clouds.reduce((a, b) => a + b, 0) / clouds.length;
  const totalPrecip = precip.reduce((a, b) => a + b, 0);

  let verdict = "ok";
  if (avgCloud > 80 || totalPrecip > 1) verdict = "bad";
  else if (avgCloud > 50) verdict = "mixed";

  return {
    verdict,
    avg_cloud_cover_percent: Math.round(avgCloud),
    total_precip_mm: Math.round(totalPrecip * 10) / 10,
  };
}
function makeRuleBasedPlan(tonight, equipment) {
  const aperture = equipment?.aperture_mm;
  const v = String(tonight?.verdict || "").toLowerCase();

  if (v === "bad") {
    return [
      "Clouds/precip look bad. Expect limited observing.",
      "If there are brief gaps: try the Moon (if up) or bright planets.",
      "If clouds persist: use the night for planning—check tomorrow’s forecast and prep your gear.",
    ];
  }

  if (v === "mixed") {
    return [
      "Conditions are mixed. Watch for clear windows.",
      "Focus on bright targets: planets, Moon, bright star clusters.",
      "Keep sessions short and flexible—observe whenever the sky opens.",
    ];
  }

  const base = [
    "Conditions look decent. Plan a full session.",
    "Start with bright/easy targets, then go deeper later in the night.",
  ];

  if (typeof aperture === "number" && aperture >= 150) {
    base.push("With ~150mm+ aperture, try brighter nebulae/galaxies (e.g., Orion Nebula).");
  } else {
    base.push("With smaller aperture/binoculars, prioritize open clusters and bright nebulae.");
  }

  return base;
}

function sanitizeAiPlan(text) {
  if (!text) return null;
  return String(text)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map(l => l.startsWith("- ") ? l : `- ${l.replace(/^[-•]\s*/, "")}`)
    .join("\n");
}

async function getAiPlan({ tonight, equipment, location, weather, targets }) {
  const topTargetsText = (targets || [])
    .slice(0, 6)
    .map(t =>
      `- ${t.messier_no} (${t.ngcic_no}) ${t.common_name || ""} | ${t.object_type} | mag ${t.apparent_magnitude} | alt ${t.altitude_deg}°`
    )
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are an astronomy observing assistant. " +
        "Return EXACTLY 5 lines. " +
        "Each line MUST start with '- ' (dash + space). " +
        "No blank lines. No trailing spaces. No extra punctuation at line ends. " +
        "Plain text only." +
        "IMPORTANT: If verdict is Bad, do NOT recommend more than 1-2 targets. Instead focus on “unlikely observing” + alternatives."
    },
    {
      role: "user",
      content:
        `Location: ${location?.label || "unknown"}
Latitude/Longitude: ${location?.latlon || "unknown"}
Hemisphere: ${location?.hemisphere || "unknown"}
Local timezone: ${weather?.timezone || "unknown"}
Local time (approx): ${location?.local_time || "unknown"}

Conditions verdict: ${tonight.verdict}
Average cloud cover: ${tonight.avg_cloud_cover_percent}%
Total precipitation: ${tonight.total_precip_mm} mm
Telescope aperture: ${equipment?.aperture_mm || "unknown"} mm

Candidate visible Messier targets (ranked):
${topTargetsText || "- (none found)"}

Task: Suggest what to observe tonight for this setup and conditions.`
    },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    max_tokens: 200,
    temperature: 0.7,
  });

  return response.choices[0].message.content;
}

function readJsonBody(req) {
  // Vercel usually parses JSON into req.body already, but we support both.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch {}
  }
  return null;
}

//HANDLER
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const body = readJsonBody(req) || {};
    const { lat, lon, equipment } = body;

    if (typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({ ok: false, error: "lat and lon must be numbers" });
    }

    const weather = await getWeather(lat, lon);
    const location = {
      lat,
      lon,
      hemisphere: `${hemiLat(lat)}/${hemiLon(lon)}`,
      latlon: formatLatLon(lat, lon, 4),
      // optional: you can send city/country from the app later
      label: formatLatLon(lat, lon, 2),
      local_time: localNowFromWeather(weather),
    };
    const best_window = computeBestWindow(weather, 12, 2);
    let targets = [];
    if (best_window?.start) {
      const tz = weather.timezone;
      const d = toDateInWeatherTZ(best_window.start, tz);
      targets = pickTargets({
        lat,
        lon,
        date: d,
        apertureMm: equipment?.aperture_mm,
        max: 8,
      });
    }
    const tonight = summarizeTonight(weather);

    const plan = makeRuleBasedPlan(tonight, equipment);

    let ai_plan = null;
    let ai_error = null;

    try {
      ai_plan = sanitizeAiPlan(await getAiPlan({ tonight, equipment, location, weather, targets }));
    } catch (e) {
      ai_error = e?.message || String(e);
      console.error("AI PLAN ERROR:", e);
      ai_plan = null;
    }

    return res.status(200).json({
      ok: true,
      received: { lat, lon, equipment, location },
      tonight,
      best_window,
      targets,
      plan,
      ai_plan,
      weather: {
        timezone: weather.timezone,
        hourly_units: weather.hourly_units,
        hourly: {
          time: weather.hourly.time.slice(0, 12),
          cloud_cover: weather.hourly.cloud_cover.slice(0, 12),
          precipitation: weather.hourly.precipitation.slice(0, 12),
          wind_speed_10m: weather.hourly.wind_speed_10m.slice(0, 12),
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
};
