// The page is served by the ESP32 over HTTP, so window.location.hostname
// is always the ESP32's IP. No hardcoded address needed.
var DATA_URL = "http://" + window.location.hostname + "/data";

// ── Build DOM ─────────────────────────────────────────────────────────────────
var app = document.getElementById("app");
app.innerHTML = [
  '<h2>GPS Tracker V2</h2>',
  '<div class="grid">',
    card("full", "conn",        "Verbinding",           "Verbinden..."),
    card("full", "status",      "GPS Status",           "-"),
    card("",     "lat",         "Latitude",             "-"),
    card("",     "lon",         "Longitude",            "-"),
    card("",     "alt",         "Hoogte",               "-"),
    card("",     "sats",        "Satellieten",          "-"),
    card("",     "dist",        "Afstand tot vorig",    "-"),
    card("",     "speed",       "Snelheid",             "-"),
    card("full", "target-info", "Doel",                 "Klik op de kaart om een doel te zetten"),
    card("",     "target-dist", "Afstand naar doel",    "-"),
    card("",     "target-bear", "Richting naar doel",   "-"),
  '</div>',
  '<div id="map"></div>'
].join("");

function card(extra, id, label, init) {
  return '<div class="card ' + extra + '">' +
    '<div class="label">' + label + '</div>' +
    '<div class="value" id="' + id + '">' + init + '</div>' +
    '</div>';
}

var map          = null;
var marker       = null;   // current position marker (blue)
var targetMarker = null;   // goal marker (red)
var targetLine   = null;   // line between position and goal
var targetLat    = null;
var targetLon    = null;
var currentLat   = null;
var currentLon   = null;

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

function updateNavigation() {
  if (targetLat === null || currentLat === null) return;
  var d = haversineM(currentLat, currentLon, targetLat, targetLon);
  var b = bearing(currentLat, currentLon, targetLat, targetLon);
  document.getElementById("target-dist").textContent =
    d >= 1000 ? (d / 1000).toFixed(2) + " km" : d.toFixed(0) + " m";
  document.getElementById("target-bear").textContent = bearingLabel(b);
  if (map && targetLine) {
    targetLine.setLatLngs([[currentLat, currentLon], [targetLat, targetLon]]);
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

    // Click to set target
    map.on("click", function (e) {
      targetLat = e.latlng.lat;
      targetLon = e.latlng.lng;

      var redIcon = L.icon({
        iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
        iconSize: [25, 41], iconAnchor: [12, 41]
      });

      if (targetMarker) {
        targetMarker.setLatLng([targetLat, targetLon]);
      } else {
        targetMarker = L.marker([targetLat, targetLon], { icon: redIcon }).addTo(map);
        targetLine   = L.polyline([], { color: "#ef9a9a", dashArray: "6,6" }).addTo(map);
      }

      document.getElementById("target-info").textContent =
        targetLat.toFixed(6) + "\u00b0, " + targetLon.toFixed(6) + "\u00b0";
      updateNavigation();
    });
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
          map.panTo([d.lat, d.lon]);
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

function card(extra, id, label, init) {
  return '<div class="card ' + extra + '">' +
    '<div class="label">' + label + '</div>' +
    '<div class="value" id="' + id + '">' + init + '</div>' +
    '</div>';
}

var map    = null;
var marker = null;

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
          map.panTo([d.lat, d.lon]);
        }
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
