let map, routeLayer, startMarker, endMarker, crimeHeat, crimeMarkers = [], crimePoints = [], lastRoute = null;
let mapInteractionEnabled = false;
let mapToggleBtn = null;
const isMobile = window.matchMedia('(max-width:720px)').matches;

function initMap(){
  map = L.map('map').setView([29.7604, -95.3698], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  L.control.scale().addTo(map);

  // On small screens, disable map dragging/zoom to allow page scrolling
  if (isMobile) {
    try{
      map.dragging.disable();
      map.touchZoom.disable();
      map.doubleClickZoom.disable();
      map.scrollWheelZoom.disable();
    }catch(e){}

    // Create map interaction toggle button
    setTimeout(() => {
      mapToggleBtn = document.createElement('button');
      mapToggleBtn.id = 'mapToggleBtn';
      mapToggleBtn.innerText = 'Enable Map';
      mapToggleBtn.title = 'Enable map dragging and interaction';
      mapToggleBtn.className = 'map-enable-btn';
      mapToggleBtn.type = 'button';
      document.body.appendChild(mapToggleBtn);
      
      mapToggleBtn.addEventListener('click', toggleMapInteraction);
    }, 500);
  }

  document.getElementById('routeBtn').addEventListener('click', calculateRoute);
  document.getElementById('shareBtn').addEventListener('click', shareRoute);
  document.getElementById('loadCrimeBtn').addEventListener('click', ()=>{
    const url = document.getElementById('crimeUrl').value.trim();
    if (url) loadCrimeDataFromUrl(url); else loadSampleCrimeData();
  });
  document.getElementById('toggleCrime').addEventListener('change', (e)=>{ toggleCrime(e.target.checked); });
  document.getElementById('loadHoustonBtn').addEventListener('click', ()=>{
    const did = document.getElementById('houstonDataset').value.trim();
    const token = document.getElementById('houstonToken').value.trim();
    if (!did) { setShareMessage('Enter a Houston dataset ID.'); return; }
    loadHoustonData(did, token);
  });

  const toggle = document.getElementById('controlsToggle');
  const panel = document.querySelector('.controls-panel');
  if (toggle && panel){ toggle.addEventListener('click', ()=>{ panel.classList.toggle('closed'); }); }

  const legend = document.getElementById('legend');
  const legendPopup = document.getElementById('legendPopup');
  const closeLegend = document.getElementById('closeLegend');
  if (legend && legendPopup){ legend.addEventListener('click', ()=> legendPopup.classList.toggle('hidden')); }
  if (closeLegend) closeLegend.addEventListener('click', ()=> legendPopup.classList.add('hidden'));

  if (navigator.geolocation){
    navigator.geolocation.getCurrentPosition(p=>{ map.setView([p.coords.latitude, p.coords.longitude], 14); }, ()=>{});
  }

  loadSampleCrimeData();
}

function setShareMessage(msg){ document.getElementById('shareMessage').textContent = msg; }

function clearMessages(){ setShareMessage(''); document.getElementById('routeDetails').innerHTML=''; document.getElementById('scoreBreakdown').innerHTML=''; }

function toggleMapInteraction(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  
  if (!map) return;
  
  mapInteractionEnabled = !mapInteractionEnabled;
  
  if (mapInteractionEnabled) {
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    map.scrollWheelZoom.enable();
    if (mapToggleBtn) mapToggleBtn.innerText = 'Disable Map';
  } else {
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    map.scrollWheelZoom.disable();
    if (mapToggleBtn) mapToggleBtn.innerText = 'Enable Map';
  }
}

async function geocode(q){
  const url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) + '&limit=1';
  try{
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    const data = await res.json();
    if (data && data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display_name: data[0].display_name };
  }catch(e){ console.error('Geocode failed', e); }
  return null;
}

async function calculateRoute(){
  clearMessages();
  const startQ = document.getElementById('start').value.trim();
  const endQ = document.getElementById('end').value.trim();
  if (!startQ || !endQ){ setShareMessage('Enter both start and destination.'); return; }

  setShareMessage('Geocoding…');
  const s = await geocode(startQ); if (!s){ setShareMessage('Start location not found.'); return; }
  const e = await geocode(endQ); if (!e){ setShareMessage('Destination not found.'); return; }

  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  startMarker = L.marker([s.lat, s.lng]).addTo(map).bindPopup(s.display_name);
  endMarker = L.marker([e.lat, e.lng]).addTo(map).bindPopup(e.display_name);

  setShareMessage('Routing…');
  try{
    const osrmUrl = `https://router.project-osrm.org/route/v1/walking/${s.lng},${s.lat};${e.lng},${e.lat}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(osrmUrl);
    const j = await r.json();
    if (!j.routes || j.routes.length === 0) { setShareMessage('No route found.'); return; }
    const route = j.routes[0];
    renderRoute(route);
    const baseScore = computeBaseScore(route);
    const crimesNear = computeCrimesNearRoute(route.geometry.coordinates, 200);
    const crimePenalty = Math.min(4, Math.ceil(crimesNear/2));
    const finalScore = Math.max(0, baseScore - crimePenalty);
    displayRouteInfo(route, finalScore, { baseScore, crimePenalty, crimesNear });
    lastRoute = { start: s, end: e, route };
    setShareMessage('Route ready.');
  }catch(err){ console.error(err); setShareMessage('Routing failed. See console.'); }
}

function renderRoute(route){
  if (routeLayer) map.removeLayer(routeLayer);
  const geo = { type: 'Feature', geometry: route.geometry };
  routeLayer = L.geoJSON(geo, { style: { color: getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#2d7ef7', weight:6 } }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding:[20,20] });
}

function computeBaseScore(route){
  let base = 8;
  const hour = new Date().getHours(); if (hour >=20 || hour <6) base -= 2;
  const distanceMiles = (route.distance || 0) / 1609.34; if (distanceMiles > 1) base -= 1;
  const durationMin = Math.round((route.duration||0)/60); if (durationMin > 20) base -= 1;
  const steps = (route.legs && route.legs[0] && route.legs[0].steps) ? route.legs[0].steps.length : (route.geometry.coordinates.length); if (steps > 30) base -=1;
  return Math.max(0, Math.min(10, base));
}

function computeCrimesNearRoute(routeCoords, thresholdMeters){
  if (!crimePoints || crimePoints.length === 0) return 0;
  let count = 0;
  for (const cp of crimePoints){
    const p = L.latLng(cp.lat, cp.lng);
    let minDist = Infinity;
    for (let i=0;i<routeCoords.length;i++){
      const [lng, lat] = routeCoords[i];
      const d = map.distance(p, L.latLng(lat, lng));
      if (d < minDist) minDist = d;
      if (minDist <= thresholdMeters) break;
    }
    if (minDist <= thresholdMeters) count++;
  }
  if (crimeHeat) crimeHeat.setOptions({ radius: Math.max(12, Math.min(40, 12 + count*2)), blur: 15 });
  return count;
}

function displayRouteInfo(route, score, breakdown){
  document.getElementById('safetyScore').textContent = `Safety Score: ${score}/10`;
  const out = document.getElementById('routeDetails');
  const distText = (route.distance ? (Math.round(route.distance/100)/10 + ' km') : '—');
  const durText = (route.duration ? Math.round(route.duration/60) + ' min' : '—');
  let html = `<div class="meta"><strong>Total:</strong> ${distText} · ${durText}</div>`;
  
  const steps = (route.legs && route.legs[0] && route.legs[0].steps) ? route.legs[0].steps : [];
  if (steps.length){
    html += '<div class="steps-header">Walking Directions</div>';
    html += '<ol class="stepList">';
    for (let i=0; i<steps.length; i++){
      const step = steps[i];
      const instruction = step.maneuver && step.maneuver.instruction ? step.maneuver.instruction : (step.name ? `Continue on ${step.name}` : 'Continue');
      const dist = step.distance ? (Math.round(step.distance*10)/10 + ' m') : '';
      const dur = step.duration ? (Math.round(step.duration/60) + ' min') : '';
      const meta = dist || dur ? ` (${[dist, dur].filter(x=>x).join(', ')})` : '';
      html += `<li><strong>${i+1}.</strong> ${instruction}${meta}</li>`;
    }
    html += '</ol>';
  }
  
  out.innerHTML = html;
  document.getElementById('scoreBreakdown').textContent = `Base: ${breakdown.baseScore}/10 · Crime penalty: -${breakdown.crimePenalty} (${breakdown.crimesNear} incidents)`;
  const el = document.getElementById('safetyScore'); el.classList.remove('good','warn','bad'); if (score>=8) el.classList.add('good'); else if (score>=5) el.classList.add('warn'); else el.classList.add('bad');
}

async function shareRoute(){
  if (!lastRoute){ setShareMessage('No route to share.'); return; }
  const s = lastRoute.start, e = lastRoute.end;
  const mapsLink = `https://www.openstreetmap.org/directions?from=${s.lat},${s.lng}&to=${e.lat},${e.lng}`;
  const message = `SafeRoute Walk\nFrom: ${s.display_name}\nTo: ${e.display_name}\n${mapsLink}`;
  if (navigator.share){ try{ await navigator.share({ title:'My SafeRoute Walk', text:message, url:mapsLink }); setShareMessage('Shared via native dialog.'); return;}catch(e){} }
  if (navigator.clipboard){ try{ await navigator.clipboard.writeText(message); setShareMessage('Route copied to clipboard.'); return;}catch(e){} }
  setShareMessage('Share link: ' + mapsLink);
}

async function loadSampleCrimeData(){
  try{ const resp = await fetch('crime_sample.geojson'); const geo = await resp.json(); processCrimeData(geo); setShareMessage('Loaded sample crime data.'); }catch(e){ setShareMessage('Failed to load sample crime data.'); }
}

async function loadCrimeDataFromUrl(url){
  try{ const resp = await fetch(url); const geo = await resp.json(); processCrimeData(geo); setShareMessage('Loaded crime data from URL.'); }catch(e){ console.error(e); setShareMessage('Failed to load crime data from URL (CORS?).'); }
}

function processCrimeData(geo){
  crimeMarkers.forEach(m=>map.removeLayer(m)); crimeMarkers=[]; crimePoints=[]; if (crimeHeat) map.removeLayer(crimeHeat);
  if (!geo || !geo.features) return;
  const pts = [];
  for (const f of geo.features){ if (!f.geometry || f.geometry.type!=='Point') continue; const [lng,lat]=f.geometry.coordinates; pts.push([lat,lng,0.5]); crimePoints.push({lat,lng,props:f.properties||{}}); const m = L.circleMarker([lat,lng], { radius:5, fillColor:'#7b1fa2', fillOpacity:1, stroke:false }).bindPopup(`${f.properties && f.properties.type ? f.properties.type : 'Crime'} ${f.properties && f.properties.date ? '· '+f.properties.date : ''}`); crimeMarkers.push(m); }
  if (document.getElementById('toggleCrime').checked){ crimeHeat = L.heatLayer(pts, { radius:20, blur:15, maxZoom:17 }).addTo(map); crimeMarkers.forEach(m=>m.addTo(map)); }
}

function toggleCrime(show){ if (crimeHeat) { if (show) crimeHeat.addTo(map); else map.removeLayer(crimeHeat); } crimeMarkers.forEach(m=>{ if (show) m.addTo(map); else map.removeLayer(m); }); }

async function loadHoustonData(datasetId, token){
  const base = `https://data.houstontx.gov/resource/${datasetId}.json`;
  const headers = token ? { 'X-App-Token': token } : {};
  try{ const resp = await fetch(base, { headers }); if (!resp.ok) throw new Error('Fetch failed: '+resp.status); const records = await resp.json(); const geo = recordsToGeoJSON(records); processCrimeData(geo); setShareMessage('Loaded Houston dataset: '+datasetId+' ('+records.length+' records)'); }catch(e){ console.error(e); setShareMessage('Failed to load Houston data.'); }
}

function recordsToGeoJSON(records){ const feats=[]; for(const r of records){ let lat=null,lng=null; if (r.location && typeof r.location==='object'){ if (r.location.coordinates && Array.isArray(r.location.coordinates)){ lng=parseFloat(r.location.coordinates[0]); lat=parseFloat(r.location.coordinates[1]); } else if (r.location.latitude && r.location.longitude){ lat=parseFloat(r.location.latitude); lng=parseFloat(r.location.longitude); } } if (!lat && (r.latitude||r.lat)) lat=parseFloat(r.latitude||r.lat); if (!lng && (r.longitude||r.lon||r.lng)) lng=parseFloat(r.longitude||r.lon||r.lng); if ((!lat||!lng) && r.point){ const m=r.point.match(/\(?\s*([\d\.-]+)\s*,\s*([\d\.-]+)\s*\)?/); if (m){ lat=parseFloat(m[1]); lng=parseFloat(m[2]); }} if (lat && lng) feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:[lng,lat]}, properties:r }); } return { type:'FeatureCollection', features:feats } }

window.addEventListener('DOMContentLoaded', initMap);
