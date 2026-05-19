// The page is served by the ESP32 over HTTP
var DATA_URL = "http://" + window.location.hostname + "/data";

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
    '<div class="card full" style="text-align:center;margin-top:8px;">',
      '<button id="calibrate-btn" style="padding:8px 18px;font-size:1em;">Calibrate Magnetometer</button>',
      '<span id="calib-status" style="margin-left:12px;color:#ffd700;"></span>',
    '</div>',
  '</div>',
  '<div id="map"></div>'
].join("");

function card(extra, id, label, init) {
  return '<div class="card ' + extra + '">' +
    '<div class="label">' + label + '</div>' +
    '<div class="value" id="' + id + '">' + init + '</div>' +
    '</div>';
}

// ── State & Animation Variables ───────────────────────────────────────────────
var map            = null;
var marker         = null;
var waypoints      = [];
var wpMarkers      = [];
var routeLine      = null;
var navLine        = null;
var currentWPIndex = 0;

// Animation Targets vs Current (Interpolation)
var currentLat     = null;
var currentLon     = null;
var currentHeading = null;
var targetLat      = null;
var targetLon      = null;
var targetHeading  = null;

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
var HEADING_CONE_RANGE_PX  = 45; // Screen size in pixels
var HEADING_CONE_STEPS     = 12;

// ── Animation Loop (60 FPS) ──────────────────────────────────────────────────
function animateMapElements() {
  if (currentLat !== null && targetLat !== null) {
    var smoothing = 0.15; // Lower = smoother/slower, Higher = snappier
    
    // Interpolate Position
    currentLat += (targetLat - currentLat) * smoothing;
    currentLon += (targetLon - currentLon) * smoothing;

    // Interpolate Heading (Shortest Path)
    if (currentHeading !== null && targetHeading !== null) {
      var diff = targetHeading - currentHeading;
      diff = ((diff + 540) % 360) - 180; 
      currentHeading += diff * smoothing;
      currentHeading = (currentHeading + 360) % 360; 
    } else if (targetHeading !== null) {
      currentHeading = targetHeading;
    }

    // 1. Move Pin
    if (marker) {
      marker.setLatLng([currentLat, currentLon]);
    }
    
    // 2. Update Heading Cone
    updateHeadingCone();

    // 3. Update Navigation UI smoothly
    if (waypoints.length > 0) {
      var wp = waypoints[currentWPIndex];
      var d = haversineM(currentLat, currentLon, wp.lat, wp.lon);
      var b = bearing(currentLat, currentLon, wp.lat, wp.lon);
      
      // Auto-advance logic
      if (d <= 10 && currentWPIndex < waypoints.length - 1) {
        currentWPIndex++;
        refreshMarkerIcons();
        updateWPInfo();
      }

      lastTargetDist = d;
      document.getElementById("target-dist").textContent =
        d >= 1000 ? (d / 1000).toFixed(2) + " km" : d.toFixed(1) + " m";
      document.getElementById("target-bear").textContent = bearingLabel(b);
      
      if (navLine) {
        navLine.setLatLngs([[currentLat, currentLon], [wp.lat, wp.lon]]);
      }
    }
  }
  requestAnimationFrame(animateMapElements);
}

// ── Heading Cone logic ────────────────────────────────────────────────────────
function getHeadingConeLatLngs(lat, lon, headingDeg) {
  var centerLatLng = L.latLng(lat, lon);
  var points = [[lat, lon]];
  
  // Calculate ground meters for fixed pixel size
  var pointPx = map.latLngToLayerPoint(centerLatLng);
  var edgePx = L.point(pointPx.x, pointPx.y - HEADING_CONE_RANGE_PX);
  var edgeLatLng = map.layerPointToLatLng(edgePx);
  var dynamicRangeM = centerLatLng.distanceTo(edgeLatLng);

  var halfAngle = HEADING_CONE_ANGLE_DEG / 2;
  for (var i = 0; i <= HEADING_CONE_STEPS; i++) {
    var t = i / HEADING_CONE_STEPS;
    var b = headingDeg - halfAngle + (HEADING_CONE_ANGLE_DEG * t);
    points.push(destinationPoint(lat, lon, b, dynamicRangeM));
  }
  points.push([lat, lon]);
  return points;
}

function updateHeadingCone() {
  if (!map || !map._loaded || currentLat === null || currentLon === null || currentHeading === null) {
    if (headingCone && map) { map.removeLayer(headingCone); headingCone = null; }
    return;
  }
  var latlngs = getHeadingConeLatLngs(currentLat, currentLon, currentHeading);
  if (!headingCone) {
    headingCone = L.polygon(latlngs, {
      color: "transparent", weight: 0, fillColor: "#4fc3f7", fillOpacity: 0.6, interactive: false
    }).addTo(map);
    headingCone.bringToBack();
  } else {
    headingCone.setLatLngs(latlngs);
  }
}

// ── Navigation Helpers ────────────────────────────────────────────────────────
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }

function haversineM(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  var dLon = toRad(lon2 - lon1);
  var y = Math.sin(dLon) * Math.cos(toRad(lat2));
  var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function bearingLabel(deg) {
  var dirs = ["N","NNO","NO","ONO","O","OZO","ZO","ZZO","Z","ZZW","ZW","WZW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16] + " (" + Math.round(deg) + "\u00b0)";
}

function destinationPoint(lat, lon, brngDeg, distM) {
  var R = 6371000, brng = toRad(brngDeg), lat1 = toRad(lat), lon1 = toRad(lon), ang = distM / R;
  var lat2 = Math.asin(Math.sin(lat1)*Math.cos(ang) + Math.cos(lat1)*Math.sin(ang)*Math.cos(brng));
  var lon2 = lon1 + Math.atan2(Math.sin(brng)*Math.sin(ang)*Math.cos(lat1), Math.cos(ang)-Math.sin(lat1)*Math.sin(lat2));
  return [toDeg(lat2), toDeg(lon2)];
}

// ── Persistence & Route Management ────────────────────────────────────────────
function loadRecordings() {
  try {
    var raw = localStorage.getItem(RECORDINGS_STORAGE_KEY);
    recordings = raw ? JSON.parse(raw) : [];
  } catch(_) { recordings = []; }
}

function saveRecordings() { localStorage.setItem(RECORDINGS_STORAGE_KEY, JSON.stringify(recordings)); }

function loadSavedRoutes() {
  try {
    var raw = localStorage.getItem(LOCAL_ROUTES_STORAGE_KEY);
    localRoutes = raw ? JSON.parse(raw).map(r => normalizeRoute(r, "local")).filter(r => r) : [];
  } catch(_) { localRoutes = []; }
}

function normalizeRoute(r, src, fallId) {
  if(!r || !r.name || !Array.isArray(r.waypoints)) return null;
  return {
    id: r.id || fallId || Date.now(),
    source: src,
    name: r.name.trim() || "Unnamed",
    waypoints: r.waypoints.map(wp => ({lat: wp.lat, lon: wp.lon}))
  };
}

function loadGitHubRoutes() {
  fetch(GITHUB_ROUTES_URL + "?v=" + Date.now(), { cache: "no-store" })
    .then(r => r.json())
    .then(data => {
      githubRoutes = Array.isArray(data) ? data.map(r => normalizeRoute(r, "github")).filter(r => r) : [];
      refreshRouteDropdown("");
    }).catch(() => refreshRouteDropdown(""));
}

function refreshRouteDropdown(selId) {
  var select = document.getElementById("route-select");
  if(!select) return;
  var all = githubRoutes.concat(localRoutes);
  select.innerHTML = '<option value="">' + (all.length ? "Select saved route" : "No saved routes") + '</option>';
  all.forEach(r => {
    var opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = (r.source === "github" ? "GH: " : "L: ") + r.name;
    select.appendChild(opt);
  });
  if(selId) select.value = selId;
  updateRouteButtons();
}

function updateRouteButtons() {
  var sel = document.getElementById("route-select").value;
  var route = githubRoutes.concat(localRoutes).find(r => r.id == sel);
  document.getElementById("save-route-btn").disabled = waypoints.length === 0;
  document.getElementById("delete-route-btn").disabled = !route || route.source !== "local";
}

function saveCurrentRoute() {
  if(!waypoints.length) return;
  var name = window.prompt("Route name", "Route " + new Date().toLocaleString());
  if(!name) return;
  var route = normalizeRoute({name: name, waypoints: waypoints}, "local", "loc-" + Date.now());
  localRoutes.push(route);
  localStorage.setItem(LOCAL_ROUTES_STORAGE_KEY, JSON.stringify(localRoutes));
  refreshRouteDropdown(route.id);
}

function loadSelectedRoute() {
  var id = document.getElementById("route-select").value;
  var route = githubRoutes.concat(localRoutes).find(r => r.id == id);
  if(!route) return;
  loadingRoute = true;
  clearWaypointsInternal();
  route.waypoints.forEach(wp => addWaypoint(wp.lat, wp.lon));
  loadingRoute = false;
  if(map && route.waypoints.length) map.fitBounds(L.latLngBounds(route.waypoints.map(w=>[w.lat, w.lon])), {padding:[24,24]});
  updateRouteButtons();
}

function deleteSelectedRoute() {
  var id = document.getElementById("route-select").value;
  localRoutes = localRoutes.filter(r => r.id != id);
  localStorage.setItem(LOCAL_ROUTES_STORAGE_KEY, JSON.stringify(localRoutes));
  refreshRouteDropdown("");
}

// ── Recording ─────────────────────────────────────────────────────────────────
function toggleRecording() {
  if(recording) {
    recording = false;
    if(recordingLine) map.removeLayer(recordingLine);
    if(recordingPoints.length >= 2) {
      var rec = { startedAt: recordingStartedAt, points: [...recordingPoints] };
      recordings.push(rec);
      saveRecordings();
      downloadRecording(rec);
    }
    recordingPoints = [];
  } else {
    recording = true;
    recordingPoints = [];
    recordingStartedAt = new Date().toISOString();
  }
  updateRecordButton();
}

function updateRecordButton() {
  var btn = document.getElementById("record-btn");
  btn.textContent = recording ? "■ Stop" : "● Record";
  btn.classList.toggle("recording", recording);
}

function addRecordPoint(lat, lon) {
  if(!recording) return;
  recordingPoints.push([lat, lon]);
  if(!recordingLine) {
    recordingLine = L.polyline(recordingPoints, {color: "#c9a400", weight:3}).addTo(map);
  } else {
    recordingLine.setLatLngs(recordingPoints);
  }
}

function downloadRecording(rec) {
  var geo = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: rec.points.map(p=>[p[1],p[0]]) }}]};
  var blob = new Blob([JSON.stringify(geo)], {type:"application/geo+json"});
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "track.geojson"; a.click();
}

// ── Waypoints & Map UI ────────────────────────────────────────────────────────
function wpIcon(n, state) {
  var bg = (state==="active") ? "#ffd700" : (state==="reached" ? "#4f5961" : "#78909c");
  return L.divIcon({ 
    className: '', 
    html: '<div style="background:'+bg+';color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:bold;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6)">'+n+'</div>',
    iconSize: [26, 26], iconAnchor: [13, 13]
  });
}

function refreshMarkerIcons() { wpMarkers.forEach((m, i) => m.setIcon(wpIcon(i+1, i < currentWPIndex ? "reached" : (i===currentWPIndex ? "active" : "upcoming")))); }

function addWaypoint(lat, lon) {
  waypoints.push({lat, lon});
  var m = L.marker([lat, lon], {icon: wpIcon(waypoints.length, waypoints.length-1 === currentWPIndex ? "active" : "upcoming")}).addTo(map);
  wpMarkers.push(m);
  if(routeLine) map.removeLayer(routeLine);
  if(waypoints.length > 1) routeLine = L.polyline(waypoints.map(w=>[w.lat, w.lon]), {color:"#78909c", weight:2, dashArray:"4,4"}).addTo(map);
  updateWPInfo();
  if(!loadingRoute) updateRouteButtons();
}

function clearWaypointsInternal() {
  wpMarkers.forEach(m => map.removeLayer(m));
  wpMarkers = []; waypoints = []; currentWPIndex = 0;
  if(routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if(navLine) { map.removeLayer(navLine); navLine = null; }
  updateWPInfo();
}

function clearWaypoints() { if(confirm("Clear all?")) clearWaypointsInternal(); }

function updateWPInfo() {
  var n = waypoints.length;
  var el = document.getElementById("wp-info");
  if(n === 0) { el.textContent = "No waypoints yet"; return; }
  var pct = Math.round((currentWPIndex / n) * 100);
  el.innerHTML = '<div class="progress-wrap"><div class="progress-fill" style="width:'+pct+'%"></div><span class="progress-text">'+currentWPIndex+'/'+n+'</span></div>';
}

var placingMode = false, crosshair = null;
function togglePlace() {
  placingMode = !placingMode;
  document.getElementById("action-row").classList.toggle("placing", placingMode);
  document.getElementById("place-btn").textContent = placingMode ? "Done" : "Add Waypoints";
  if(!crosshair) { crosshair = document.createElement("div"); crosshair.id = "crosshair"; crosshair.innerHTML = '<span>&#x271B;</span>'; document.getElementById("map").appendChild(crosshair); }
  crosshair.style.display = placingMode ? "flex" : "none";
}

function confirmWaypoint() { if(map) addWaypoint(map.getCenter().lat, map.getCenter().lng); }

// ── Magnetometer Calibration ────────────────────────────────────────────────
var calibrating = false;
var calibBtn = document.getElementById("calibrate-btn");
if (calibBtn) {
  calibBtn.addEventListener("click", function() {
    if (calibrating) return;
    calibrating = true; calibBtn.disabled = true;
    document.getElementById("calib-status").textContent = "Rotate 360° for 10s...";
    fetch("/calibrate").then(() => {
      setTimeout(() => {
        calibrating = false; calibBtn.disabled = false;
        document.getElementById("calib-status").textContent = "Success!";
        setTimeout(() => document.getElementById("calib-status").textContent = "", 3000);
      }, 10500);
    });
  });
}

// ── Initialization ────────────────────────────────────────────────────────────
function initMap() {
  var css = document.createElement("link"); css.rel="stylesheet"; css.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"; document.head.appendChild(css);
  var js = document.createElement("script"); js.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  js.onload = function() {
    map = L.map("map").setView([52.0, 5.1], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OSM" }).addTo(map);
    requestAnimationFrame(animateMapElements);
  };
  document.head.appendChild(js);
}

function update() {
  fetch(DATA_URL).then(r => r.json()).then(d => {
    document.getElementById("conn").textContent = "OK - " + new Date().toLocaleTimeString();
    document.getElementById("conn").className = "value ok";
    if (d.fix) {
      document.getElementById("status").textContent = "Fix acquired";
      document.getElementById("status").className = "value fix";
      targetLat = d.lat; targetLon = d.lon;
      if (currentLat === null) { currentLat = targetLat; currentLon = targetLon; }
      if (map && !marker) { marker = L.marker([currentLat, currentLon]).addTo(map); map.setView([currentLat, currentLon], 17); }
      addRecordPoint(d.lat, d.lon);
    } else {
      document.getElementById("status").textContent = "No fix";
      document.getElementById("status").className = "value no-fix";
    }
    if (d.heading !== undefined) {
      document.getElementById("heading").textContent = Math.round(d.heading) + "°";
      targetHeading = d.heading;
      if (currentHeading === null) currentHeading = targetHeading;
    }
    document.getElementById("sats").textContent = d.sats + " sats";
    document.getElementById("speed").textContent = d.spd ? d.spd.toFixed(1) + " km/h" : "-";
  }).catch(() => { document.getElementById("conn").className = "value err"; });
}

loadRecordings(); loadSavedRoutes(); loadGitHubRoutes();
setInterval(update, 200);
window.addEventListener("load", initMap);