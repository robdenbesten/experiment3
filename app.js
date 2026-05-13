// The page is served by the ESP32 over HTTP, so window.location.hostname
// is always the ESP32's IP. No hardcoded address needed.
var DATA_URL = "http://" + window.location.hostname + "/data";

// ── Build DOM ─────────────────────────────────────────────────────────────────
var app = document.getElementById("app");
app.innerHTML = [
  '<h2>GPS Tracker</h2>',
  '<div class="grid">',
    card("full", "conn",   "Verbinding",        "Verbinden..."),
    card("full", "status", "GPS Status",         "-"),
    card("",     "lat",    "Latitude",           "-"),
    card("",     "lon",    "Longitude",          "-"),
    card("",     "alt",    "Hoogte",             "-"),
    card("",     "sats",   "Satellieten",        "-"),
    card("",     "dist",   "Afstand tot vorig",  "-"),
    card("",     "speed",  "Snelheid",           "-"),
  '</div>',
  '<div id="map"></div>'
].join("");

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
