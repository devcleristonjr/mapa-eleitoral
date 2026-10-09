const DATA_URL = "/api/dados";
const GEOJSON_URL = "/api/geojson";
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
  territory: "todos",
  recordsByCode: new Map(),
  map: null,
  municipalityLayer: null,
  hoveredLayer: null,
  activeTooltipLayer: null,
  fullBounds: null,
  selectedLayer: null,
  electorateChart: null,
  tableSort: { key: "municipio", direction: "asc" },
};

const elements = {
  map: document.querySelector("#map"),
  mapStatus: document.querySelector("#map-status"),
  searchForm: document.querySelector("#search-form"),
  searchInput: document.querySelector("#municipality-search"),
  municipalityOptions: document.querySelector("#municipality-options"),
  territoryFilter: document.querySelector("#territory-filter"),
  resetMap: document.querySelector("#reset-map"),
  panel: document.querySelector("#municipality-panel"),
  panelTitle: document.querySelector("#panel-title"),
  panelHint: document.querySelector("#panel-hint"),
  panelContent: document.querySelector("#panel-content"),
  chartCanvas: document.querySelector("#electorate-chart"),
  chartStatus: document.querySelector("#chart-status"),
  chartYear: document.querySelector("#chart-year"),
  tableBody: document.querySelector("#results-table-body"),
  tableCount: document.querySelector("#table-count"),
  tableEmpty: document.querySelector("#table-empty"),
  downloadExcel: document.querySelector("#download-excel"),
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
    let message = friendlyError;
    try {
      const payload = await response.json();
      if (typeof payload.error === "string") {
        message = payload.error;
      }
    } catch {
      // Keep the existing friendly message when an error response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

async function loadData() {
  const records = await fetchJson(
    DATA_URL,
    "Não foi possível carregar os dados eleitorais.",
  );
  if (!Array.isArray(records)) {
    throw new TypeError(
      "O arquivo de dados eleitorais está em formato inválido.",
    );
  }
  state.recordsByCode = new Map(
    records.map((record) => [Number(record.ibge), record]),
  );
  if (state.recordsByCode.size !== records.length) {
    throw new Error("Existem códigos IBGE duplicados nos dados eleitorais.");
  }
  populateSearchOptions(records);
  populateTerritoryOptions(records);
  updateDashboard();
  updateAnalytics();
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
    maxZoom: 11,
    maxBoundsViscosity: 1,
  });
  elements.map.addEventListener("mouseleave", clearHoveredFeature);
  L.control
    .attribution({ prefix: false })
    .addAttribution(
      'Malha municipal <a href="https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais.html" target="_blank" rel="noreferrer">IBGE</a>',
    )
    .addTo(state.map);
}

function getRecordForFeature(feature) {
  const code = Number(feature.properties?.code);
  const record = state.recordsByCode.get(code);
  if (!record) {
    console.warn(
      `Município sem correspondência: ${feature.properties?.municipio ?? code}`,
    );
  }
  return record;
}

function getElectionData(record, election = state.election) {
  return record?.anos?.[state.year]?.[election] ?? null;
}

function getElectionLabel(year = state.year) {
  return year === "2022" ? "2022 · 2º turno" : "2026 · 1º turno";
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
  const color = range.low.map((channel, index) =>
    Math.round(channel + (range.high[index] - channel) * amount),
  );
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
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function styleFeature(feature) {
  const record = getRecordForFeature(feature);
  if (!isInSelectedTerritory(record)) {
    return {
      color: "#f8faf7",
      weight: 0.5,
      opacity: 0.2,
      fillColor: "#cbd3ce",
      fillOpacity: 0.22,
    };
  }
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
  if (
    geojson?.type !== "FeatureCollection" ||
    !Array.isArray(geojson.features)
  ) {
    throw new Error("A malha municipal está em formato inválido.");
  }
  if (geojson.features.length !== EXPECTED_MUNICIPALITIES) {
    throw new Error(
      `A malha municipal deveria conter ${EXPECTED_MUNICIPALITIES} municípios.`,
    );
  }

  const matchedCount = geojson.features.filter((feature) =>
    getRecordForFeature(feature),
  ).length;
  if (matchedCount !== EXPECTED_MUNICIPALITIES) {
    elements.mapStatus.textContent = `${matchedCount} de ${EXPECTED_MUNICIPALITIES} municípios associados`;
  }

  state.municipalityLayer = L.geoJSON(geojson, {
    style: styleFeature,
    onEachFeature: configureFeature,
  }).addTo(state.map);
  state.fullBounds = state.municipalityLayer.getBounds();
  state.map.fitBounds(state.fullBounds, { padding: [18, 18], maxZoom: 10 });
  state.map.setMinZoom(Math.max(4, state.map.getZoom() - 1));
  state.map.setMaxBounds(state.fullBounds.pad(0.35));
  if (matchedCount === EXPECTED_MUNICIPALITIES) {
    elements.mapStatus.textContent = `417 municípios · ${getElectionLabel()} · selecione uma área para ver os resultados`;
  }
}

function configureFeature(feature, layer) {
  const record = getRecordForFeature(feature);
  if (!record) {
    return;
  }
  const municipality = record.municipio;
  layer.bindTooltip(() => createTooltip(record), {
    sticky: true,
    direction: "top",
    offset: [0, -8],
    opacity: 1,
  });
  layer.on({
    click: () => showMunicipality(record, layer),
    mouseover: () => {
      if (state.hoveredLayer !== layer) {
        clearHoveredFeature();
        state.hoveredLayer = layer;
      }
      state.activeTooltipLayer = layer;
      layer.openTooltip();
      highlightFeature(layer);
    },
    mouseout: () => {
      if (state.hoveredLayer === layer) {
        clearHoveredFeature();
      }
    },
  });
  layer.on("add", () => makeFeatureKeyboardAccessible(layer, record));
  layer.options.title = municipality;
}

function isInSelectedTerritory(record) {
  return (
    state.territory === "todos" ||
    record?.territorio_identidade === state.territory
  );
}

function getFilteredRecords() {
  return [...state.recordsByCode.values()].filter(isInSelectedTerritory);
}

function updateTerritoryMap() {
  if (!state.municipalityLayer) {
    return;
  }
  state.municipalityLayer.eachLayer((layer) => {
    const record = getRecordForFeature(layer.feature);
    const included = isInSelectedTerritory(record);
    const path = layer.getElement();
    layer.setStyle(styleFeature(layer.feature));
    path?.classList.toggle("is-filtered-out", !included);
    if (path) {
      path.setAttribute("aria-hidden", String(!included));
      path.setAttribute("tabindex", included ? "0" : "-1");
    }
  });
}

function populateTerritoryOptions(records) {
  const territories = [
    ...new Set(records.map((record) => record.territorio_identidade)),
  ]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  const options = territories.map((territory) => {
    const option = document.createElement("option");
    option.value = territory;
    option.textContent = territory;
    return option;
  });
  elements.territoryFilter.append(...options);
}

function changeTerritory(territory) {
  state.territory = territory;
  if (
    state.selectedLayer &&
    !isInSelectedTerritory(getRecordForFeature(state.selectedLayer.feature))
  ) {
    state.municipalityLayer.resetStyle(state.selectedLayer);
    state.selectedLayer.getElement()?.classList.remove("is-selected");
    state.selectedLayer = null;
    elements.panel.classList.remove("is-open");
    elements.panelTitle.textContent = "Explore o mapa";
    elements.panelHint.hidden = false;
    elements.panelContent.hidden = true;
  }
  updateTerritoryMap();
  updateDashboard();
  updateAnalytics();
  elements.mapStatus.textContent = `${formatElectors(getFilteredRecords().length)} municípios · ${territory === "todos" ? "Bahia" : territory} · ${getElectionLabel()}`;
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
    tooltip.style.setProperty(
      "--tip-color",
      colorString(COLOR_RANGES[group].high),
    );
  }
  tooltip.style.setProperty(
    "--tip-width",
    `${Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}%`,
  );
  const header = document.createElement("div");
  const avatar = document.createElement("span");
  const titles = document.createElement("div");
  const electors = document.createElement("div");
  header.className = "tooltip-header";
  avatar.className = "tooltip-avatar";
  avatar.textContent = (electionData?.candidato || record.municipio)
    .charAt(0)
    .toUpperCase();
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
  tooltip.append(header, details);
  bar.className = "tooltip-bar";
  bar.style.setProperty(
    "--tip-width",
    `${Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0}%`,
  );
  bar.append(document.createElement("span"));
  tooltip.append(bar);
  if (
    electionData?.segundo_candidato &&
    Number.isFinite(electionData.percentual_segundo)
  ) {
    const rival = document.createElement("div");
    const rivalDetails = document.createElement("div");
    const rivalName = document.createElement("span");
    const rivalPercent = document.createElement("strong");
    const rivalBar = document.createElement("div");
    const rivalGroup = getCandidateColorGroup(electionData.segundo_candidato);
    rival.className = "tooltip-rival";
    rivalDetails.className = "tooltip-rival-details";
    rivalName.textContent = electionData.segundo_candidato;
    rivalPercent.className = "tooltip-rival-percent";
    rivalPercent.textContent = formatPercent(electionData.percentual_segundo);
    rivalDetails.append(rivalName, rivalPercent);
    rivalBar.className = "tooltip-bar tooltip-rival-bar";
    rivalBar.style.setProperty(
      "--tip-width",
      `${Math.max(0, Math.min(100, electionData.percentual_segundo))}%`,
    );
    if (rivalGroup) {
      rivalBar.style.setProperty(
        "--tip-color",
        colorString(COLOR_RANGES[rivalGroup].high),
      );
      rivalPercent.style.color = colorString(COLOR_RANGES[rivalGroup].high);
    }
    rivalBar.append(document.createElement("span"));
    rival.append(rivalDetails, rivalBar);
    tooltip.append(rival);
  }
  return tooltip;
}

function makeFeatureKeyboardAccessible(layer, record) {
  const path = layer.getElement();
  if (!path || path.dataset.keyboardReady) {
    if (path) {
      path.setAttribute(
        "aria-label",
        `${record.municipio}, ${formatPercent(getElectionData(record)?.percentual)}`,
      );
    }
    return;
  }
  path.dataset.keyboardReady = "true";
  path.setAttribute("tabindex", "0");
  path.setAttribute("role", "button");
  path.setAttribute(
    "aria-label",
    `${record.municipio}, ${formatPercent(getElectionData(record)?.percentual)}`,
  );
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

function clearHoveredFeature() {
  const hoveredLayer = state.hoveredLayer;
  state.hoveredLayer = null;
  closeActiveTooltip();
  if (hoveredLayer) {
    resetFeatureStyle(hoveredLayer);
  }
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
  document.querySelector("#panel-ibge").textContent = Number.isInteger(
    Number(record.ibge),
  )
    ? String(record.ibge).padStart(7, "0")
    : "Dados não disponíveis";
  elements.mapStatus.textContent = `${record.municipio} selecionado`;
}

function animatePanelContent() {
  elements.panelContent
    .getAnimations()
    .forEach((animation) => animation.cancel());
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
  candidateElement.textContent =
    electionData?.candidato || "Dados não disponíveis";
  percentElement.textContent = formatPercent(electionData?.percentual);
  percentElement.style.color = group
    ? colorString(COLOR_RANGES[group].high)
    : "";
  const candidates = [];
  if (electionData?.votos !== undefined) {
    candidates.push({ name: "Votos do vencedor", votes: electionData.votos });
  }
  if (electionData?.segundo_candidato) {
    candidates.push({
      name: electionData.segundo_candidato,
      votes: electionData.votos_segundo,
      percent: electionData.percentual_segundo,
    });
  }
  if (electionData?.votos_outros !== undefined) {
    candidates.push({
      name: "Outros candidatos",
      votes: electionData.votos_outros,
      percent: electionData.percentual_outros,
    });
  }
  const counts = [
    ["Votos válidos", electionData?.votos_validos],
    ["Brancos", electionData?.brancos],
    ["Nulos", electionData?.nulos],
    ["Abstenções", electionData?.abstencoes],
  ].filter(([, value]) => value !== undefined && value !== null);

  const candidateList = document.createElement("div");
  candidateList.className = "result-vote-list";
  candidates.forEach(({ name, votes, percent }) => {
    const row = document.createElement("div");
    const candidateName = document.createElement("span");
    const candidateResult = document.createElement("strong");
    row.className = "result-vote-row";
    candidateName.textContent = name;
    candidateResult.textContent = `${formatElectors(votes)}${percent === undefined ? "" : ` · ${formatPercent(percent)}`}`;
    row.append(candidateName, candidateResult);
    candidateList.append(row);
  });

  const countList = document.createElement("dl");
  countList.className = "result-counts";
  counts.forEach(([label, value]) => {
    const item = document.createElement("div");
    const name = document.createElement("dt");
    const formattedValue = document.createElement("dd");
    name.textContent = label;
    formattedValue.textContent = formatElectors(value);
    item.append(name, formattedValue);
    countList.append(item);
  });

  detailsElement.replaceChildren();
  if (candidates.length) detailsElement.append(candidateList);
  if (counts.length) detailsElement.append(countList);
  detailsElement.hidden = candidates.length === 0 && counts.length === 0;
}

function renderMunicipalityPanel(record) {
  const presidentData = getElectionData(record, "presidente");
  document.querySelector("#panel-territory").textContent =
    record.territorio_identidade || "Dados não disponíveis";
  document.querySelector("#panel-turnout-label").textContent =
    state.year === "2022" ? "Votos apurados" : "Eleitores";
  document.querySelector("#panel-electors").textContent = formatElectors(
    presidentData?.eleitores ?? presidentData?.total_votos,
  );
  renderElectionResult("president", presidentData);
  renderElectionResult("governor", getElectionData(record, "governador"));
}

function updateDashboard(records = getFilteredRecords()) {
  const valid = records
    .map((record) => ({
      record,
      percentage: getElectionData(record)?.percentual,
    }))
    .filter(
      ({ percentage }) =>
        typeof percentage === "number" && Number.isFinite(percentage),
    );
  const sorted = [...valid].sort(
    (left, right) => left.percentage - right.percentage,
  );
  const total = records.length;
  document.querySelector("#metric-count").textContent = new Intl.NumberFormat(
    "pt-BR",
  ).format(total);
  document.querySelector("#metric-max").textContent = sorted.length
    ? formatPercent(sorted.at(-1).percentage)
    : "Dados não disponíveis";
  document.querySelector("#metric-min").textContent = sorted.length
    ? formatPercent(sorted[0].percentage)
    : "Dados não disponíveis";
  document.querySelector("#metric-max-city").textContent =
    sorted.at(-1)?.record.municipio ?? "";
  document.querySelector("#metric-min-city").textContent =
    sorted[0]?.record.municipio ?? "";
  const average = valid.length
    ? valid.reduce((sum, item) => sum + item.percentage, 0) / valid.length
    : null;
  document.querySelector("#metric-average").textContent =
    average === null ? "Dados não disponíveis" : formatPercent(average);
  document.querySelector("#metric-above").textContent = new Intl.NumberFormat(
    "pt-BR",
  ).format(valid.filter((item) => item.percentage > 75).length);
}

function getElectorate(record, year = state.year) {
  const president = record.anos?.[year]?.presidente;
  return president?.eleitores ?? null;
}

function updateAnalytics() {
  renderElectorateChart();
  renderResultsTable();
}

function renderElectorateChart() {
  const topRecords = getFilteredRecords()
    .map((record) => ({ record, electorate: getElectorate(record) }))
    .filter(({ electorate }) => Number.isFinite(electorate))
    .sort((left, right) => right.electorate - left.electorate)
    .slice(0, 10);
  elements.chartYear.textContent = getElectionLabel();
  if (!window.Chart) {
    elements.chartStatus.hidden = false;
    elements.chartStatus.textContent = "Não foi possível carregar o gráfico.";
    return;
  }
  elements.chartStatus.hidden = true;
  if (state.electorateChart) {
    state.electorateChart.destroy();
  }
  state.electorateChart = new Chart(elements.chartCanvas, {
    type: "bar",
    data: {
      labels: topRecords.map(({ record }) => record.municipio),
      datasets: [
        {
          data: topRecords.map(({ electorate }) => electorate),
          backgroundColor: "#25675f",
          hoverBackgroundColor: "#174b45",
          borderRadius: 2,
          barPercentage: 0.72,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 350 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => ` ${formatElectors(context.raw)} eleitores`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: "#e3e9e5" },
          ticks: {
            callback: (value) =>
              new Intl.NumberFormat("pt-BR", { notation: "compact" }).format(
                value,
              ),
          },
        },
        y: { grid: { display: false }, ticks: { color: "#202c29" } },
      },
    },
  });
}

function get2022CandidateVotes(record) {
  const votes = { lula: 0, bolsonaro: 0, jeronimo: 0, acm: 0 };
  for (const [election, candidates] of Object.entries({
    presidente: { lula: "lula", bolsonaro: "bolsonaro" },
    governador: { "jeronimo rodrigues": "jeronimo", "acm neto": "acm" },
  })) {
    const result = record.anos?.["2022"]?.[election];
    if (!result) continue;
    const winnerKey = normalizeName(result.candidato);
    const secondKey = normalizeName(result.segundo_candidato);
    for (const [candidate, key] of Object.entries(candidates)) {
      if (normalizeName(candidate) === winnerKey)
        votes[key] = result.votos ?? 0;
      if (normalizeName(candidate) === secondKey)
        votes[key] = result.votos_segundo ?? 0;
    }
  }
  return votes;
}

function getSortedTableRecords() {
  const records = getFilteredRecords().map((record) => ({
    record,
    ...get2022CandidateVotes(record),
  }));
  const { key, direction } = state.tableSort;
  return records.sort((left, right) => {
    const leftValue = key === "municipio" ? left.record.municipio : left[key];
    const rightValue =
      key === "municipio" ? right.record.municipio : right[key];
    const comparison =
      typeof leftValue === "number"
        ? leftValue - rightValue
        : leftValue.localeCompare(rightValue, "pt-BR");
    return comparison * (direction === "asc" ? 1 : -1);
  });
}

function renderResultsTable() {
  const records = getSortedTableRecords();
  const rows = document.createDocumentFragment();
  for (const item of records) {
    const row = document.createElement("tr");
    const municipalityCell = document.createElement("th");
    const municipalityButton = document.createElement("button");
    municipalityCell.scope = "row";
    municipalityButton.className = "municipality-link";
    municipalityButton.type = "button";
    municipalityButton.dataset.code = item.record.ibge;
    municipalityButton.textContent = item.record.municipio;
    municipalityCell.append(municipalityButton);
    row.append(municipalityCell);
    for (const candidate of ["lula", "bolsonaro", "jeronimo", "acm"]) {
      const cell = document.createElement("td");
      cell.textContent = formatElectors(item[candidate]);
      cell.className = `candidate-${candidate}`;
      row.append(cell);
    }
    rows.append(row);
  }
  elements.tableBody.replaceChildren(rows);
  elements.tableCount.textContent = `${formatElectors(records.length)} ${records.length === 1 ? "município" : "municípios"}`;
  elements.tableEmpty.hidden = records.length > 0;
  document.querySelectorAll(".table-sort").forEach((button) => {
    const active = button.dataset.sortKey === state.tableSort.key;
    button
      .closest("th")
      .setAttribute(
        "aria-sort",
        active
          ? `${state.tableSort.direction === "asc" ? "ascending" : "descending"}`
          : "none",
      );
    button.querySelector("span").textContent = active
      ? state.tableSort.direction === "asc"
        ? "↑"
        : "↓"
      : "↕";
  });
}

function downloadResultsExcel() {
  if (!window.XLSX) {
    elements.mapStatus.textContent =
      "Não foi possível carregar a exportação para Excel.";
    return;
  }
  const territory =
    state.territory === "todos" ? "Todos os territórios" : state.territory;
  const rows = [
    [
      "Município",
      "Território de identidade",
      "Lula",
      "Bolsonaro",
      "Jerônimo Rodrigues",
      "ACM Neto",
      "Eleitorado",
    ],
    ...getSortedTableRecords().map(
      ({ record, lula, bolsonaro, jeronimo, acm }) => [
        record.municipio,
        record.territorio_identidade,
        lula,
        bolsonaro,
        jeronimo,
        acm,
        getElectorate(record, "2022"),
      ],
    ),
  ];
  const workbook = window.XLSX.utils.book_new();
  const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 24 },
    { wch: 34 },
    { wch: 14 },
    { wch: 14 },
    { wch: 20 },
    { wch: 14 },
    { wch: 14 },
  ];
  window.XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    "Votos 2022 - 2 turno",
  );
  const slug = normalizeName(territory).replace(/\s+/g, "-");
  window.XLSX.writeFile(workbook, `votacao-2022-2-turno-${slug}.xlsx`);
}

function populateSearchOptions(records) {
  const options = document.createDocumentFragment();
  [...records]
    .sort((left, right) =>
      left.municipio.localeCompare(right.municipio, "pt-BR"),
    )
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
  const match =
    [...state.recordsByCode.values()].find(
      (record) => normalizeName(record.municipio) === normalized,
    ) ??
    [...state.recordsByCode.values()].find((record) =>
      normalizeName(record.municipio).startsWith(normalized),
    );
  if (!match) {
    elements.mapStatus.textContent = "Município não encontrado";
    return;
  }
  if (!isInSelectedTerritory(match)) {
    elements.mapStatus.textContent = `${match.municipio} não pertence ao território selecionado`;
    return;
  }
  const layer = findLayerByCode(match.ibge);
  if (!layer) {
    elements.mapStatus.textContent =
      "Não foi possível localizar esse município na malha.";
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
  updateAnalytics();
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
  updateAnalytics();
  if (!state.selectedLayer) {
    elements.mapStatus.textContent = `417 municípios · ${getElectionLabel()} · selecione uma área para ver os resultados`;
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
      state.selectedLayer.bindTooltip(() => createTooltip(record), {
        sticky: true,
        direction: "top",
      });
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
  elements.mapStatus.textContent = `417 municípios · ${getElectionLabel()} · selecione uma área para ver os resultados`;
}

function attachControls() {
  document.querySelectorAll(".year-button").forEach((button) => {
    button.addEventListener("click", () => changeYear(button.dataset.year));
  });
  document.querySelectorAll(".election-button").forEach((button) => {
    button.addEventListener("click", () =>
      changeElection(button.dataset.election),
    );
  });
  elements.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchMunicipality(elements.searchInput.value);
  });
  elements.resetMap.addEventListener("click", returnToBahia);
  elements.territoryFilter.addEventListener("change", () =>
    changeTerritory(elements.territoryFilter.value),
  );
  document.querySelectorAll(".table-sort").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      state.tableSort = {
        key,
        direction:
          state.tableSort.key === key && state.tableSort.direction === "asc"
            ? "desc"
            : "asc",
      };
      renderResultsTable();
    });
  });
  elements.tableBody.addEventListener("click", (event) => {
    const button = event.target.closest(".municipality-link");
    if (!button) return;
    const record = state.recordsByCode.get(Number(button.dataset.code));
    const layer = record && findLayerByCode(record.ibge);
    if (record && layer) {
      state.map.fitBounds(layer.getBounds(), { maxZoom: 9, padding: [42, 42] });
      showMunicipality(record, layer);
    }
  });
  elements.downloadExcel.addEventListener("click", downloadResultsExcel);
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
