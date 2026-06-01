// Use same-origin relative endpoints to avoid protocol/host mismatches.
var DATA_URL = "/data";
var TARGET_URL = "/target";

// ── Build DOM ─────────────────────────────────────────────────────────────────
var app = document.getElementById("app");
app.innerHTML = [
  '<h2>Experiment 3</h2>',
  '<div class="grid">',
    card("",     "conn",        "Connection",              "Connecting..."),
    card("",     "status",      "GPS Status",              "-"),
    card("",     "sats",        "Satellites",              "-"),
    card("",     "speed",       "Speed",                   "-"),
    card("",     "heading",     "Compass heading",         "-"),
    card("full", "wp-info",     "Waypoint",                "No waypoints yet"),
    card("",     "target-dist", "Distance to waypoint",    "-"),
    card("",     "target-bear", "Direction to waypoint",   "-"),
    '<div class="card full route-manager">',
      '<div class="label">Saved routes</div>',
      '<div class="route-controls">',
        '<select id="route-select" onchange="loadSelectedRoute()">',
          '<option value="">No saved routes</option>',
        '</select>',
        '<button id="save-route-btn" onclick="saveCurrentRoute()">Save Route</button>',
        '<button id="delete-route-btn" onclick="deleteSelectedRoute()" aria-label="Delete selected route">Delete</button>',
      '</div>',
    '</div>',
    '<div class="card full btn-row" id="action-row">',
      '<div class="action-stack">',
        '<button id="confirm-btn" onclick="confirmWaypoint()">Add</button>',
        '<button id="place-btn" onclick="togglePlace()">Add Waypoints</button>',
      '</div>',
      '<button id="record-btn" onclick="toggleRecording()" aria-pressed="false">&#x25CF; Record</button>',
      '<button id="clear-btn" onclick="clearWaypoints()" aria-label="Clear waypoints">&#x2715;</button>',
    '</div>',
    // Calibration button
    '<div class="card full" style="text-align:center;margin-top:8px;">',
      '<button id="calibrate-btn" style="padding:8px 18px;font-size:1em;">Calibrate Magnetometer</button>',
      '<button id="led-toggle-btn" style="padding:8px 18px;font-size:1em;margin-left:8px;">LEDs: On</button>',
      '<span id="calib-status" style="margin-left:12px;color:#ffd700;"></span>',
    '</div>',
  '</div>',
  '<div id="map"></div>'
].join("");

// ── Magnetometer Calibration ────────────────────────────────────────────────
var calibrating = false;
var calibStatus = document.getElementById("calib-status");
var calibBtn = document.getElementById("calibrate-btn");
var ledToggleBtn = document.getElementById("led-toggle-btn");
var directionLedsEnabled = true;

function updateLedToggleButton() {
  if (!ledToggleBtn) return;
  ledToggleBtn.textContent = directionLedsEnabled ? "LEDs: On" : "LEDs: Off";
}

function disableDirectionLedsOnDevice() {
  fetch(TARGET_URL + "?clear=1").catch(function () {});
}

function setDirectionLedsEnabled(enabled) {
  directionLedsEnabled = enabled;
  updateLedToggleButton();
  if (!directionLedsEnabled) {
    lastTargetSentHeading = null;
    lastTargetSentAt = 0;
    disableDirectionLedsOnDevice();
  }
}

if (ledToggleBtn) {
  ledToggleBtn.addEventListener("click", function () {
    setDirectionLedsEnabled(!directionLedsEnabled);
  });
}

updateLedToggleButton();
if (calibBtn) {
  calibBtn.addEventListener("click", function() {
    if (calibrating) return;
    calibrating = true;
    calibBtn.disabled = true;
    calibStatus.textContent = "Calibrating... Rotate device 360° for 10s";
    fetch("/calibrate").then(function(r) {
      setTimeout(function() {
        calibrating = false;
        calibBtn.disabled = false;
        calibStatus.textContent = "Calibration complete!";
        setTimeout(function() { calibStatus.textContent = ""; }, 3000);
      }, 10500);
    }).catch(function() {
      calibrating = false;
      calibBtn.disabled = false;
      calibStatus.textContent = "Calibration failed";
    });
  });
}

function card(extra, id, label, init) {
  return '<div class="card ' + extra + '">' +
    '<div class="label">' + label + '</div>' +
    '<div class="value" id="' + id + '">' + init + '</div>' +
    '</div>';
}

var map            = null;
var marker         = null;   // current position marker (blue)
var waypoints      = [];     // [{lat, lon}, ...]
var wpMarkers      = [];     // Leaflet markers per waypoint
var routeLine      = null;   // polyline through all waypoints
var navLine        = null;   // dashed line: position → current waypoint
var currentWPIndex = 0;      // which waypoint we're navigating to

// Location & Animation Variables
var currentLat     = null;
var currentLon     = null;
var currentHeading = null;
var targetLat      = null;
var targetLon      = null;
var targetHeading  = null;
var lastTargetSentAt = 0;
var lastTargetSentHeading = null;

var lastTargetDist = null;
var recording      = false;
var recordingPoints = [];
var recordingLine  = null;
var recordings     = [];
var recordingStartedAt = null;
var localRoutes    = [];
var githubRoutes   = [];
var loadingRoute   = false;

var RECORDINGS_STORAGE_KEY = "gps_recordings_v1";
var LOCAL_ROUTES_STORAGE_KEY = "gps_saved_routes_v1";
var GITHUB_ROUTES_URL = "https://robdenbesten.github.io/experiment3/routes.json";
var headingCone = null;
var HEADING_CONE_ANGLE_DEG = 55;
var HEADING_CONE_RANGE_M   = 22;
var HEADING_CONE_STEPS     = 12;

// ── Animation Loop ────────────────────────────────────────────────────────────
function animateMapElements() {
  if (currentLat !== null && targetLat !== null) {
    // 0.2 is the smoothing factor. Adjust between 0.05 (slower) and 0.5 (faster) if needed.
    var smoothing = 0.2; 
    
    currentLat += (targetLat - currentLat) * smoothing;
    currentLon += (targetLon - currentLon) * smoothing;

    // Shortest path interpolation for the heading
    if (currentHeading !== null && targetHeading !== null) {
      var diff = targetHeading - currentHeading;
      // Normalize difference to -180 to +180 degrees
      diff = ((diff + 540) % 360) - 180; 
      currentHeading += diff * smoothing;
      // Keep it within 0-360
      currentHeading = (currentHeading + 360) % 360; 
    } else if (targetHeading !== null) {
      currentHeading = targetHeading;
    }

    // Update the Leaflet elements smoothly on screen
    if (marker) {
      marker.setLatLng([currentLat, currentLon]);
    }
    
    updateHeadingCone();
  }

  requestAnimationFrame(animateMapElements);
}
requestAnimationFrame(animateMapElements);

// ── Navigation helpers ────────────────────────────────────────────────────────
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineM(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  var dLon = toRad(lon2 - lon1);
  var y = Math.sin(dLon) * Math.cos(toRad(lat2));
  var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
          Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function bearingLabel(deg) {
  var dirs = ["N","NNO","NO","ONO","O","OZO","ZO","ZZO","Z","ZZW","ZW","WZW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16] + " (" + Math.round(deg) + "\u00b0)";
}

function headingLabel(deg) {
  if (typeof deg !== "number" || !isFinite(deg)) return "-";
  var normalized = ((deg % 360) + 360) % 360;
  return bearingLabel(normalized);
}

function destinationPoint(lat, lon, bearingDeg, distanceM) {
  var R = 6371000;
  var brng = toRad(bearingDeg);
  var lat1 = toRad(lat);
  var lon1 = toRad(lon);
  var angDist = distanceM / R;

  var lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  var lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
  );

  return [toDeg(lat2), toDeg(lon2)];
}

function normalizeDeg(deg) {
  var d = deg;
  while (d < 0) d += 360;
  while (d >= 360) d -= 360;
  return d;
}

function sendTargetHeadingToDevice(headingDeg) {
  if (!directionLedsEnabled) return;
  if (typeof headingDeg !== "number" || !isFinite(headingDeg)) return;

  var now = Date.now();
  var normalized = normalizeDeg(headingDeg);
  var shouldSend = false;

  if (lastTargetSentHeading === null) {
    shouldSend = true;
  } else {
    var diff = Math.abs(normalized - lastTargetSentHeading);
    diff = Math.min(diff, 360 - diff);
    if (diff >= 2) shouldSend = true;
    if (now - lastTargetSentAt >= 1000) shouldSend = true;
  }

  if (!shouldSend) return;

  lastTargetSentHeading = normalized;
  lastTargetSentAt = now;
  fetch(TARGET_URL + "?heading=" + encodeURIComponent(normalized.toFixed(1))).catch(function () {});
}

function getHeadingConeLatLngs(lat, lon, headingDeg) {
  var points = [[lat, lon]];
  var halfAngle = HEADING_CONE_ANGLE_DEG / 2;
  for (var i = 0; i <= HEADING_CONE_STEPS; i++) {
    var t = i / HEADING_CONE_STEPS;
    var b = headingDeg - halfAngle + (HEADING_CONE_ANGLE_DEG * t);
    points.push(destinationPoint(lat, lon, b, HEADING_CONE_RANGE_M));
  }
  points.push([lat, lon]);
  return points;
}

function updateHeadingCone() {
  if (!map || currentLat === null || currentLon === null || currentHeading === null) {
    if (headingCone && map) {
      map.removeLayer(headingCone);
      headingCone = null;
    }
    return;
  }

  var latlngs = getHeadingConeLatLngs(currentLat, currentLon, currentHeading);
  if (!headingCone) {
    headingCone = L.polygon(latlngs, {
      color: "transparent",
      weight: 0,
      opacity: 0,
      fillColor: "#4fc3f7",
      fillOpacity: 0.75,
      interactive: false
    }).addTo(map);
    headingCone.bringToBack();
  } else {
    headingCone.setLatLngs(latlngs);
    headingCone.bringToBack();
  }
}

// ── Recording and path persistence ───────────────────────────────────────────
function loadRecordings() {
  try {
    var raw = localStorage.getItem(RECORDINGS_STORAGE_KEY);
    if (!raw) return;
    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      recordings = [];
      return;
    }
    recordings = parsed.filter(function (rec) {
      return rec && Array.isArray(rec.points) && typeof rec.startedAt === "string";
    });
  } catch (_) {
    recordings = [];
  }
}

function saveRecordings() {
  try {
    localStorage.setItem(RECORDINGS_STORAGE_KEY, JSON.stringify(recordings));
  } catch (_) {}
}

function normalizeRoute(route, source, fallbackId) {
  if (!route || typeof route.name !== "string" || !Array.isArray(route.waypoints)) {
    return null;
  }

  var normalizedWaypoints = [];
  for (var i = 0; i < route.waypoints.length; i++) {
    var wp = route.waypoints[i];
    if (!wp || typeof wp.lat !== "number" || typeof wp.lon !== "number") {
      return null;
    }
    normalizedWaypoints.push({ lat: wp.lat, lon: wp.lon });
  }

  var cleanName = route.name.trim();
  if (!cleanName) {
    cleanName = "Unnamed route";
  }

  var rawId = (typeof route.id === "string" && route.id.trim()) ? route.id.trim() : fallbackId;
  if (!rawId) {
    rawId = String(Date.now()) + "-" + String(Math.floor(Math.random() * 100000));
  }

  var id = source === "github" ? "gh-" + rawId : rawId;

  return {
    id: id,
    source: source,
    name: cleanName,
    createdAt: typeof route.createdAt === "string" ? route.createdAt : new Date().toISOString(),
    waypoints: normalizedWaypoints
  };
}

function getAllRoutes() {
  return githubRoutes.concat(localRoutes);
}

function findRouteById(routeId) {
  if (!routeId) return null;
  var allRoutes = getAllRoutes();
  for (var i = 0; i < allRoutes.length; i++) {
    if (allRoutes[i].id === routeId) {
      return allRoutes[i];
    }
  }
  return null;
}

function loadSavedRoutes() {
  try {
    var raw = localStorage.getItem(LOCAL_ROUTES_STORAGE_KEY);
    if (!raw) {
      localRoutes = [];
      return;
    }

    var parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localRoutes = [];
      return;
    }

    localRoutes = parsed.map(function (route, idx) {
      return normalizeRoute(route, "local", "local-" + idx);
    }).filter(function (route) {
      return route !== null;
    });
  } catch (_) {
    localRoutes = [];
  }
}

function saveSavedRoutes() {
  try {
    localStorage.setItem(LOCAL_ROUTES_STORAGE_KEY, JSON.stringify(localRoutes));
  } catch (_) {}
}

function loadGitHubRoutes() {
  var select = document.getElementById("route-select");
  var prevSelectedId = select ? select.value : "";

  fetch(GITHUB_ROUTES_URL + "?v=" + Date.now(), { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (parsed) {
      if (!Array.isArray(parsed)) {
        githubRoutes = [];
      } else {
        githubRoutes = parsed.map(function (route, idx) {
          return normalizeRoute(route, "github", "github-" + idx);
        }).filter(function (route) {
          return route !== null;
        });
      }
      refreshRouteDropdown(findRouteById(prevSelectedId) ? prevSelectedId : "");
    })
    .catch(function () {
      githubRoutes = [];
      refreshRouteDropdown(findRouteById(prevSelectedId) ? prevSelectedId : "");
    });
}

function refreshRouteDropdown(selectedId) {
  var select = document.getElementById("route-select");
  if (!select) return;
  var allRoutes = getAllRoutes();

  select.innerHTML = "";

  var placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = allRoutes.length ? "Select saved route" : "No saved routes";
  select.appendChild(placeholder);

  for (var i = 0; i < allRoutes.length; i++) {
    var route = allRoutes[i];
    var option = document.createElement("option");
    option.value = route.id;
    var prefix = route.source === "github" ? "GitHub: " : "Local: ";
    option.textContent = prefix + route.name + " (" + route.waypoints.length + " pts)";
    select.appendChild(option);
  }

  if (selectedId) {
    select.value = selectedId;
  } else {
    select.value = "";
  }

  updateRouteButtons();
}

function updateRouteButtons() {
  var saveBtn = document.getElementById("save-route-btn");
  var deleteBtn = document.getElementById("delete-route-btn");
  var select = document.getElementById("route-select");
  if (!saveBtn || !deleteBtn || !select) return;

  var selectedRoute = findRouteById(select.value);
  saveBtn.disabled = waypoints.length === 0;
  deleteBtn.disabled = !selectedRoute || selectedRoute.source !== "local";
}

function clearWaypointsInternal() {
  for (var i = 0; i < wpMarkers.length; i++) {
    map.removeLayer(wpMarkers[i]);
  }
  wpMarkers = [];
  waypoints = [];
  currentWPIndex = 0;
  lastTargetDist = null;

  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
  if (navLine) {
    map.removeLayer(navLine);
    navLine = null;
  }

  updateWPInfo();
  document.getElementById("target-dist").textContent = "-";
  document.getElementById("target-bear").textContent = "-";
  disableDirectionLedsOnDevice();
  updateRouteButtons();
}

function saveCurrentRoute() {
  if (!waypoints.length) {
    window.alert("Add at least one waypoint before saving a route.");
    return;
  }

  var defaultName = "Route " + new Date().toLocaleString();
  var inputName = window.prompt("Route name", defaultName);
  if (inputName === null) return;

  var name = inputName.trim();
  if (!name) {
    window.alert("Route name cannot be empty.");
    return;
  }

  var route = {
    id: "route-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
    source: "local",
    name: name,
    createdAt: new Date().toISOString(),
    waypoints: waypoints.map(function (wp) {
      return { lat: wp.lat, lon: wp.lon };
    })
  };

  localRoutes.push(route);
  saveSavedRoutes();
  refreshRouteDropdown(route.id);
}

function loadRouteById(routeId) {
  if (!routeId) return;
  if (!map || !window.L) {
    window.alert("Map is still loading. Try again in a moment.");
    return;
  }
  var route = findRouteById(routeId);
  if (!route) return;

  loadingRoute = true;
  clearWaypointsInternal();
  for (var j = 0; j < route.waypoints.length; j++) {
    var wp = route.waypoints[j];
    addWaypoint(wp.lat, wp.lon);
  }
  loadingRoute = false;

  if (map && route.waypoints.length) {
    var bounds = L.latLngBounds(route.waypoints.map(function (wp2) {
      return [wp2.lat, wp2.lon];
    }));
    map.fitBounds(bounds, { padding: [24, 24] });
  }

  refreshRouteDropdown(route.id);
}

function loadSelectedRoute() {
  var select = document.getElementById("route-select");
  if (!select || !select.value) {
    updateRouteButtons();
    return;
  }
  loadRouteById(select.value);
}

function deleteSelectedRoute() {
  var select = document.getElementById("route-select");
  if (!select || !select.value) return;

  var routeId = select.value;
  var selectedRoute = findRouteById(routeId);
  if (!selectedRoute) return;
  if (selectedRoute.source !== "local") {
    window.alert("GitHub routes are read-only here. Edit routes.json in your GitHub repo to change them.");
    return;
  }

  var idx = -1;
  for (var i = 0; i < localRoutes.length; i++) {
    if (localRoutes[i].id === routeId) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;

  if (!window.confirm("Delete route '" + localRoutes[idx].name + "'?")) {
    return;
  }

  localRoutes.splice(idx, 1);
  saveSavedRoutes();
  refreshRouteDropdown("");
}

function updateRecordButton() {
  var btn = document.getElementById("record-btn");
  if (!btn) return;
  if (recording) {
    btn.textContent = "■ Stop";
    btn.classList.add("recording");
    btn.setAttribute("aria-pressed", "true");
  } else {
    btn.textContent = "● Record";
    btn.classList.remove("recording");
    btn.setAttribute("aria-pressed", "false");
  }
}

function updateRecordLine() {
  if (!map || !recording || recordingPoints.length < 2) return;
  if (!recordingLine) {
    recordingLine = L.polyline(recordingPoints, {
      color: "#c9a400",
      weight: 3,
      opacity: 0.85
    }).addTo(map);
  } else {
    recordingLine.setLatLngs(recordingPoints);
  }
}

function addRecordPoint(lat, lon) {
  if (!recording) return;
  recordingPoints.push([lat, lon]);
  updateRecordLine();
}

function timestampForFilename(isoString) {
  return isoString.replace(/[.:]/g, "-").replace("T", "_").replace("Z", "");
}

function downloadRecording(rec) {
  try {
    var featureCollection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          startedAt: rec.startedAt,
          points: rec.points.length
        },
        geometry: {
          type: "LineString",
          coordinates: rec.points.map(function (p) { return [p[1], p[0]]; })
        }
      }]
    };

    var blob = new Blob([JSON.stringify(featureCollection, null, 2)], {
      type: "application/geo+json"
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "gps-track-" + timestampForFilename(rec.startedAt) + ".geojson";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  } catch (_) {
    return false;
  }
}

function stopRecording() {
  if (!recording) return;

  recording = false;
  if (recordingLine && map) {
    map.removeLayer(recordingLine);
  }
  recordingLine = null;

  var enoughPoints = recordingPoints.length >= 2;
  if (enoughPoints) {
    var rec = {
      startedAt: recordingStartedAt || new Date().toISOString(),
      endedAt: new Date().toISOString(),
      points: recordingPoints.slice()
    };
    recordings.push(rec);
    saveRecordings();

    // On mobile browsers this usually saves to Downloads or Files.
    if (!downloadRecording(rec)) {
      window.alert("Track saved in browser storage, but download failed.");
    }
  }

  recordingPoints = [];
  recordingStartedAt = null;
  updateRecordButton();
}

function startRecording() {
  recording = true;
  recordingPoints = [];
  recordingStartedAt = new Date().toISOString();
  if (recordingLine && map) {
    map.removeLayer(recordingLine);
    recordingLine = null;
  }
  updateRecordButton();
}

function toggleRecording() {
  if (recording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// ── Waypoint icon (numbered circle) ──────────────────────────────────────────
function wpIcon(n, state) {
  var bg = "#78909c";
  if (state === "active") bg = "#ffd700";
  if (state === "reached") bg = "#4f5961";
  var html = '<div style="background:' + bg + ';color:#fff;border-radius:50%;' +
    'width:26px;height:26px;display:flex;align-items:center;justify-content:center;' +
    'font-weight:bold;font-size:13px;border:2px solid #fff;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.6)">' + n + '</div>';
  return L.divIcon({ className: '', html: html, iconSize: [26, 26], iconAnchor: [13, 13] });
}

function waypointState(i) {
  if (i < currentWPIndex) return "reached";
  if (i === currentWPIndex) return "active";
  return "upcoming";
}

function refreshMarkerIcons() {
  for (var i = 0; i < wpMarkers.length; i++) {
    wpMarkers[i].setIcon(wpIcon(i + 1, waypointState(i)));
  }
}

// ── Placing mode ──────────────────────────────────────────────────────────────
var placingMode = false;
var crosshair   = null;

function togglePlace() {
  placingMode = !placingMode;
  var actionRow  = document.getElementById("action-row");
  var placeBtn   = document.getElementById("place-btn");
  if (placingMode) {
    actionRow.classList.add("placing");
    placeBtn.textContent      = "Done";
    if (!crosshair) {
      crosshair = document.createElement("div");
      crosshair.id = "crosshair";
      crosshair.innerHTML = '<span>&#x271B;</span>';
      document.getElementById("map").appendChild(crosshair);
    }
    crosshair.style.display = "flex";
  } else {
    actionRow.classList.remove("placing");
    placeBtn.textContent      = "Add Waypoints";
    if (crosshair) crosshair.style.display = "none";
  }
}

function confirmWaypoint() {
  if (!map) return;
  var c = map.getCenter();
  addWaypoint(c.lat, c.lng);
}

function addWaypoint(lat, lon) {
  waypoints.push({ lat: lat, lon: lon });
  var idx = waypoints.length - 1;
  var m = L.marker([lat, lon], { icon: wpIcon(idx + 1, waypointState(idx)) }).addTo(map);
  wpMarkers.push(m);

  // Route line through all waypoints
  if (routeLine) {
    map.removeLayer(routeLine);
  }
  if (waypoints.length > 1) {
    var latlngs = waypoints.map(function(wp) { return [wp.lat, wp.lon]; });
    routeLine = L.polyline(latlngs, { color: "#78909c", weight: 2, dashArray: "4,4" }).addTo(map);
  }

  updateWPInfo();
  updateNavigation();
  if (!loadingRoute) {
    updateRouteButtons();
  }
}

function clearWaypoints() {
  if (!window.confirm("Are you sure you want to clear all waypoints?")) {
    return;
  }

  clearWaypointsInternal();
}

function updateWPInfo() {
  var n = waypoints.length;
  var el = document.getElementById("wp-info");
  if (n === 0) {
    el.textContent = "No waypoints yet";
    return;
  }

  var completed = currentWPIndex;
  if (currentWPIndex === n - 1 && lastTargetDist !== null && lastTargetDist <= 10) {
    completed = n;
  }

  var ratio = Math.max(0, Math.min(1, completed / n));
  var percent = (ratio * 100).toFixed(1);
  var text = completed + "/" + n;

  el.innerHTML =
    '<div class="progress-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
    Math.round(ratio * 100) + '">' +
      '<div class="progress-fill" style="width:' + percent + '%"></div>' +
      '<span class="progress-text">' + text + '</span>' +
    '</div>';
}

function updateNavigation() {
  if (waypoints.length === 0 || currentLat === null) return;
  var wp = waypoints[currentWPIndex];
  var d = haversineM(currentLat, currentLon, wp.lat, wp.lon);
  // Auto-advance when within 10 m of current waypoint
  if (d <= 10 && currentWPIndex < waypoints.length - 1) {
    currentWPIndex++;
    refreshMarkerIcons();
    updateWPInfo();
    wp = waypoints[currentWPIndex];
    d  = haversineM(currentLat, currentLon, wp.lat, wp.lon);
  }
  lastTargetDist = d;
  updateWPInfo();
  var b = bearing(currentLat, currentLon, wp.lat, wp.lon);
  sendTargetHeadingToDevice(b);
  document.getElementById("target-dist").textContent =
    d >= 1000 ? (d / 1000).toFixed(2) + " km" : d.toFixed(0) + " m";
  document.getElementById("target-bear").textContent = bearingLabel(b);
  if (map) {
    if (!navLine) {
      navLine = L.polyline([], { color: "#ffd700", weight: 2, dashArray: "6,6" }).addTo(map);
    }
    navLine.setLatLngs([[currentLat, currentLon], [wp.lat, wp.lon]]);
  }
}

// ── Map (loaded lazily; works only when phone has internet) ───────────────────
function initMap() {
  var mapDiv = document.getElementById("map");
  mapDiv.textContent = "Loading map...";

  var css = document.createElement("link");
  css.rel  = "stylesheet";
  css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  document.head.appendChild(css);

  var js   = document.createElement("script");
  js.src   = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  js.onload = function () {
    mapDiv.textContent = "";
    map = L.map("map").setView([52.0, 5.1], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);

    if (recording && recordingPoints.length > 1) {
      updateRecordLine();
    }
  };
  js.onerror = function () {
    mapDiv.textContent = "Map unavailable (no internet)";
  };
  document.head.appendChild(js);
}

// ── Data polling ──────────────────────────────────────────────────────────────
function update() {
  fetch(DATA_URL)
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (d) {
      var conn = document.getElementById("conn");
      conn.textContent  = "OK \u2013 " + new Date().toLocaleTimeString();
      conn.className    = "value ok";

      var st = document.getElementById("status");
      if (d.fix) {
        st.textContent = "Fix acquired";
        st.className   = "value fix";
        
        // Update Target values instead of direct assignment
        targetLat = d.lat;
        targetLon = d.lon;

        // Snap immediately if this is the very first time we get a fix
        if (currentLat === null) {
          currentLat = targetLat;
          currentLon = targetLon;
        }

        if (map) {
          if (!marker) {
            marker = L.marker([currentLat, currentLon]).addTo(map);
            map.setView([currentLat, currentLon], 17);
          }
        }
        
        addRecordPoint(d.lat, d.lon);
        updateNavigation();
      } else {
        st.textContent = "No fix (waiting for GPS)";
        st.className   = "value no-fix";
      }

      // Update heading target
      if (typeof d.heading !== "undefined" && !isNaN(d.heading)) {
        document.getElementById("heading").textContent = d.heading;
        targetHeading = d.heading;

        // Snap immediately on first heading
        if (currentHeading === null) currentHeading = targetHeading;
      } else {
        document.getElementById("heading").textContent = "-";
        targetHeading = null;
      }

      document.getElementById("sats").textContent  = d.sats_valid ? d.sats + " sats"             : "0 sats";
      document.getElementById("speed").textContent = d.spd_valid  ? d.spd.toFixed(1)  + " km/h" : "-";
    })
    .catch(function (err) {
      var conn = document.getElementById("conn");
      conn.textContent = "Error: " + err.message;
      conn.className   = "value err";
    });
}

// Start immediately, then every 200 ms for smoother heading updates
loadRecordings();
loadSavedRoutes();
refreshRouteDropdown("");
loadGitHubRoutes();
updateRecordButton();
update();
setInterval(update, 200);
if (document.readyState === "complete") {
  initMap();
} else {
  window.addEventListener("load", initMap);
}