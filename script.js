// SkyCheck – live weather using Open-Meteo (no API key required)
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const STORAGE_KEY = "skycheck_recent";
const MAX_RECENT = 3;
const TIMEOUT_MS = 10000;

// ---------- DOM ----------
const form = document.getElementById("search-form");
const input = document.getElementById("city");
const btn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const recentWrap = document.getElementById("recent-wrap");
const recentList = document.getElementById("recent-list");

let requestId = 0; // used to ignore outdated responses

// ---------- WMO weather codes ----------
function describe(code, isDay) {
  const day = isDay === 1;
  if (code === 0) return day ? ["Clear sky", "☀️"] : ["Clear night", "🌙"];
  if (code === 1) return day ? ["Mostly clear", "🌤️"] : ["Mostly clear", "🌙"];
  if (code === 2) return ["Partly cloudy", "⛅"];
  if (code === 3) return ["Overcast", "☁️"];
  if (code === 45 || code === 48) return ["Fog", "🌫️"];
  if (code >= 51 && code <= 57) return ["Drizzle", "🌦️"];
  if (code >= 61 && code <= 67) return ["Rain", "🌧️"];
  if (code >= 71 && code <= 77) return ["Snow", "❄️"];
  if (code >= 80 && code <= 82) return ["Rain showers", "🌧️"];
  if (code === 85 || code === 86) return ["Snow showers", "🌨️"];
  if (code >= 95) return ["Thunderstorm", "⛈️"];
  return ["Unknown", "🌡️"];
}

// ---------- Helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round = n => Math.round(n);

// Custom error so we can show friendly messages
class AppError extends Error {}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new AppError("The weather service is having problems. Please try again later.");
    return await res.json();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err.name === "AbortError") throw new AppError("The request took too long. Please try again.");
    throw new AppError("Network error. Check your internet connection and try again.");
  } finally {
    clearTimeout(timer);
  }
}

// ---------- API calls ----------
async function findPlace(query) {
  // "Paris, France" -> search "Paris", then prefer a match for "France"
  const [namePart, hint] = query.split(",").map(s => s.trim());
  const url = `${GEO_URL}?name=${encodeURIComponent(namePart)}&count=5&language=en&format=json`;
  const data = await fetchJSON(url);
  if (!data.results || data.results.length === 0) {
    throw new AppError(`"${namePart}" not found. Check the spelling and try again.`);
  }
  let match = data.results[0];
  if (hint) {
    const h = hint.toLowerCase();
    const better = data.results.find(r =>
      (r.country || "").toLowerCase().includes(h) || (r.admin1 || "").toLowerCase().includes(h));
    if (better) match = better;
  }
  return {
    id: `${match.latitude.toFixed(3)},${match.longitude.toFixed(3)}`,
    name: match.name,
    region: [match.admin1, match.country].filter(Boolean).join(", "),
    lat: match.latitude,
    lon: match.longitude
  };
}

async function getWeather(place) {
  const params = new URLSearchParams({
    latitude: place.lat,
    longitude: place.lon,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    forecast_days: 5
  });
  const data = await fetchJSON(`${WEATHER_URL}?${params}`);
  if (!data.current || !data.daily) throw new AppError("Weather data is not available for this place.");
  return {
    current: {
      temp: data.current.temperature_2m,
      feels: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      wind: data.current.wind_speed_10m,
      code: data.current.weather_code,
      isDay: data.current.is_day
    },
    days: data.daily.time.map((date, i) => ({
      date,
      code: data.daily.weather_code[i],
      max: data.daily.temperature_2m_max[i],
      min: data.daily.temperature_2m_min[i]
    }))
  };
}

// ---------- localStorage (last 3 searches) ----------
function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveRecent(place, weather) {
  const entry = { place, weather, savedAt: Date.now() };
  const list = loadRecent().filter(e => e.place.id !== place.id);
  list.unshift(entry);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT))); }
  catch { /* storage full or blocked – app still works */ }
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  recentWrap.hidden = list.length === 0;
  recentList.innerHTML = list.map((e, i) => `
    <button class="chip" type="button" data-index="${i}">
      ${esc(e.place.name)}<small>${round(e.weather.current.temp)}°</small>
    </button>`).join("");
}

// ---------- Rendering ----------
function showLoading() {
  resultEl.innerHTML = "";
  statusEl.innerHTML = `<div class="loading"><div class="spinner" role="status"></div><span>Fetching weather…</span></div>`;
  btn.disabled = true;
}
function showError(msg) {
  resultEl.innerHTML = "";
  statusEl.innerHTML = `<div class="error" role="alert">${esc(msg)}</div>`;
}
function clearStatus() { statusEl.innerHTML = ""; btn.disabled = false; }

function renderWeather(place, w, { notice = "", savedAt = null } = {}) {
  const [label, emoji] = describe(w.current.code, w.current.isDay);
  document.body.dataset.theme = w.current.isDay === 1 ? "day" : "night";

  const days = w.days.map((d, i) => {
    const name = i === 0 ? "Today" : new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
    const [dl, de] = describe(d.code, 1);
    return `<div class="day" title="${esc(dl)}">
      <div class="d">${esc(name)}</div><div class="i">${de}</div>
      <div class="hi">${round(d.max)}°</div><div class="lo">${round(d.min)}°</div></div>`;
  }).join("");

  resultEl.innerHTML = `
    ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
    <article class="weather-card">
      <div class="place">${esc(place.name)}</div>
      <div class="region">${esc(place.region)}</div>
      <div class="now">
        <div class="icon" aria-hidden="true">${emoji}</div>
        <div>
          <div class="temp">${round(w.current.temp)}°C</div>
          <div class="cond">${esc(label)}</div>
          <div class="feels">Feels like ${round(w.current.feels)}°C</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><span>Humidity</span><b>${round(w.current.humidity)}%</b></div>
        <div class="stat"><span>Wind</span><b>${round(w.current.wind)} km/h</b></div>
      </div>
      <div class="forecast"><h3>5-day forecast</h3><div class="days">${days}</div></div>
      ${savedAt ? `<div class="saved-at">Saved copy from ${new Date(savedAt).toLocaleString()}</div>` : ""}
    </article>`;
}

// ---------- Main flow ----------
async function searchCity(query) {
  const id = ++requestId;
  showLoading();
  try {
    const place = await findPlace(query);
    const weather = await getWeather(place);
    if (id !== requestId) return;           // a newer search started
    clearStatus();
    renderWeather(place, weather);
    saveRecent(place, weather);
  } catch (err) {
    if (id !== requestId) return;
    btn.disabled = false;
    showError(err instanceof AppError ? err.message : "Something went wrong. Please try again.");
  }
}

// Re-fetch a recent place; fall back to the saved copy if offline
async function openRecent(index) {
  const entry = loadRecent()[index];
  if (!entry) return;
  const id = ++requestId;
  showLoading();
  try {
    const weather = await getWeather(entry.place);
    if (id !== requestId) return;
    clearStatus();
    renderWeather(entry.place, weather);
    saveRecent(entry.place, weather);
  } catch (err) {
    if (id !== requestId) return;
    clearStatus();
    renderWeather(entry.place, entry.weather, {
      notice: "Could not get live data, so this is your last saved result.",
      savedAt: entry.savedAt
    });
  }
}

// ---------- Events ----------
form.addEventListener("submit", e => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) { showError("Please type a city name first."); input.focus(); return; }
  searchCity(query);
});

recentList.addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (chip) openRecent(Number(chip.dataset.index));
});

// ---------- Startup: show recent searches and the latest saved result ----------
renderRecent();
const saved = loadRecent();
if (saved.length) {
  renderWeather(saved[0].place, saved[0].weather, { savedAt: saved[0].savedAt });
  openRecent(0); // refresh it in the background with live data
}
