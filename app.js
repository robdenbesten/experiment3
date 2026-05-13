// The page is served by the ESP32 over HTTP, so window.location.hostname
// is always the ESP32's IP. No hardcoded address needed.
var DATA_URL = "http://" + window.location.hostname + "/data";

// ── Build DOM ─────────────────────────────────────────────────────────────────
var app = document.getElementById("app");
app.innerHTML = [
  '<h2>GPS Tracker V4</h2>',
  '<div class="grid">',
    card("full", "conn",        "Verbinding",              "Verbinden..."),
    card("full", "status",      "GPS Status",              "-"),
    card("",     "lat",         "Latitude",                "-"),
    card("",     "lon",         "Longitude",               "-"),
    card("",     "alt",         "Hoogte",                  "-"),
    card("",     "sats",        "Satellieten",             "-"),
    card("",     "dist",        "Afstand tot vorig",       "-"),
    card("",     "speed",       "Snelheid",                "-"),
    card("full", "wp-info",     "Waypoint",                "Nog geen waypoints"),
    card("",     "target-dist", "Afstand naar waypoint",   "-"),
    card("",     "target-bear", "Richting naar waypoint",  "-"),
    '<div class="card full btn-row">',
      '<button id="place-btn" onclick="togglePlace()">&#x271B; Voeg toe</button>',
      '<button id="confirm-btn" onclick="confirmWaypoint()" style="display:none;background:#a5d6a7">&#x2713; Bevestig</button>',
      '<button id="next-btn"  onclick="nextWaypoint()"  style="display:none;background:#fff176;color:#1a1a2e">&rarr; Volgende</button>',
      '<button id="clear-btn" onclick="clearWaypoints()">&#x2715; Wissen</button>',
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
function wpIcon(n, active) {
  var bg = active ? "#ef5350" : "#78909c";
  var html = '<div style="background:' + bg + ';color:#fff;border-radius:50%;' +
    'width:26px;height:26px;display:flex;align-items:center;justify-content:center;' +
    'font-weight:bold;font-size:13px;border:2px solid #fff;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.6)">' + n + '</div>';
  return L.divIcon({ className: '', html: html, iconSize: [26, 26], iconAnchor: [13, 13] });
}

function refreshMarkerIcons() {
  for (var i = 0; i < wpMarkers.length; i++) {
    wpMarkers[i].setIcon(wpIcon(i + 1, i === currentWPIndex));
  }
}

// ── Placing mode ──────────────────────────────────────────────────────────────
var placingMode = false;
var crosshair   = null;

function togglePlace() {
  placingMode = !placingMode;
  var placeBtn   = document.getElementById("place-btn");
  var confirmBtn = document.getElementById("confirm-btn");
  if (placingMode) {
    placeBtn.textContent      = "Annuleer";
    placeBtn.style.background = "#ef9a9a";
    confirmBtn.style.display  = "";
    if (!crosshair) {
      crosshair = document.createElement("div");
      crosshair.id = "crosshair";
      crosshair.innerHTML = '<span>&#x271B;</span>';
      document.getElementById("map").appendChild(crosshair);
    }
    crosshair.style.display = "flex";
  } else {
    placeBtn.textContent      = "\u271B Voeg toe";
    placeBtn.style.background = "";
    confirmBtn.style.display  = "none";
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
  var m = L.marker([lat, lon], { icon: wpIcon(idx + 1, idx === currentWPIndex) }).addTo(map);
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
  for (var i = 0; i < wpMarkers.length; i++) { map.removeLayer(wpMarkers[i]); }
  wpMarkers  = [];
  waypoints  = [];
  currentWPIndex = 0;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (navLine)   { map.removeLayer(navLine);   navLine   = null; }
  document.getElementById("wp-info").textContent     = "Nog geen waypoints";
  document.getElementById("target-dist").textContent = "-";
  document.getElementById("target-bear").textContent = "-";
  document.getElementById("next-btn").style.display  = "none";
}

function nextWaypoint() {
  if (currentWPIndex < waypoints.length - 1) {
    currentWPIndex++;
    refreshMarkerIcons();
    updateWPInfo();
    updateNavigation();
  }
}

function updateWPInfo() {
  var n = waypoints.length;
  if (n === 0) {
    document.getElementById("wp-info").textContent = "Nog geen waypoints";
    document.getElementById("next-btn").style.display = "none";
    return;
  }
  var wp = waypoints[currentWPIndex];
  document.getElementById("wp-info").textContent =
    (currentWPIndex + 1) + " / " + n + " \u2014 " +
    wp.lat.toFixed(6) + "\u00b0, " + wp.lon.toFixed(6) + "\u00b0";
  document.getElementById("next-btn").style.display =
    (n > 1 && currentWPIndex < n - 1) ? "" : "none";
}

function updateNavigation() {
  if (waypoints.length === 0 || currentLat === null) return;
  var wp = waypoints[currentWPIndex];
  var d = haversineM(currentLat, currentLon, wp.lat, wp.lon);
  var b = bearing(currentLat, currentLon, wp.lat, wp.lon);
  document.getElementById("target-dist").textContent =
    d >= 1000 ? (d / 1000).toFixed(2) + " km" : d.toFixed(0) + " m";
  document.getElementById("target-bear").textContent = bearingLabel(b);
  if (map) {
    if (!navLine) {
      navLine = L.polyline([], { color: "#ef5350", weight: 2, dashArray: "6,6" }).addTo(map);
    }
    navLine.setLatLngs([[currentLat, currentLon], [wp.lat, wp.lon]]);
  }
}

// ── Map (loaded lazily; works only when phone has internet) ───────────────────
function initMap() {
  var mapDiv = document.getElementById("map");
  mapDiv.textContent = "Kaart laden...";

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
    mapDiv.textContent = "Kaart niet beschikbaar (geen internet)";
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
        st.textContent = "Fix verkregen";
        st.className   = "value fix";
        currentLat = d.lat;
        currentLon = d.lon;
        document.getElementById("lat").textContent  = d.lat.toFixed(6) + "\u00b0";
        document.getElementById("lon").textContent  = d.lon.toFixed(6) + "\u00b0";
        document.getElementById("dist").textContent = d.dist.toFixed(2) + " m";
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
        st.textContent = "Geen fix (wachten op GPS)";
        st.className   = "value no-fix";
      }

      document.getElementById("alt").textContent   = d.alt_valid  ? d.alt.toFixed(1)  + " m"    : "-";
      document.getElementById("sats").textContent  = d.sats_valid ? d.sats + " sats"             : "0 sats";
      document.getElementById("speed").textContent = d.spd_valid  ? d.spd.toFixed(1)  + " km/h" : "-";
    })
    .catch(function (err) {
      var conn = document.getElementById("conn");
      conn.textContent = "Fout: " + err.message;
      conn.className   = "value err";
    });
}

// Start immediately, then every second
update();
setInterval(update, 1000);
window.addEventListener("load", initMap);
