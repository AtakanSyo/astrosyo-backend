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

async function getAiPlan({ tonight, equipment }) {
  const messages = [
    {
      role: "system",
      content:
        "You are an astronomy observing assistant. Be honest and practical. Keep the answer short (max 5 bullet points).",
    },
    {
      role: "user",
      content:
        `Conditions verdict: ${tonight.verdict}.
Average cloud cover: ${tonight.avg_cloud_cover_percent}%.
Total precipitation: ${tonight.total_precip_mm} mm.
Telescope aperture: ${equipment?.aperture_mm || "unknown"} mm.

User asks: What can I observe tonight?`,
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
    const tonight = summarizeTonight(weather);
    const plan = makeRuleBasedPlan(tonight, equipment);

    let ai_plan = null;
    try {
      ai_plan = await getAiPlan({ tonight, equipment });
    } catch (e) {
      ai_plan = null;
    }

    return res.status(200).json({
      ok: true,
      received: { lat, lon, equipment },
      tonight,
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
