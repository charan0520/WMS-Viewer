const DEFAULT_BOUNDS = [
  [24.5, -97.75],
  [29.75, -89.75],
];

const SUPPORTED_COLORS = [
  "extend",
  "transparent",
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "gray",
];

const PROXY_ENDPOINT = "./proxy.php?url=";

const state = {
  serviceUrl: "",
  capabilitiesXml: null,
  capabilities: null,
  selectedLayerName: "",
  mapLayer: null,
  identifyMarker: null,
  layerMetadataCache: new Map(),
  usingProxy: false,
};

const elements = {
  wmsUrl: document.querySelector("#wms-url"),
  loadButton: document.querySelector("#load-button"),
  applyButton: document.querySelector("#apply-button"),
  statusMessage: document.querySelector("#status-message"),
  layerSelect: document.querySelector("#layer-select"),
  styleSelect: document.querySelector("#style-select"),
  formatSelect: document.querySelector("#format-select"),
  transparentToggle: document.querySelector("#transparent-toggle"),
  autofitToggle: document.querySelector("#autofit-toggle"),
  timeSelect: document.querySelector("#time-select"),
  elevationSelect: document.querySelector("#elevation-select"),
  paletteSelect: document.querySelector("#palette-select"),
  colorsRangeInput: document.querySelector("#colors-range-input"),
  numBandsInput: document.querySelector("#num-bands-input"),
  opacityInput: document.querySelector("#opacity-input"),
  opacityValue: document.querySelector("#opacity-value"),
  belowMinColorSelect: document.querySelector("#below-min-color-select"),
  aboveMaxColorSelect: document.querySelector("#above-max-color-select"),
  logscaleToggle: document.querySelector("#logscale-toggle"),
  extraParamsInput: document.querySelector("#extra-params-input"),
  legendImage: document.querySelector("#legend-image"),
  legendLink: document.querySelector("#legend-link"),
  metadata: document.querySelector("#layer-metadata"),
};

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
}).fitBounds(DEFAULT_BOUNDS);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 18,
}).addTo(map);

wireEvents();
seedColorOptions();

void loadCapabilitiesFromInput();

function wireEvents() {
  elements.loadButton.addEventListener("click", () => {
    void loadCapabilitiesFromInput();
  });

  elements.wmsUrl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadCapabilitiesFromInput();
    }
  });

  elements.layerSelect.addEventListener("change", () => {
    state.selectedLayerName = elements.layerSelect.value;
    void updateControlValuesForSelection();
  });

  elements.opacityInput.addEventListener("input", () => {
    elements.opacityValue.textContent = `${elements.opacityInput.value}%`;
  });

  elements.applyButton.addEventListener("click", () => {
    applySelectedLayerToMap();
  });

  map.on("click", (event) => {
    void requestFeatureInfo(event.latlng);
  });
}

async function loadCapabilitiesFromInput() {
  const rawUrl = elements.wmsUrl.value.trim();
  if (!rawUrl) {
    setStatus("Enter a WMS URL first.", true);
    return;
  }

  const normalized = buildCapabilitiesUrl(rawUrl);
  setStatus("Loading capabilities...");
  setControlsEnabled(false);
  state.usingProxy = false;

  try {
    const response = await fetchWithProxyFallback(normalized);
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const xmlText = await response.text();
    const documentXml = new DOMParser().parseFromString(xmlText, "text/xml");
    const exceptionNode = documentXml.querySelector("ServiceException, ExceptionText, parsererror");
    if (exceptionNode) {
      throw new Error(exceptionNode.textContent.trim() || "Invalid WMS capabilities document.");
    }

    const capabilities = parseCapabilities(documentXml, rawUrl);
    if (!capabilities.layers.length) {
      throw new Error("No named layers were found in the capabilities document.");
    }

    state.serviceUrl = capabilities.serviceUrl;
    state.capabilitiesXml = documentXml;
    state.capabilities = capabilities;
    state.selectedLayerName = capabilities.layers[0].name;
    state.layerMetadataCache.clear();

    populateServiceControls(capabilities);
    await updateControlValuesForSelection();
    applySelectedLayerToMap();
    setControlsEnabled(true);
    setStatus(
      `Loaded ${capabilities.layers.length} layer${capabilities.layers.length === 1 ? "" : "s"}${state.usingProxy ? " via proxy" : ""}.`,
    );
  } catch (error) {
    console.error(error);
    setStatus(`Could not load capabilities: ${error.message}`, true);
  }
}

function parseCapabilities(documentXml, rawUrl) {
  const rootNode = documentXml.documentElement;
  const capabilityNode = firstNode(rootNode, "Capability");
  const topLayerNode = firstNode(capabilityNode, "Layer");
  const requestNode = firstNode(capabilityNode, "Request");
  const serviceEndpoint = extractOnlineResource(requestNode, rawUrl) || rawUrl;
  const formats = readFormats(requestNode);
  const topCrs = getChildTextList(topLayerNode, "CRS");

  const layerNodes = Array.from(topLayerNode.children).filter((node) => localNameOf(node) === "Layer");
  const layers = collectNamedLayers(layerNodes, {
    inheritedCrs: topCrs,
    inheritedBounds: extractBounds(topLayerNode),
  });

  return {
    version: rootNode.getAttribute("version") || "1.3.0",
    title: getChildText(firstNode(rootNode, "Service"), "Title") || "WMS Service",
    serviceUrl: stripQuery(serviceEndpoint),
    formats,
    layers,
  };
}

function collectNamedLayers(layerNodes, inherited) {
  const results = [];

  for (const layerNode of layerNodes) {
    const mergedCrs = mergeUnique(inherited.inheritedCrs, getChildTextList(layerNode, "CRS"));
    const mergedBounds = extractBounds(layerNode) || inherited.inheritedBounds;
    const name = getChildText(layerNode, "Name");
    const title = getChildText(layerNode, "Title");
    const styles = parseStyles(layerNode);
    const timeDimension = parseDimension(layerNode, "time");
    const elevationDimension = parseDimension(layerNode, "elevation");

    if (name) {
      results.push({
        name,
        title: title || name,
        abstract: getChildText(layerNode, "Abstract"),
        queryable: layerNode.getAttribute("queryable") === "1",
        crs: mergedCrs,
        bounds: mergedBounds,
        styles,
        timeDimension,
        elevationDimension,
      });
    }

    const childLayers = Array.from(layerNode.children).filter((node) => localNameOf(node) === "Layer");
    if (childLayers.length) {
      results.push(...collectNamedLayers(childLayers, {
        inheritedCrs: mergedCrs,
        inheritedBounds: mergedBounds,
      }));
    }
  }

  return results;
}

function parseStyles(layerNode) {
  return Array.from(layerNode.children)
    .filter((node) => localNameOf(node) === "Style")
    .map((styleNode) => ({
      name: getChildText(styleNode, "Name") || "",
      title: getChildText(styleNode, "Title") || getChildText(styleNode, "Name") || "Default",
      abstract: getChildText(styleNode, "Abstract"),
      legendUrl: extractLegendUrl(styleNode),
    }));
}

function parseDimension(layerNode, dimensionName) {
  const node = Array.from(layerNode.children).find(
    (child) =>
      localNameOf(child) === "Dimension" &&
      (child.getAttribute("name") || "").toLowerCase() === dimensionName.toLowerCase(),
  );

  if (!node) {
    return null;
  }

  const rawText = (node.textContent || "").trim().replace(/\s+/g, " ");
  return {
    name: dimensionName,
    defaultValue: node.getAttribute("default") || "",
    raw: rawText,
    values: expandDimensionValues(rawText, dimensionName),
  };
}

function expandDimensionValues(rawText, dimensionName) {
  if (!rawText) {
    return [];
  }

  const trimmed = rawText.trim();
  if (trimmed.includes("/") && trimmed.includes("PT")) {
    return expandIsoRange(trimmed, dimensionName === "time");
  }

  return trimmed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function expandIsoRange(rangeText, isTime) {
  const [startText, endText, stepText] = rangeText.split("/");
  if (!(startText && endText && stepText)) {
    return [rangeText];
  }

  const stepMs = parseIsoDurationToMilliseconds(stepText);
  if (!stepMs) {
    return [rangeText];
  }

  const startMs = isTime ? Date.parse(startText) : Number(startText);
  const endMs = isTime ? Date.parse(endText) : Number(endText);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return [rangeText];
  }

  const values = [];
  const hardLimit = 500;
  for (let current = startMs; current <= endMs && values.length < hardLimit; current += stepMs) {
    values.push(isTime ? new Date(current).toISOString() : String(current));
  }

  return values.length ? values : [rangeText];
}

function parseIsoDurationToMilliseconds(durationText) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(durationText);
  if (!match) {
    return 0;
  }

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function populateServiceControls(capabilities) {
  fillSelect(
    elements.layerSelect,
    capabilities.layers.map((layer) => ({
      value: layer.name,
      label: `${layer.title} (${layer.name})`,
    })),
  );

  fillSelect(
    elements.formatSelect,
    capabilities.formats.map((format) => ({ value: format, label: format })),
    "image/png",
  );
}

async function updateControlValuesForSelection() {
  const layer = getSelectedLayer();
  if (!layer) {
    return;
  }

  fillSelect(
    elements.styleSelect,
    (layer.styles.length ? layer.styles : [{ name: "", title: "Default" }]).map((style) => ({
      value: style.name,
      label: style.title,
    })),
  );

  populateDimensionSelect(elements.timeSelect, layer.timeDimension, "No time dimension");
  populateDimensionSelect(elements.elevationSelect, layer.elevationDimension, "No elevation dimension");

  await populatePaletteOptions(layer);
  await populateScaleRange(layer);
  elements.colorsRangeInput.disabled = false;
  elements.numBandsInput.disabled = false;
  elements.opacityInput.disabled = false;
  elements.logscaleToggle.disabled = false;
  elements.extraParamsInput.disabled = false;
  elements.transparentToggle.disabled = false;
  elements.applyButton.disabled = false;

  updateLegend(layer);
  updateMetadata(layer);
}

async function populatePaletteOptions(layer) {
  const fallbackPalette = inferPaletteName(layer.styles[0]?.name || "");
  const metadata = await fetchLayerMetadata(layer.name);
  const palettes = extractPaletteNames(metadata);
  const options = [{ value: "", label: "Default palette" }];

  for (const palette of palettes) {
    options.push({ value: palette, label: palette });
  }

  if (!palettes.length && fallbackPalette) {
    options.push({ value: fallbackPalette, label: fallbackPalette });
  }

  if (options.length === 1) {
    options.push({ value: "", label: "Not advertised" });
    elements.paletteSelect.disabled = true;
  } else {
    elements.paletteSelect.disabled = false;
  }

  fillSelect(elements.paletteSelect, options, "");
}

async function populateScaleRange(layer) {
  const metadata = await fetchLayerMetadata(layer.name);
  const scaleRange = extractScaleRange(metadata);

  if (!scaleRange) {
    elements.colorsRangeInput.value = "";
    elements.colorsRangeInput.placeholder = "auto or min,max";
    elements.colorsRangeInput.dataset.minScale = "";
    elements.colorsRangeInput.dataset.maxScale = "";
    elements.colorsRangeInput.title = "";
    return;
  }

  elements.colorsRangeInput.value = `${scaleRange.min},${scaleRange.max}`;
  elements.colorsRangeInput.placeholder = `${scaleRange.min},${scaleRange.max}`;
  elements.colorsRangeInput.dataset.minScale = String(scaleRange.min);
  elements.colorsRangeInput.dataset.maxScale = String(scaleRange.max);
  elements.colorsRangeInput.title = `Allowed range: ${scaleRange.min} to ${scaleRange.max}`;
}

function populateDimensionSelect(selectElement, dimension, emptyLabel) {
  if (!dimension || !dimension.values.length) {
    fillSelect(selectElement, [{ value: "", label: emptyLabel }], "");
    selectElement.disabled = true;
    return;
  }

  const options = [{ value: "", label: `Default (${dimension.defaultValue || "server default"})` }]
    .concat(dimension.values.map((value) => ({ value, label: value })));
  fillSelect(selectElement, options, dimension.defaultValue || "");
  selectElement.disabled = false;
}

function applySelectedLayerToMap() {
  const layer = getSelectedLayer();
  if (!layer) {
    setStatus("Choose a layer before applying.", true);
    return;
  }

  const scaleValidation = validateScaleRangeInput();
  if (!scaleValidation.valid) {
    setStatus(scaleValidation.message, true);
    return;
  }

  const params = buildLayerParams(layer);
  if (state.mapLayer) {
    map.removeLayer(state.mapLayer);
  }

  state.mapLayer = L.tileLayer.wms(state.serviceUrl, params).addTo(map);

  if (elements.autofitToggle.checked && layer.bounds) {
    map.fitBounds([
      [layer.bounds.south, layer.bounds.west],
      [layer.bounds.north, layer.bounds.east],
    ]);
  }

  updateLegend(layer, params);
  updateMetadata(layer, params);
  setStatus(`Showing ${layer.title}. Click the map for feature info when supported.`);
}

function buildLayerParams(layer) {
  const params = {
    service: "WMS",
    request: "GetMap",
    version: state.capabilities?.version || "1.3.0",
    layers: layer.name,
    styles: elements.styleSelect.value,
    format: elements.formatSelect.value || "image/png",
    transparent: String(elements.transparentToggle.checked),
    opacity: Number(elements.opacityInput.value) / 100,
    _cacheBust: Date.now(),
  };

  if (elements.timeSelect.value) {
    params.TIME = elements.timeSelect.value;
  }

  if (elements.elevationSelect.value) {
    params.ELEVATION = elements.elevationSelect.value;
  }

  if (elements.paletteSelect.value) {
    params.PALETTE = elements.paletteSelect.value;
  }

  if (elements.colorsRangeInput.value.trim()) {
    params.COLORSCALERANGE = elements.colorsRangeInput.value.trim();
  }

  if (elements.numBandsInput.value.trim()) {
    params.NUMCOLORBANDS = elements.numBandsInput.value.trim();
  }

  if (elements.belowMinColorSelect.value) {
    params.BELOWMINCOLOR = elements.belowMinColorSelect.value;
  }

  if (elements.aboveMaxColorSelect.value) {
    params.ABOVEMAXCOLOR = elements.aboveMaxColorSelect.value;
  }

  if (elements.logscaleToggle.checked) {
    params.LOGSCALE = "true";
  }

  const extraParams = parseExtraParams(elements.extraParamsInput.value);
  return { ...params, ...extraParams };
}

async function requestFeatureInfo(latlng) {
  const layer = getSelectedLayer();
  if (!layer || !layer.queryable || !state.mapLayer) {
    return;
  }

  const bounds = map.getBounds();
  const size = map.getSize();
  const point = map.latLngToContainerPoint(latlng, map.getZoom());

  const params = {
    service: "WMS",
    request: "GetFeatureInfo",
    version: state.capabilities?.version || "1.3.0",
    layers: layer.name,
    query_layers: layer.name,
    styles: elements.styleSelect.value,
    info_format: "text/plain",
    feature_count: 5,
    format: elements.formatSelect.value || "image/png",
    transparent: String(elements.transparentToggle.checked),
    width: size.x,
    height: size.y,
    crs: "EPSG:4326",
    bbox: `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`,
    i: Math.round(point.x),
    j: Math.round(point.y),
  };

  if (elements.timeSelect.value) {
    params.time = elements.timeSelect.value;
  }

  if (elements.elevationSelect.value) {
    params.elevation = elements.elevationSelect.value;
  }

  try {
    const url = `${state.serviceUrl}?${new URLSearchParams(params).toString()}`;
    const response = await fetchWithProxyFallback(url);
    const text = await response.text();
    const content = text.trim() || "No feature info returned.";

    L.popup()
      .setLatLng(latlng)
      .setContent(`<pre>${escapeHtml(content)}</pre>`)
      .openOn(map);
  } catch (error) {
    console.error(error);
    setStatus(`Feature info failed: ${error.message}`, true);
  }
}

function buildCapabilitiesUrl(rawUrl) {
  const url = new URL(rawUrl, window.location.href);
  url.searchParams.set("service", "WMS");
  url.searchParams.set("request", "GetCapabilities");
  return url.toString();
}

function stripQuery(url) {
  const parsed = new URL(url, window.location.href);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function fetchLayerMetadata(layerName) {
  if (state.layerMetadataCache.has(layerName)) {
    return state.layerMetadataCache.get(layerName);
  }

  const url = new URL(state.serviceUrl, window.location.href);
  url.searchParams.set("request", "GetMetadata");
  url.searchParams.set("item", "layerDetails");
  url.searchParams.set("layerName", layerName);

  try {
    const response = await fetchWithProxyFallback(url.toString());
    if (!response.ok) {
      throw new Error(`Metadata request failed with ${response.status}`);
    }

    const metadata = await response.json();
    state.layerMetadataCache.set(layerName, metadata);
    return metadata;
  } catch (error) {
    console.warn(`Palette metadata unavailable for ${layerName}:`, error);
    state.layerMetadataCache.set(layerName, null);
    return null;
  }
}

async function fetchWithProxyFallback(url) {
  try {
    return await fetch(url);
  } catch (directError) {
    const proxyResponse = await fetch(buildProxyUrl(url));
    if (!proxyResponse.ok) {
      const proxyMessage = await readProxyError(proxyResponse);
      throw new Error(
        `${directError.message}. Direct fetch failed, and proxy returned ${proxyResponse.status}${proxyMessage ? `: ${proxyMessage}` : ""}.`,
      );
    }

    state.usingProxy = true;
    return proxyResponse;
  }
}

function buildProxyUrl(url) {
  return `${PROXY_ENDPOINT}${encodeURIComponent(url)}`;
}

async function readProxyError(response) {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      return payload?.error ? String(payload.error) : "";
    }

    return (await response.text()).trim();
  } catch (error) {
    console.warn("Unable to read proxy error response:", error);
    return "";
  }
}

function readFormats(requestNode) {
  const getMapNode = Array.from(requestNode.children).find((node) => localNameOf(node) === "GetMap");
  const formats = getMapNode
    ? Array.from(getMapNode.children)
        .filter((node) => localNameOf(node) === "Format")
        .map((node) => (node.textContent || "").trim())
        .filter(Boolean)
    : [];

  return formats.length ? formats : ["image/png"];
}

function extractOnlineResource(requestNode, fallbackUrl) {
  const getMapNode = Array.from(requestNode.children).find((node) => localNameOf(node) === "GetMap");
  if (!getMapNode) {
    return fallbackUrl;
  }

  const onlineResource = getMapNode.querySelector("OnlineResource");
  return onlineResource?.getAttribute("xlink:href") || onlineResource?.getAttribute("href") || fallbackUrl;
}

function extractLegendUrl(styleNode) {
  const resource = styleNode.querySelector("LegendURL OnlineResource");
  return resource?.getAttribute("xlink:href") || resource?.getAttribute("href") || "";
}

function extractBounds(layerNode) {
  const geoBox = firstNode(layerNode, "EX_GeographicBoundingBox");
  if (geoBox) {
    const west = Number(getChildText(geoBox, "westBoundLongitude"));
    const east = Number(getChildText(geoBox, "eastBoundLongitude"));
    const south = Number(getChildText(geoBox, "southBoundLatitude"));
    const north = Number(getChildText(geoBox, "northBoundLatitude"));
    if ([west, east, south, north].every((value) => Number.isFinite(value))) {
      return { west, east, south, north };
    }
  }

  const bboxNode = Array.from(layerNode.children).find(
    (child) => localNameOf(child) === "BoundingBox" && child.getAttribute("CRS") === "CRS:84",
  );
  if (!bboxNode) {
    return null;
  }

  const west = Number(bboxNode.getAttribute("minx"));
  const east = Number(bboxNode.getAttribute("maxx"));
  const south = Number(bboxNode.getAttribute("miny"));
  const north = Number(bboxNode.getAttribute("maxy"));
  if ([west, east, south, north].every((value) => Number.isFinite(value))) {
    return { west, east, south, north };
  }

  return null;
}

function fillSelect(selectElement, options, preferredValue = "") {
  selectElement.innerHTML = "";
  for (const option of options) {
    const optionElement = document.createElement("option");
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    selectElement.appendChild(optionElement);
  }

  const match = options.find((option) => option.value === preferredValue);
  selectElement.value = match ? preferredValue : options[0]?.value || "";
}

function seedColorOptions() {
  const colorOptions = SUPPORTED_COLORS.map((color) => ({ value: color, label: color }));
  fillSelect(elements.belowMinColorSelect, colorOptions, "extend");
  fillSelect(elements.aboveMaxColorSelect, colorOptions, "extend");
}

function extractPaletteNames(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }

  const candidates = [
    metadata.palettes,
    metadata.paletteNames,
    metadata.supportedPalettes,
    metadata.scaleRange?.palettes,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePaletteList(candidate);
    if (normalized.length) {
      return normalized;
    }
  }

  for (const value of Object.values(metadata)) {
    const normalized = normalizePaletteList(value);
    if (normalized.length) {
      return normalized;
    }
  }

  return [];
}

function extractScaleRange(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const candidates = [
    metadata.scaleRange,
    metadata.colorScaleRange,
    metadata.defaultScaleRange,
    metadata.range,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeScaleRange(candidate);
    if (normalized) {
      return normalized;
    }
  }

  for (const value of Object.values(metadata)) {
    const normalized = normalizeScaleRange(value);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function normalizeScaleRange(candidate) {
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const min = Number(candidate[0]);
    const max = Number(candidate[1]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { min, max };
    }
  }

  if (typeof candidate === "string") {
    const parts = candidate.split(",").map((value) => Number(value.trim()));
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] <= parts[1]) {
      return { min: parts[0], max: parts[1] };
    }
  }

  if (candidate && typeof candidate === "object") {
    const min = Number(candidate.min ?? candidate.minimum ?? candidate.low ?? candidate.start);
    const max = Number(candidate.max ?? candidate.maximum ?? candidate.high ?? candidate.end);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { min, max };
    }
  }

  return null;
}

function validateScaleRangeInput() {
  const rawValue = elements.colorsRangeInput.value.trim();
  if (!rawValue) {
    return { valid: true };
  }

  const parts = rawValue.split(",").map((value) => Number(value.trim()));
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    return { valid: false, message: "Color scale range must be in the form min,max." };
  }

  if (parts[0] > parts[1]) {
    return { valid: false, message: "Color scale range minimum must be less than or equal to the maximum." };
  }

  const allowedMin = Number(elements.colorsRangeInput.dataset.minScale);
  const allowedMax = Number(elements.colorsRangeInput.dataset.maxScale);
  if (
    Number.isFinite(allowedMin) &&
    Number.isFinite(allowedMax) &&
    (parts[0] < allowedMin || parts[1] > allowedMax)
  ) {
    return {
      valid: false,
      message: `Color scale range must stay within ${allowedMin},${allowedMax} for this layer.`,
    };
  }

  return { valid: true };
}

function normalizePaletteList(candidate) {
  if (Array.isArray(candidate)) {
    const values = candidate
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (entry && typeof entry === "object") {
          return String(entry.name || entry.id || entry.palette || "").trim();
        }
        return "";
      })
      .filter(Boolean);

    return Array.from(new Set(values));
  }

  if (candidate && typeof candidate === "object") {
    if (Array.isArray(candidate.values)) {
      return normalizePaletteList(candidate.values);
    }

    const keys = Object.keys(candidate).filter(Boolean);
    if (keys.length) {
      return Array.from(new Set(keys));
    }
  }

  return [];
}

function updateLegend(layer, params = null) {
  const selectedStyle = layer.styles.find((style) => style.name === elements.styleSelect.value) || layer.styles[0];
  if (!selectedStyle?.legendUrl) {
    elements.legendImage.style.display = "none";
    elements.legendLink.href = "#";
    return;
  }

  const legendUrl = new URL(selectedStyle.legendUrl, window.location.href);
  if (params?.palette) {
    legendUrl.searchParams.set("PALETTE", params.palette);
  }
  if (params?.numcolorbands) {
    legendUrl.searchParams.set("NUMCOLORBANDS", params.numcolorbands);
  }

  elements.legendImage.src = legendUrl.toString();
  elements.legendImage.style.display = "block";
  elements.legendLink.href = legendUrl.toString();
}

function updateMetadata(layer, params = null) {
  const entries = [
    ["Title", layer.title],
    ["Layer Name", layer.name],
    ["Queryable", layer.queryable ? "Yes" : "No"],
    ["Time", params?.time || layer.timeDimension?.defaultValue || "Server default"],
    ["Depth", params?.elevation || layer.elevationDimension?.defaultValue || "Server default"],
    ["Style", params?.styles || "Default"],
    ["Format", params?.format || "image/png"],
    ["Bounds", layer.bounds ? `${layer.bounds.west}, ${layer.bounds.south} to ${layer.bounds.east}, ${layer.bounds.north}` : "Unknown"],
    ["Abstract", layer.abstract || "No abstract provided"],
  ];

  elements.metadata.innerHTML = "";
  for (const [term, description] of entries) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    elements.metadata.append(dt, dd);
  }
}

function parseExtraParams(rawText) {
  if (!rawText.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Extra parameters must be a JSON object.");
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
  } catch (error) {
    setStatus(`Ignoring extra parameters: ${error.message}`, true);
    return {};
  }
}

function setStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.style.background = isError ? "rgba(187, 37, 37, 0.12)" : "var(--surface)";
  elements.statusMessage.style.color = isError ? "#8d2323" : "var(--accent-strong)";
}

function setControlsEnabled(enabled) {
  const controls = [
    elements.layerSelect,
    elements.styleSelect,
    elements.formatSelect,
    elements.timeSelect,
    elements.elevationSelect,
    elements.paletteSelect,
    elements.colorsRangeInput,
    elements.numBandsInput,
    elements.opacityInput,
    elements.belowMinColorSelect,
    elements.aboveMaxColorSelect,
    elements.logscaleToggle,
    elements.extraParamsInput,
    elements.applyButton,
  ];

  for (const control of controls) {
    control.disabled = !enabled;
  }
}

function getSelectedLayer() {
  return state.capabilities?.layers.find((layer) => layer.name === state.selectedLayerName) || null;
}

function inferPaletteName(styleName) {
  const parts = styleName.split("/");
  return parts[1] || "default";
}

function mergeUnique(first, second) {
  return Array.from(new Set([...(first || []), ...(second || [])]));
}

function getChildText(node, childName) {
  const child = firstNode(node, childName);
  return child ? (child.textContent || "").trim() : "";
}

function getChildTextList(node, childName) {
  if (!node) {
    return [];
  }

  return Array.from(node.children)
    .filter((child) => localNameOf(child) === childName)
    .map((child) => (child.textContent || "").trim())
    .filter(Boolean);
}

function firstNode(node, localName) {
  if (!node) {
    return null;
  }

  return Array.from(node.children || []).find((child) => localNameOf(child) === localName) || null;
}

function localNameOf(node) {
  return node.localName || node.nodeName.split(":").pop();
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
