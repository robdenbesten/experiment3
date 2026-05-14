// The page is served by the ESP32 over HTTP, so window.location.hostname
// is always the ESP32's IP. No hardcoded address needed.
var DATA_URL = "http://" + window.location.hostname + "/data";

// ── Build DOM ─────────────────────────────────────────────────────────────────
var app = document.getElementById("app");
app.innerHTML = [
  '<h2>GPS Tracker V4</h2>',
  '<div class="grid">',
    card("",     "conn",        "Connection",              "Connecting..."),
    card("",     "status",      "GPS Status",              "-"),
    card("",     "sats",        "Satellites",              "-"),
    card("",     "speed",       "Speed",                   "-"),
    card("full", "wp-info",     "Waypoint",                "No waypoints yet"),
    card("",     "target-dist", "Distance to waypoint",    "-"),
    card("",     "target-bear", "Direction to waypoint",   "-"),
    '<div class="card full btn-row" id="action-row">',
      '<div class="action-stack">',
        '<button id="confirm-btn" onclick="confirmWaypoint()">&#x2713; Confirm</button>',
        '<button id="place-btn" onclick="togglePlace()">&#x271B; Add</button>',
      '</div>',
      '<button id="clear-btn" onclick="clearWaypoints()" aria-label="Clear waypoints">&#x2715;</button>',
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

var map            = null;
var marker         = null;   // current position marker (blue)
var waypoints      = [];     // [{lat, lon}, ...]
var wpMarkers      = [];     // Leaflet markers per waypoint
var routeLine      = null;   // polyline through all waypoints
var navLine        = null;   // dashed line: position → current waypoint
var currentWPIndex = 0;      // which waypoint we're navigating to
var currentLat     = null;
var currentLon     = null;
var lastTargetDist = null;

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
    placeBtn.textContent      = "Cancel";
    if (!crosshair) {
      crosshair = document.createElement("div");
      crosshair.id = "crosshair";
      crosshair.innerHTML = '<span>&#x271B;</span>';
      document.getElementById("map").appendChild(crosshair);
    }
    crosshair.style.display = "flex";
  } else {
    actionRow.classList.remove("placing");
    placeBtn.textContent      = "\u271B Add";
    if (crosshair) crosshair.style.display = "none";
  }
}

function confirmWaypoint() {
  if (!map) return;
  var c = map.getCenter();
  addWaypoint(c.lat, c.lng);
  togglePlace();
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
}

function clearWaypoints() {
  if (!window.confirm("Are you sure you want to clear all waypoints?")) {
    return;
  }

  for (var i = 0; i < wpMarkers.length; i++) { map.removeLayer(wpMarkers[i]); }
  wpMarkers  = [];
  waypoints  = [];
  currentWPIndex = 0;
  lastTargetDist = null;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (navLine)   { map.removeLayer(navLine);   navLine   = null; }
  updateWPInfo();
  document.getElementById("target-dist").textContent = "-";
  document.getElementById("target-bear").textContent = "-";
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

    // No tap handler needed — target is set from map center via confirm button
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
        currentLat = d.lat;
        currentLon = d.lon;
        if (map) {
          if (marker) {
            marker.setLatLng([d.lat, d.lon]);
          } else {
            marker = L.marker([d.lat, d.lon]).addTo(map);
            map.setView([d.lat, d.lon], 17);
          }
        }
        updateNavigation();
      } else {
        st.textContent = "No fix (waiting for GPS)";
        st.className   = "value no-fix";
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

// Start immediately, then every second
update();
setInterval(update, 1000);
if (document.readyState === "complete") {
  initMap();
} else {
  window.addEventListener("load", initMap);
}
