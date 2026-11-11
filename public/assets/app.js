const $ = (selector) => document.querySelector(selector);
const icon = (name) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const SOURCES = {
  westfalen: {
    name: "FLVW · Westfalen",
    short: "Westfalen",
    mark: "FLVW",
    url: "https://flvw.de/",
    description: "Fußball, Leichtathletik und Verbandsleben in Westfalen.",
  },
  gladbeck: {
    name: "Stadt Gladbeck",
    short: "Gladbeck",
    mark: "GLA",
    url: "https://www.gladbeck.de/",
    description: "Nachrichten und Meldungen aus dem Gladbecker Stadtleben.",
  },
  gelsenkirchen: {
    name: "Stadt Gelsenkirchen",
    short: "Gelsenkirchen",
    mark: "GE",
    url: "https://www.gelsenkirchen.de/",
    description: "Stadtleben, Veranstaltungen und Neues aus Gelsenkirchen.",
  },
  fussball: {
    name: "FUSSBALL.DE",
    short: "Fußball",
    mark: "FUSSBALL",
    url: "https://www.fussball.de/",
    description: "Amateurfußball, Vereinsgeschichten und Themen vom Platz.",
  },
};
const state = {
  items: [],
  sources: [],
  filter: "all",
  search: "",
  sort: "newest",
  savedOnly: false,
  saved: new Map(),
  visible: 9,
  loading: false,
  loaded: false,
  failed: false,
  updatedAt: null,
  weatherLoading: false,
};
let toastTimer;
let currentArticle = null;
let previousFocus = null;

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
function articleDate(value) {
  const date = validDate(value);
  return date
    ? new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Europe/Berlin",
      }).format(date)
    : "Ohne Datumsangabe";
}
function timeLabel(value) {
  const date = validDate(value);
  return date
    ? new Intl.DateTimeFormat("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Berlin",
      }).format(date)
    : "—";
}
function sourceOf(item) {
  return (
    SOURCES[item.sourceKey] || {
      name: item.source || "Weitere Quelle",
      short: "Nachricht",
      mark: "NEWS",
    }
  );
}
function normalize(item) {
  if (
    !item ||
    typeof item !== "object" ||
    typeof item.title !== "string" ||
    !item.title.trim()
  )
    return null;
  const url = safeUrl(item.url);
  if (!url) return null;
  return {
    url,
    title: item.title.trim(),
    summary: typeof item.summary === "string" ? item.summary : "",
    image: safeUrl(item.image),
    sourceKey: Object.hasOwn(SOURCES, item.sourceKey)
      ? item.sourceKey
      : "other",
    source: typeof item.source === "string" ? item.source : "",
    pubDate: validDate(item.pubDate)?.toISOString() || null,
    regional: item.regional === true,
  };
}
function readSaved() {
  try {
    const data = JSON.parse(localStorage.getItem("wf-saved-articles") || "[]");
    if (Array.isArray(data))
      for (const raw of data.slice(0, 200)) {
        const item = normalize(raw);
        if (item) state.saved.set(item.url, item);
      }
  } catch {
    /* A blocked or corrupted local store must not prevent reading the news. */
  }
}
function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3200);
}
function updateSavedState() {
  $("#savedCount").textContent = state.saved.size;
  $("#savedToggle").setAttribute("aria-pressed", String(state.savedOnly));
  $("#savedToggle").setAttribute(
    "aria-label",
    `${state.savedOnly ? "Alle Nachrichten anzeigen" : "Merkliste öffnen"} · ${state.saved.size} gespeicherte Meldungen`,
  );
  $("#savedNotice").hidden = !state.savedOnly;
}
function toggleSaved(url) {
  const item =
    state.items.find((entry) => entry.url === url) ||
    state.saved.get(url) ||
    (currentArticle?.url === url ? currentArticle : null);
  if (!item) return;
  const wasSaved = state.saved.has(url);
  if (wasSaved) state.saved.delete(url);
  else if (state.saved.size >= 200) {
    notify("Deine Merkliste enthält bereits 200 Meldungen.");
    return;
  } else state.saved.set(url, item);
  let persistent = true;
  try {
    localStorage.setItem(
      "wf-saved-articles",
      JSON.stringify([...state.saved.values()]),
    );
  } catch {
    persistent = false;
  }
  const restoreFocus =
    state.savedOnly && document.activeElement?.matches("#newsGrid [data-save]");
  updateSavedState();
  updateFilters();
  if (state.savedOnly) {
    renderFeed();
    if (restoreFocus) ($("#newsGrid [data-save]") || $("#savedToggle")).focus();
  } else
    document
      .querySelectorAll("[data-save]")
      .forEach((button) => updateBookmark(button));
  if (currentArticle)
    document
      .querySelectorAll("#articleDialog [data-save]")
      .forEach((button) => updateBookmark(button));
  notify(
    persistent
      ? wasSaved
        ? "Aus deiner Merkliste entfernt."
        : "Für später gemerkt."
      : "Merkliste nur für diese Sitzung verfügbar.",
  );
}
function bookmark(item) {
  return `<button class="bookmark" data-save="${escape(item.url)}" aria-pressed="${state.saved.has(item.url)}" aria-label="${state.saved.has(item.url) ? "Aus Merkliste entfernen" : "Artikel merken"}: ${escape(item.title)}">${icon("bookmark")}</button>`;
}
function updateBookmark(button) {
  const saved = state.saved.has(button.dataset.save);
  const item =
    state.items.find((entry) => entry.url === button.dataset.save) ||
    state.saved.get(button.dataset.save) ||
    currentArticle;
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute(
    "aria-label",
    `${saved ? "Aus Merkliste entfernen" : "Artikel merken"}: ${item?.title || "Artikel"}`,
  );
}
function setSavedOnly(enabled) {
  state.savedOnly = enabled;
  state.visible = 9;
  state.filter = "all";
  state.search = "";
  $("#searchInput").value = "";
  updateFilters();
  updateSavedState();
  renderFeed();
  $("#nachrichten").scrollIntoView({ behavior: "smooth" });
}
function chooseFilter(filter, scroll = false) {
  if (filter !== "all" && !Object.hasOwn(SOURCES, filter)) return;
  state.filter = filter;
  state.visible = 9;
  updateFilters();
  renderFeed();
  if (scroll) $("#nachrichten").scrollIntoView({ behavior: "smooth" });
}
function updateFilters() {
  const pool = state.savedOnly ? [...state.saved.values()] : state.items;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const active = button.dataset.filter === state.filter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-count]").forEach((element) => {
    element.textContent = pool.filter(
      (item) =>
        element.dataset.count === "all" ||
        item.sourceKey === element.dataset.count,
    ).length;
  });
}
function filteredItems() {
  const pool = state.savedOnly
    ? [...state.saved.values()].map(
        (saved) => state.items.find((item) => item.url === saved.url) || saved,
      )
    : [...state.items];
  const query = state.search.trim().toLocaleLowerCase("de-DE");
  return pool
    .filter(
      (item) =>
        (state.filter === "all" || item.sourceKey === state.filter) &&
        (!query ||
          `${item.title} ${item.summary} ${sourceOf(item).name}`
            .toLocaleLowerCase("de-DE")
            .includes(query)),
    )
    .sort((a, b) => {
      if (state.sort === "source") {
        const order = sourceOf(a).name.localeCompare(sourceOf(b).name, "de");
        if (order) return order;
      }
      const ad = validDate(a.pubDate)?.getTime(),
        bd = validDate(b.pubDate)?.getTime();
      if (ad === undefined && bd === undefined)
        return a.title.localeCompare(b.title, "de");
      if (ad === undefined) return 1;
      if (bd === undefined) return -1;
      return state.sort === "oldest" ? ad - bd : bd - ad;
    });
}
function sourceVisual(item) {
  const source = sourceOf(item);
  return `<div class="card-placeholder" data-source="${escape(item.sourceKey)}" aria-hidden="true"><small>MELDUNGEN AUS DER QUELLE</small><strong>${escape(source.mark)}</strong></div>`;
}
function articleCard(item) {
  const source = sourceOf(item);
  return `<article class="news-card"><div class="card-image-wrap">${sourceVisual(item)}${item.image ? `<img src="${escape(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="image-source-label">Bild aus dem Quellenbeitrag</span>` : ""}</div><div class="card-content"><div class="card-meta"><span class="source-tag">${escape(source.short)}</span><span aria-hidden="true">/</span>${item.pubDate ? `<time datetime="${escape(item.pubDate)}">${escape(articleDate(item.pubDate))}</time>` : "<span>Ohne Datumsangabe</span>"}</div><h3 class="card-title"><button data-open="${escape(item.url)}">${escape(item.title)}</button></h3><p class="card-summary">${escape(item.summary || "Die Quelle stellt für diesen Beitrag keinen Kurztext bereit. Den Artikel findest du beim Herausgeber.")}</p><div class="card-spacer"></div><div class="card-footer"><a class="text-link" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="Originalartikel bei ${escape(source.name)} öffnen: ${escape(item.title)}">${escape(source.name)} ${icon("external")}</a>${bookmark(item)}</div></div></article>`;
}
function renderFeed() {
  if (!state.loaded && !state.savedOnly) return;
  const items = filteredItems();
  const displayed = items.slice(0, state.visible);
  $("#resultCount").textContent =
    `${items.length} ${items.length === 1 ? "Meldung" : "Meldungen"}${state.search ? " gefunden" : ""}`;
  $("#newsGrid").setAttribute("aria-busy", "false");
  $("#loadMore").hidden = displayed.length >= items.length;
  if (!items.length) {
    const hasFilters = state.search.trim() || state.filter !== "all";
    let title = "Dazu gibt es gerade keine Treffer.";
    let text =
      "Versuche einen anderen Suchbegriff oder wähle eine andere Quelle.";
    if (state.savedOnly && !state.saved.size) {
      title = "Platz für deine Fundstücke.";
      text =
        "Tippe bei einer Meldung auf das Lesezeichen. Du findest sie dann hier wieder — auch nach einem Neuladen.";
    } else if (!hasFilters && state.failed) {
      title = "Der Newsfeed ist gerade nicht erreichbar.";
      text =
        "Bitte versuche es noch einmal. Die Originalquellen findest du weiter unten.";
    } else if (!hasFilters) {
      title = "Noch keine Meldungen verfügbar.";
      text = "Sobald die Quellen Beiträge liefern, erscheinen sie hier.";
    }
    $("#newsGrid").innerHTML =
      `<div class="empty-state">${icon(state.savedOnly ? "bookmark" : "search")}<h3>${escape(title)}</h3><p>${escape(text)}</p><button class="button button-outline" data-empty-action="${hasFilters ? "reset" : state.savedOnly ? "all" : "retry"}">${hasFilters ? "Filter zurücksetzen" : state.savedOnly ? "Nachrichten entdecken" : "Erneut versuchen"} ${icon("arrow")}</button></div>`;
    return;
  }
  $("#newsGrid").innerHTML = displayed.map(articleCard).join("");
  $("#newsGrid")
    .querySelectorAll("img")
    .forEach((img) => {
      img.addEventListener(
        "error",
        () => {
          img.hidden = true;
          const label = img.parentElement.querySelector(".image-source-label");
          if (label) label.hidden = true;
        },
        { once: true },
      );
      if (img.complete && !img.naturalWidth) {
        img.hidden = true;
        const label = img.parentElement.querySelector(".image-source-label");
        if (label) label.hidden = true;
      }
    });
}
function renderBriefing() {
  const items = state.items.slice(0, 2);
  $("#briefing").innerHTML = items.length
    ? items
        .map(
          (item, i) =>
            `<button class="briefing-item" data-open="${escape(item.url)}"><span aria-hidden="true">0${i + 1}</span><div><small>${escape(sourceOf(item).name)} · ${escape(articleDate(item.pubDate))}</small><strong>${escape(item.title)}</strong></div></button>`,
        )
        .join("")
    : '<p class="muted">Noch keine Schlagzeilen verfügbar. Die Quellen werden beim nächsten Abruf erneut geprüft.</p>';
}
function renderSources() {
  const statusLabels = {
    ok: "Erreichbar",
    empty: "Keine Beiträge",
    partial: "Teilweise verfügbar",
    stale: "Letzter Stand",
    error: "Nicht erreichbar",
  };
  $("#sourceGrid").innerHTML = Object.entries(SOURCES)
    .map(([key, source]) => {
      const health = state.sources.find((entry) => entry.key === key);
      const count =
        health?.count ??
        state.items.filter((item) => item.sourceKey === key).length;
      const status = state.failed
        ? count
          ? "stale"
          : "error"
        : health?.status || (state.loaded && count ? "ok" : "loading");
      const warning = ["partial", "stale", "error"].includes(status);
      return `<article class="source-card"><div class="source-card-top"><span class="source-initial">${escape(source.mark)}</span><span class="source-badge ${status === "ok" ? "ok" : warning ? "warn" : ""}">${statusLabels[status] || "Wird geprüft"}</span></div><h3>${escape(source.name)}</h3><p class="source-description">${escape(source.description)}</p><div class="source-card-count">${state.loaded ? `${count} ${count === 1 ? "Beitrag" : "Beiträge"}` : "Abruf läuft"}${health?.updatedAt ? ` · Abgerufen ${escape(timeLabel(health.updatedAt))}` : ""}</div>${warning ? `<p class="source-error">${status === "stale" ? "Gespeicherte Meldungen bleiben verfügbar." : status === "partial" ? "Ein Teil der Quelle ist momentan nicht verfügbar." : "Bitte später erneut versuchen."}</p>` : ""}<a href="${source.url}" target="_blank" rel="noopener noreferrer">Zur Quelle ${icon("external")}</a></article>`;
    })
    .join("");
}
function openArticle(url) {
  const item =
    state.items.find((entry) => entry.url === url) || state.saved.get(url);
  if (!item) return;
  currentArticle = item;
  previousFocus = document.activeElement;
  $("#dialogContent").innerHTML =
    `<div class="dialog-body"><div class="card-meta"><span class="source-tag">${escape(sourceOf(item).name)}</span><span aria-hidden="true">/</span><span>${escape(articleDate(item.pubDate))}</span></div><h2 id="dialogTitle">${escape(item.title)}</h2><p class="dialog-summary">${escape(item.summary || "Für diese Meldung hat der Herausgeber keinen Kurztext bereitgestellt.")}</p><p class="dialog-note">Dies ist der Kurztext aus der Quelle. Der vollständige Beitrag und sein Kontext sind beim Herausgeber verfügbar. Worldfootball ist nicht die Redaktion dieses Artikels.</p><div class="dialog-actions"><a class="button button-lime" href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">Originalartikel lesen ${icon("external")}</a>${bookmark(item)}</div></div>`;
  $("#articleDialog").showModal();
  document.body.classList.add("modal-open");
}
async function jsonRequest(url) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function loadNews() {
  if (state.loading) return;
  state.loading = true;
  $("#refreshButton").disabled = true;
  $("#fetchStatus").textContent = "Quellen werden abgerufen …";
  try {
    const data = await jsonRequest("/api/news");
    if (!Array.isArray(data.items)) throw new Error("Invalid news response");
    const unique = new Map();
    for (const raw of data.items) {
      const item = normalize(raw);
      if (item && !unique.has(item.url)) unique.set(item.url, item);
    }
    state.items = [...unique.values()];
    state.sources = Array.isArray(data.sources)
      ? data.sources.filter((entry) => entry && typeof entry === "object")
      : [];
    state.updatedAt = data.updatedAt;
    state.failed = false;
    const date = validDate(data.updatedAt);
    $("#fetchStatus").textContent = date
      ? `Zuletzt abgerufen · ${timeLabel(date)}`
      : "Abruf abgeschlossen";
    const affected = state.sources.filter((source) =>
      ["partial", "stale", "error"].includes(source.status),
    );
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const notice = $("#feedNotice");
    notice.hidden = !affected.length && !errors.length;
    if (!notice.hidden)
      notice.innerHTML = `Einige Quellen sind momentan nicht vollständig erreichbar. Verfügbare Meldungen bleiben sichtbar. <a href="#quellen">Quellenstatus ansehen</a>`;
  } catch {
    state.failed = true;
    $("#fetchStatus").textContent = "Abruf nicht möglich";
    $("#feedNotice").hidden = false;
    $("#feedNotice").textContent = state.items.length
      ? `Die Aktualisierung ist fehlgeschlagen. Du siehst den letzten geladenen Stand${state.updatedAt ? ` von ${timeLabel(state.updatedAt)} Uhr` : ""}.`
      : "Der Newsfeed konnte nicht geladen werden. Prüfe deine Verbindung und versuche es erneut.";
  } finally {
    state.loading = false;
    state.loaded = true;
    $("#refreshButton").disabled = false;
    updateFilters();
    renderFeed();
    renderBriefing();
    renderSources();
  }
}
function weatherDescription(code, day = true) {
  if (code === 0) return { label: "Klar", icon: day ? "sun" : "moon" };
  if ([1, 2].includes(code))
    return { label: "Leicht bewölkt", icon: day ? "sun" : "moon" };
  if (code === 3) return { label: "Bewölkt", icon: "cloud" };
  if ([45, 48].includes(code)) return { label: "Nebel", icon: "cloud" };
  if ([51, 53, 55, 56, 57].includes(code))
    return { label: "Nieselregen", icon: "rain" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code))
    return { label: "Regen", icon: "rain" };
  if ([71, 73, 75, 77, 85, 86].includes(code))
    return { label: "Schnee", icon: "snow" };
  if ([95, 96, 99].includes(code)) return { label: "Gewitter", icon: "rain" };
  return { label: "Keine Wetterangabe", icon: "cloud" };
}
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : "—";
async function loadWeather() {
  if (state.weatherLoading) return;
  state.weatherLoading = true;
  try {
    const data = await jsonRequest("/api/weather");
    if (!data.current || typeof data.current.temperature !== "number")
      throw new Error("Weather unavailable");
    const current = data.current,
      description = weatherDescription(current.code, current.isDay);
    const forecast = Array.isArray(data.forecast)
      ? data.forecast.slice(0, 4)
      : [];
    $("#weatherContent").innerHTML =
      `<div class="weather-now"><div><div class="weather-temp">${number(current.temperature)}<sup>°C</sup></div><p class="weather-condition">${description.label} · gefühlt ${number(current.feelsLike)}°</p></div>${icon(description.icon)}</div><div class="weather-detail"><span>${icon("wind")} ${number(current.wind)} km/h</span><span>Luftfeuchte ${number(current.humidity)} %</span></div><div class="forecast">${forecast
        .map((day) => {
          const date =
            typeof day.date === "string"
              ? validDate(`${day.date}T12:00:00Z`)
              : null;
          const label = date
            ? new Intl.DateTimeFormat("de-DE", {
                weekday: "short",
                timeZone: "Europe/Berlin",
              }).format(date)
            : "—";
          const desc = weatherDescription(day.code);
          return `<div class="forecast-day" aria-label="${escape(label)}: ${desc.label}, maximal ${number(day.max)} Grad, minimal ${number(day.min)} Grad"><span>${escape(label)}</span>${icon(desc.icon)}<span><strong>${number(day.max)}°</strong><span class="low">${number(day.min)}°</span></span></div>`;
        })
        .join(
          "",
        )}</div><p class="weather-credit">${data.error ? "Letzter verfügbarer Stand · Aktualisierung fehlgeschlagen" : `Datenstand ${escape(typeof current.time === "string" ? current.time.slice(11, 16) : timeLabel(data.updatedAt))} Uhr · Europe/Berlin`}</p>`;
  } catch {
    $("#weatherContent").innerHTML =
      `<div class="weather-error"><p>Das Wetter ist gerade nicht verfügbar.</p><button class="text-link" data-weather-retry>Erneut laden ${icon("refresh")}</button></div>`;
  } finally {
    state.weatherLoading = false;
  }
}
function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#themeToggle").innerHTML = icon(dark ? "sun" : "moon");
  $("#themeToggle").setAttribute(
    "aria-label",
    dark ? "Helle Ansicht aktivieren" : "Dunkle Ansicht aktivieren",
  );
  document.querySelector('meta[name="theme-color"]').content = dark
    ? "#131813"
    : "#f5f5ef";
}

readSaved();
updateSavedState();
updateThemeButton();
renderSources();
const today = new Date();
$("#editionDate").textContent = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Berlin",
}).format(today);
$("#editionDate").dateTime = today.toISOString();
$("#copyrightYear").textContent = today.getFullYear();
$("#themeToggle").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("wf-theme", theme);
  } catch {}
  updateThemeButton();
});
$("#sourceFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (button) chooseFilter(button.dataset.filter);
});
$("#searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  state.visible = 9;
  renderFeed();
});
$("#sortOrder").addEventListener("change", (event) => {
  state.sort = event.target.value;
  state.visible = 9;
  renderFeed();
});
$("#savedToggle").addEventListener("click", () =>
  setSavedOnly(!state.savedOnly),
);
$("#showAllButton").addEventListener("click", () => setSavedOnly(false));
$("#refreshButton").addEventListener("click", loadNews);
$("#loadMore").addEventListener("click", () => {
  state.visible += 9;
  renderFeed();
});
$("#closeDialog").addEventListener("click", () => $("#articleDialog").close());
$("#articleDialog").addEventListener("close", () => {
  document.body.classList.remove("modal-open");
  currentArticle = null;
  (previousFocus?.isConnected ? previousFocus : $("#savedToggle")).focus();
});
$("#articleDialog").addEventListener("click", (event) => {
  if (event.target === $("#articleDialog")) {
    const rect = event.target.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      event.target.close();
  }
});
document.addEventListener("click", (event) => {
  const save = event.target.closest("[data-save]");
  if (save) {
    toggleSaved(save.dataset.save);
    return;
  }
  const open = event.target.closest("[data-open]");
  if (open) {
    openArticle(open.dataset.open);
    return;
  }
  const region = event.target.closest("[data-region-filter]");
  if (region) {
    state.savedOnly = false;
    state.search = "";
    $("#searchInput").value = "";
    updateSavedState();
    chooseFilter(region.dataset.regionFilter, true);
    return;
  }
  if (event.target.closest("[data-weather-retry]")) loadWeather();
  const empty = event.target.closest("[data-empty-action]");
  if (!empty) return;
  if (empty.dataset.emptyAction === "retry") loadNews();
  else if (empty.dataset.emptyAction === "all") setSavedOnly(false);
  else {
    state.search = "";
    $("#searchInput").value = "";
    chooseFilter("all");
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "/" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !$("#articleDialog").open &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
  ) {
    event.preventDefault();
    $("#searchInput").focus();
  }
});
window.addEventListener("online", () => {
  if (state.failed) loadNews();
});
loadNews();
loadWeather();
setInterval(
  () => {
    if (!document.hidden) {
      loadNews();
      loadWeather();
    }
  },
  5 * 60 * 1000,
);
