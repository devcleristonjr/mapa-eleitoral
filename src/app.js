const DATA_URL = "../data/processed/dados.json";
const GEOJSON_URL = "../data/geo/bahia-municipios.geojson";
const EXPECTED_MUNICIPALITIES = 417;
const CANDIDATE_COLOR_GROUPS = {
  presidente: { lula: "red", bolsonaro: "blue", "flavio bolsonaro": "blue" },
  governador: {
    "jeronimo rodrigues": "red",
    "jeronimo rodrigues (pt)": "red",
    "acm neto": "blue",
    "acm neto (uniao)": "blue",
  },
};
const COLOR_RANGES = {
  red: { low: [244, 196, 190], high: [164, 18, 39] },
  blue: { low: [192, 220, 243], high: [29, 78, 143] },
};

const state = {
  year: "2026",
  election: "presidente",
  recordsByCode: new Map(),
  map: null,
  municipalityLayer: null,
  activeTooltipLayer: null,
  fullBounds: null,
  selectedLayer: null,
};

const elements = {
  map: document.querySelector("#map"),
  mapStatus: document.querySelector("#map-status"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#municipality-search"),
  municipalityOptions: document.querySelector("#municipality-options"),
  resetMap: document.querySelector("#reset-map"),
  panel: document.querySelector("#municipality-panel"),
  panelTitle: document.querySelector("#panel-title"),
  panelHint: document.querySelector("#panel-hint"),
  panelContent: document.querySelector("#panel-content"),
};

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("pt-BR");
}

async function fetchJson(url, friendlyError) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(friendlyError);
  }
  return response.json();
}

async function loadData() {
  const records = await fetchJson(DATA_URL, "Não foi possível carregar os dados eleitorais.");
  if (!Array.isArray(records)) {
    throw new TypeError("O arquivo de dados eleitorais está em formato inválido.");
  }
  state.recordsByCode = new Map(records.map((record) => [Number(record.ibge), record]));
  if (state.recordsByCode.size !== records.length) {
    throw new Error("Existem códigos IBGE duplicados nos dados eleitorais.");
  }
  populateSearchOptions(records);
  updateDashboard(records);
  return records;
}

async function loadGeoJSON() {
  return fetchJson(GEOJSON_URL, "Não foi possível carregar a malha municipal.");
}

function initializeMap() {
  state.map = L.map(elements.map, {
    zoomControl: true,
    attributionControl: false,
    scrollWheelZoom: true,
    keyboard: true,
  });
  elements.map.addEventListener("mouseleave", closeActiveTooltip);
  L.control.attribution({ prefix: false }).addAttribution('Malha municipal <a href="https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais.html" target="_blank" rel="noreferrer">IBGE</a>').addTo(state.map);
}

function getRecordForFeature(feature) {
  const code = Number(feature.properties?.code);
  const record = state.recordsByCode.get(code);
  if (!record) {
    console.warn(`Município sem correspondência: ${feature.properties?.municipio ?? code}`);
  }
  return record;
}

function getElectionData(record, election = state.election) {
  return record?.anos?.[state.year]?.[election] ?? null;
}

function getCandidateColorGroup(candidate, election = state.election) {
  const normalizedCandidate = normalizeName(candidate);
  return CANDIDATE_COLOR_GROUPS[election]?.[normalizedCandidate] ?? null;
}

function getColor(percentual, candidate, election = state.election) {
  if (typeof percentual !== "number" || !Number.isFinite(percentual)) {
    return "#cbd3ce";
  }
  const group = getCandidateColorGroup(candidate, election);
  if (!group) {
    return "#cbd3ce";
  }

  const value = Math.max(0, Math.min(100, percentual));
  const range = COLOR_RANGES[group];
  const amount = value / 100;
  const color = range.low.map((channel, index) => Math.round(channel + (range.high[index] - channel) * amount));
  return colorString(color);
}

function colorString(channels) {
  return `rgb(${channels.join(", ")})`;
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Dados não disponíveis";
  }
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatElectors(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Dados não disponíveis";
  }
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value);
}

function styleFeature(feature) {
  const record = getRecordForFeature(feature);
  const electionData = getElectionData(record);
  return {
    color: "#f8faf7",
    weight: 0.75,
    opacity: 1,
    fillColor: getColor(electionData?.percentual, electionData?.candidato),
    fillOpacity: 0.88,
  };
}

function renderMunicipalities(geojson) {
  if (geojson?.type !== "FeatureCollection" || !Array.isArray(geojson.features)) {
    throw new Error("A malha municipal está em formato inválido.");
  }
  if (geojson.features.length !== EXPECTED_MUNICIPALITIES) {
    throw new Error(`A malha municipal deveria conter ${EXPECTED_MUNICIPALITIES} municípios.`);
  }

  const matchedCount = geojson.features.filter((feature) => getRecordForFeature(feature)).length;
  if (matchedCount !== EXPECTED_MUNICIPALITIES) {
    elements.mapStatus.textContent = `${matchedCount} de ${EXPECTED_MUNICIPALITIES} municípios associados`;
  }

  state.municipalityLayer = L.geoJSON(geojson, {
    style: styleFeature,
    onEachFeature: configureFeature,
  }).addTo(state.map);
  state.fullBounds = state.municipalityLayer.getBounds();
  state.map.fitBounds(state.fullBounds, { padding: [18, 18] });
  if (matchedCount === EXPECTED_MUNICIPALITIES) {
    elements.mapStatus.textContent = `417 municípios · ${state.year} · selecione uma área para ver os resultados`;
  }
}

function configureFeature(feature, layer) {
  const record = getRecordForFeature(feature);
  if (!record) {
    return;
  }
  const municipality = record.municipio;
  layer.bindTooltip(() => createTooltip(record), { sticky: true, direction: "top", offset: [0, -8], opacity: 1 });
  layer.on({
    click: () => showMunicipality(record, layer),
    mouseover: () => {
      closeActiveTooltip();
      state.activeTooltipLayer = layer;
      layer.openTooltip();
      highlightFeature(layer);
    },
    mouseout: () => {
      if (state.activeTooltipLayer === layer) {
        closeActiveTooltip();
      }
      resetFeatureStyle(layer);
    },
  });
  layer.on("add", () => makeFeatureKeyboardAccessible(layer, record));
  layer.options.title = municipality;
}

function createTooltip(record) {
  const tooltip = document.createElement("div");
  const name = document.createElement("div");
  const details = document.createElement("div");
  const percent = document.createElement("span");
  const candidate = document.createElement("span");
  const bar = document.createElement("div");
  const electionData = getElectionData(record);
  const group = getCandidateColorGroup(electionData?.candidato);
  const value = Number(electionData?.percentual);
  tooltip.className = "tooltip-card";
  if (group) {
    tooltip.style.setProperty("--tip-color", colorString(COLOR_RANGES[group].high));
  }
  tooltip.style.setProperty("--tip-width", `${Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}%`);
  const header = document.createElement("div");
  const avatar = document.createElement("span");
  const titles = document.createElement("div");
  const electors = document.createElement("div");
  const action = document.createElement("div");
  header.className = "tooltip-header";
  avatar.className = "tooltip-avatar";
  avatar.textContent = (electionData?.candidato || record.municipio).charAt(0).toUpperCase();
  name.className = "tooltip-name";
  name.textContent = record.municipio;
  electors.className = "tooltip-meta";
  const presidentData = getElectionData(record, "presidente");
  electors.textContent = `${formatElectors(presidentData?.eleitores ?? presidentData?.total_votos)} ${state.year === "2022" ? "votos apurados" : "eleitores"}`;
  titles.append(name, electors);
  header.append(avatar, titles);
  details.className = "tooltip-sub";
  percent.className = "tooltip-percent";
  percent.textContent = formatPercent(electionData?.percentual);
  candidate.textContent = electionData?.candidato || "";
  details.append(percent, candidate);
  bar.className = "tooltip-bar";
  bar.append(document.createElement("span"));
  action.className = "tooltip-action";
  action.textContent = "Ver detalhes →";
  tooltip.append(header, details, bar, action);
  return tooltip;
}

function makeFeatureKeyboardAccessible(layer, record) {
  const path = layer.getElement();
  if (!path || path.dataset.keyboardReady) {
    if (path) {
      path.setAttribute("aria-label", `${record.municipio}, ${formatPercent(getElectionData(record)?.percentual)}`);
    }
    return;
  }
  path.dataset.keyboardReady = "true";
  path.setAttribute("tabindex", "0");
  path.setAttribute("role", "button");
  path.setAttribute("aria-label", `${record.municipio}, ${formatPercent(getElectionData(record)?.percentual)}`);
  path.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showMunicipality(record, layer);
    }
  });
}

function highlightFeature(layer) {
  layer.setStyle({ weight: 2, color: "#243a34", fillOpacity: 1 });
  layer.bringToFront();
  layer.getElement()?.classList.add("is-hover");
}

function closeActiveTooltip() {
  const activeLayer = state.activeTooltipLayer;
  state.activeTooltipLayer = null;
  activeLayer?.closeTooltip();
}

function resetFeatureStyle(layer) {
  layer.getElement()?.classList.remove("is-hover");
  if (state.municipalityLayer) {
    state.municipalityLayer.resetStyle(layer);
  }
  if (state.selectedLayer === layer) {
    layer.setStyle({ weight: 2, color: "#202c29" });
  }
}

function showMunicipality(record, layer) {
  if (state.selectedLayer && state.selectedLayer !== layer) {
    state.municipalityLayer.resetStyle(state.selectedLayer);
    state.selectedLayer.getElement()?.classList.remove("is-selected");
  }
  state.selectedLayer = layer;
  layer.getElement()?.classList.add("is-selected");
  layer.setStyle({ weight: 2, color: "#202c29", fillOpacity: 1 });
  elements.panelTitle.textContent = record.municipio;
  elements.panelHint.hidden = true;
  elements.panelContent.hidden = false;
  elements.panel.classList.add("is-open");
  renderMunicipalityPanel(record);
  animatePanelContent();
  document.querySelector("#panel-ibge").textContent = Number.isInteger(Number(record.ibge))
    ? String(record.ibge).padStart(7, "0")
    : "Dados não disponíveis";
  elements.mapStatus.textContent = `${record.municipio} selecionado`;
}

function animatePanelContent() {
  elements.panelContent.getAnimations().forEach((animation) => animation.cancel());
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  elements.panelContent.animate(
    [
      { opacity: 0, transform: "translateY(7px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)", fill: "both" },
  );
}

function renderElectionResult(prefix, electionData) {
  const election = prefix === "president" ? "presidente" : "governador";
  const candidateElement = document.querySelector(`#panel-${prefix}-candidate`);
  const percentElement = document.querySelector(`#panel-${prefix}-percent`);
  const detailsElement = document.querySelector(`#panel-${prefix}-details`);
  const group = getCandidateColorGroup(electionData?.candidato, election);
  candidateElement.textContent = electionData?.candidato || "Dados não disponíveis";
  percentElement.textContent = formatPercent(electionData?.percentual);
  percentElement.style.color = group ? colorString(COLOR_RANGES[group].high) : "";
  detailsElement.textContent = electionData?.segundo_candidato
    ? `${formatElectors(electionData.votos)} votos · 2º ${electionData.segundo_candidato}: ${formatElectors(electionData.votos_segundo)} (${formatPercent(electionData.percentual_segundo)}) · Brancos ${formatElectors(electionData.brancos)} · Nulos ${formatElectors(electionData.nulos)}`
    : "Contagens detalhadas não disponíveis nesta fonte.";
}

function renderMunicipalityPanel(record) {
  const presidentData = getElectionData(record, "presidente");
  document.querySelector("#panel-turnout-label").textContent = state.year === "2022" ? "Votos apurados" : "Eleitores";
  document.querySelector("#panel-electors").textContent = formatElectors(
    presidentData?.eleitores ?? presidentData?.total_votos,
  );
  renderElectionResult("president", presidentData);
  renderElectionResult("governor", getElectionData(record, "governador"));
}

function updateDashboard(records = [...state.recordsByCode.values()]) {
  const valid = records
    .map((record) => ({ record, percentage: getElectionData(record)?.percentual }))
    .filter(({ percentage }) => typeof percentage === "number" && Number.isFinite(percentage));
  const sorted = [...valid].sort((left, right) => left.percentage - right.percentage);
  const total = records.length;
  document.querySelector("#metric-count").textContent = new Intl.NumberFormat("pt-BR").format(total);
  document.querySelector("#metric-max").textContent = sorted.length ? formatPercent(sorted.at(-1).percentage) : "Dados não disponíveis";
  document.querySelector("#metric-min").textContent = sorted.length ? formatPercent(sorted[0].percentage) : "Dados não disponíveis";
  document.querySelector("#metric-max-city").textContent = sorted.at(-1)?.record.municipio ?? "";
  document.querySelector("#metric-min-city").textContent = sorted[0]?.record.municipio ?? "";
  const average = valid.length ? valid.reduce((sum, item) => sum + item.percentage, 0) / valid.length : null;
  document.querySelector("#metric-average").textContent = average === null ? "Dados não disponíveis" : formatPercent(average);
  document.querySelector("#metric-above").textContent = new Intl.NumberFormat("pt-BR").format(
    valid.filter((item) => item.percentage > 75).length,
  );
}

function populateSearchOptions(records) {
  const options = document.createDocumentFragment();
  [...records]
    .sort((left, right) => left.municipio.localeCompare(right.municipio, "pt-BR"))
    .forEach((record) => {
      const option = document.createElement("option");
      option.value = record.municipio;
      options.append(option);
    });
  elements.municipalityOptions.replaceChildren(options);
}

function searchMunicipality(query) {
  const normalized = normalizeName(query);
  if (!normalized) {
    return;
  }
  const match = [...state.recordsByCode.values()].find((record) => normalizeName(record.municipio) === normalized)
    ?? [...state.recordsByCode.values()].find((record) => normalizeName(record.municipio).startsWith(normalized));
  if (!match) {
    elements.mapStatus.textContent = "Município não encontrado";
    return;
  }
  const layer = findLayerByCode(match.ibge);
  if (!layer) {
    elements.mapStatus.textContent = "Não foi possível localizar esse município na malha.";
    return;
  }
  state.map.fitBounds(layer.getBounds(), { maxZoom: 9, padding: [42, 42] });
  showMunicipality(match, layer);
}

function findLayerByCode(code) {
  let result = null;
  state.municipalityLayer.eachLayer((layer) => {
    if (Number(layer.feature.properties.code) === Number(code)) {
      result = layer;
    }
  });
  return result;
}

function changeElection(election) {
  state.election = election;
  document.querySelectorAll(".election-button").forEach((button) => {
    const active = button.dataset.election === election;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateLegend();
  if (state.municipalityLayer) {
    state.municipalityLayer.setStyle(styleFeature);
    state.municipalityLayer.eachLayer((layer) => {
      const record = getRecordForFeature(layer.feature);
      if (record) {
        makeFeatureKeyboardAccessible(layer, record);
      }
    });
  }
  updateDashboard();
  refreshSelectedTooltip();
}

function changeYear(year) {
  if (year === state.year) {
    return;
  }
  state.year = year;
  document.querySelectorAll(".year-button").forEach((button) => {
    const active = button.dataset.year === year;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updateLegend();
  if (state.municipalityLayer) {
    state.municipalityLayer.setStyle(styleFeature);
    state.municipalityLayer.eachLayer((layer) => {
      const record = getRecordForFeature(layer.feature);
      if (record) {
        makeFeatureKeyboardAccessible(layer, record);
      }
    });
  }
  updateDashboard();
  if (!state.selectedLayer) {
    elements.mapStatus.textContent = `417 municípios · ${state.year} · selecione uma área para ver os resultados`;
  }
  if (state.selectedLayer) {
    const record = getRecordForFeature(state.selectedLayer.feature);
    if (record) {
      renderMunicipalityPanel(record);
      refreshSelectedTooltip();
    }
  }
}

function refreshSelectedTooltip() {
  if (state.selectedLayer) {
    closeActiveTooltip();
    const record = getRecordForFeature(state.selectedLayer.feature);
    if (record) {
      state.selectedLayer.setStyle({ weight: 2, color: "#202c29" });
      state.selectedLayer.unbindTooltip();
      state.selectedLayer.bindTooltip(() => createTooltip(record), { sticky: true, direction: "top" });
    }
  }
}

function updateLegend() {
  const president = state.election === "presidente";
  let electionName = "Governador";
  let redCandidate = "Jerônimo Rodrigues";
  let blueCandidate = "ACM Neto";
  if (president) {
    electionName = "Presidente";
    redCandidate = "Lula";
    blueCandidate = state.year === "2022" ? "Bolsonaro" : "Flávio Bolsonaro";
  }
  document.querySelector("#legend-election").textContent = electionName;
  document.querySelector("#legend-red-name").textContent = redCandidate;
  document.querySelector("#legend-blue-name").textContent = blueCandidate;
}

function returnToBahia() {
  if (state.fullBounds) {
    state.map.fitBounds(state.fullBounds, { padding: [18, 18] });
  }
  if (state.selectedLayer) {
    state.municipalityLayer.resetStyle(state.selectedLayer);
    state.selectedLayer.getElement()?.classList.remove("is-selected");
    state.selectedLayer = null;
  }
  elements.searchInput.value = "";
  elements.panel.classList.remove("is-open");
  elements.panelTitle.textContent = "Explore o mapa";
  elements.panelHint.hidden = false;
  elements.panelContent.hidden = true;
  elements.mapStatus.textContent = `417 municípios · ${state.year} · selecione uma área para ver os resultados`;
}

function attachControls() {
  document.querySelectorAll(".year-button").forEach((button) => {
    button.addEventListener("click", () => changeYear(button.dataset.year));
  });
  document.querySelectorAll(".election-button").forEach((button) => {
    button.addEventListener("click", () => changeElection(button.dataset.election));
  });
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchMunicipality(elements.searchInput.value);
  });
  elements.resetMap.addEventListener("click", returnToBahia);
  document.querySelector("#close-panel").addEventListener("click", () => {
    elements.panel.classList.remove("is-open");
  });
}

async function startAtlas() {
  attachControls();
  updateLegend();
  initializeMap();
  try {
    const records = await loadData();
    const geojson = await loadGeoJSON();
    renderMunicipalities(geojson);
    updateDashboard(records);
  } catch (error) {
    console.error(error);
    elements.mapStatus.textContent = error.message;
  }
}

await startAtlas();