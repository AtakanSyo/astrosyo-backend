const express = require("express");
const OpenAI = require("openai");

require("dotenv").config();

const app = express();
app.use(express.json());

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
  if (!res.ok) {
    throw new Error("Weather API request failed");
  }
  return await res.json();
}

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

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
      "Focus on bright targets: planets, Moon, bright star clusters (Pleiades, Beehive if visible).",
      "Keep sessions short and flexible—observe whenever the sky opens.",
    ];
  }

  // OK
  const base = [
    "Conditions look decent. Plan a full session.",
    "Start with bright/easy targets, then go deeper later in the night.",
  ];

  if (typeof aperture === "number" && aperture >= 150) {
    base.push("With ~150mm+ aperture, you can also try brighter nebulae/galaxies (e.g., Orion Nebula, Andromeda if visible).");
  } else {
    base.push("With smaller aperture/binoculars, prioritize open clusters and bright nebulae.");
  }

  return base;
}

function summarizeTonight(weather) {
  // Use the first 6 hours in the response (you can adjust later)
  const clouds = weather.hourly.cloud_cover.slice(0, 6);
  const precip = weather.hourly.precipitation.slice(0, 6);

  const avgCloud = clouds.reduce((a, b) => a + b, 0) / clouds.length;
  const totalPrecip = precip.reduce((a, b) => a + b, 0);

  let verdict = "OK";
  if (avgCloud > 80 || totalPrecip > 1) verdict = "Bad";
  else if (avgCloud > 50) verdict = "Mixed";

  return {
    verdict,                    // "Bad" | "Mixed" | "OK"
    avg_cloud_cover_percent: Math.round(avgCloud),
    total_precip_mm: Math.round(totalPrecip * 10) / 10
  };
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

app.post("/observe-tonight", async (req, res) => {
  try {
    const { lat, lon, equipment } = req.body || {};

    if (typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({
        ok: false,
        error: "lat and lon must be numbers",
      });
    }

    const weather = await getWeather(lat, lon);
    const tonight = summarizeTonight(weather);
    const plan = makeRuleBasedPlan(tonight, equipment);

    let ai_plan = null;
    try {
      ai_plan = await getAiPlan({ tonight, equipment });
    } catch (e) {
      ai_plan = null;
      console.error("OpenAI error:", e?.message || e);
      // If the SDK provides a response body, print it too:
      if (e?.response?.data) console.error("OpenAI error data:", e.response.data);
    }

    res.json({
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
    res.status(500).json({
      ok: false,
      error: err.message || "Unknown error",
    });
  }
});


app.get("/", (req, res) => {
  res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Astrosyo Observe Tonight</title>
  <style>
    body { font-family: -apple-system, system-ui, Arial; margin: 24px; line-height: 1.4; }
    .wrap { max-width: 900px; margin: 0 auto; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; margin: 12px 0; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    label { display: block; font-size: 12px; color: #555; margin-bottom: 6px; }
    input { padding: 10px; border: 1px solid #ccc; border-radius: 10px; width: 180px; }
    button { padding: 10px 14px; border: 0; border-radius: 10px; cursor: pointer; }
    button.primary { background: #111; color: #fff; }
    pre { background: #0b0b0b; color: #eaeaea; padding: 12px; border-radius: 12px; overflow: auto; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; border: 1px solid #ddd; }
    .bad { border-color: #ffb3b3; background: #fff0f0; }
    .mixed { border-color: #ffe2a8; background: #fff8e8; }
    .ok { border-color: #b7f0c2; background: #eefcf1; }
    ul { margin: 8px 0 0 18px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Astrosyo — Observe Tonight</h1>

    <div class="card">
      <div class="row">
        <div>
          <label>Latitude</label>
          <input id="lat" type="number" step="0.0001" value="41.0" />
        </div>
        <div>
          <label>Longitude</label>
          <input id="lon" type="number" step="0.0001" value="29.0" />
        </div>
        <div>
          <label>Aperture (mm)</label>
          <input id="aperture" type="number" step="1" value="150" />
        </div>
        <div>
          <label>Telescope type</label>
          <input id="type" type="text" value="dobsonian" />
        </div>
      </div>
      <div style="margin-top:12px;">
        <button class="primary" id="btn">What can I observe tonight?</button>
        <span id="status" style="margin-left:10px;color:#666;"></span>
      </div>
    </div>

    <div class="card">
      <h3>Tonight</h3>
      <div id="tonightBox"></div>
    </div>

    <div class="card">
      <h3>Rule plan</h3>
      <div id="planBox"></div>
    </div>

    <div class="card">
      <h3>AI plan</h3>
      <div id="aiBox"></div>
    </div>

    <div class="card">
      <h3>Raw JSON</h3>
      <pre id="raw"></pre>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
      }[c]));
    }

    function renderTonight(tonight) {
      if (!tonight) return "<em>No data</em>";
      const v = tonight.verdict || "Unknown";
      const cls = v === "Bad" ? "pill bad" : v === "Mixed" ? "pill mixed" : "pill ok";
      return \`
        <div>
          <span class="\${cls}">Verdict: \${escapeHtml(v)}</span>
          <div style="margin-top:10px;color:#333;">
            Avg cloud: <b>\${escapeHtml(tonight.avg_cloud_cover_percent)}</b>% &nbsp;·&nbsp;
            Total precip: <b>\${escapeHtml(tonight.total_precip_mm)}</b> mm
          </div>
        </div>
      \`;
    }

    function renderList(arr) {
      if (!arr || !arr.length) return "<em>None</em>";
      return "<ul>" + arr.map(x => "<li>" + escapeHtml(x) + "</li>").join("") + "</ul>";
    }

    $("btn").addEventListener("click", async () => {
      $("status").textContent = "Loading...";
      $("raw").textContent = "";

      const lat = Number($("lat").value);
      const lon = Number($("lon").value);
      const equipment = {
        type: $("type").value,
        aperture_mm: Number($("aperture").value)
      };

      try {
        const res = await fetch("/observe-tonight", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lon, equipment })
        });

        const data = await res.json();

        $("tonightBox").innerHTML = renderTonight(data.tonight);
        $("planBox").innerHTML = renderList(data.plan);
        $("aiBox").innerHTML = data.ai_plan
          ? "<pre>" + escapeHtml(data.ai_plan) + "</pre>"
          : "<em>(AI plan is null)</em>";

        $("raw").textContent = JSON.stringify(data, null, 2);
        $("status").textContent = "Done";
      } catch (e) {
        $("status").textContent = "Error: " + e.message;
      }
    });
  </script>
</body>
</html>
  `);
});

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});

