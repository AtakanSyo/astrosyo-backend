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

  let verdict = "OK";
  if (avgCloud > 80 || totalPrecip > 1) verdict = "Bad";
  else if (avgCloud > 50) verdict = "Mixed";

  return {
    verdict,
    avg_cloud_cover_percent: Math.round(avgCloud),
    total_precip_mm: Math.round(totalPrecip * 10) / 10,
  };
}

function makeRuleBasedPlan(tonight, equipment) {
  const aperture = equipment?.aperture_mm;

  if (tonight.verdict === "Bad") {
    return [
      "Clouds/precip look bad. Expect limited observing.",
      "If there are brief gaps: try the Moon (if up) or bright planets.",
      "If clouds persist: use the night for planning—check tomorrow’s forecast and prep your gear.",
    ];
  }

  if (tonight.verdict === "Mixed") {
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

async function getAiPlan({ tonight, equipment, location, weather }) {
  const messages = [
    {
      role: "system",
      content:
        "You are an astronomy observing assistant. Be honest and practical. " +
        "Return EXACTLY 5 short lines. Each line MUST start with '- '. " +
        "No markdown, no bold, no numbering. No extra whitespace. Plain text only. " +
        "IMPORTANT: If the conditions verdict is 'Bad', clearly say that observing is unlikely and suggest indoor or planning alternatives."
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
    const tonight = summarizeTonight(weather);
    const plan = makeRuleBasedPlan(tonight, equipment);

    let ai_plan = null;
    let ai_error = null;

    try {
      ai_plan = await getAiPlan({ tonight, equipment, location, weather });
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
