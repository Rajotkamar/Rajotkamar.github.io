const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const HOST_FIREBASE_CONFIG = (window.AR_FIREBASE_CONFIG && typeof window.AR_FIREBASE_CONFIG === "object") ? window.AR_FIREBASE_CONFIG : {};
const DEFAULTS = {
  appName: "AR INOVATION HUB", tabTitle: "AR INOVATION HUB Energy Monitor", rate: 7,
  apiKey: HOST_FIREBASE_CONFIG.apiKey || "", authDomain: HOST_FIREBASE_CONFIG.authDomain || "",
  dbUrl: HOST_FIREBASE_CONFIG.databaseURL || "", dbPath: "/pzem/readings/latest", historyPath: "/pzem/readings/history",
  emailEnabled: true, recipient: "", subject: "AR INOVATION HUB — Overload Detected", emailEndpoint: "",
  overload: 2500, currentThreshold: 10, voltageThreshold: 255, cooldown: 60, sound: true, refresh: true,
  logoData: "assets/ar-inovation-hub.png", firebaseConfig: HOST_FIREBASE_CONFIG
};
let settings = {...DEFAULTS, ...JSON.parse(localStorage.getItem("arInovationHubSettings") || "{}")};
let firebaseDb = null, latestRef = null, historyRef = null, historyBound = false;
let charts = {}, samples = [], alerts = JSON.parse(localStorage.getItem("arInovationHubAlerts") || "[]");
let selectedAlert = alerts.length ? 0 : null, lastAlertKey = localStorage.getItem("arInovationHubLastAlertKey") || "", lastAlertAt = Number(localStorage.getItem("arInovationHubLastAlertAt") || 0);
let latest = null, connected = false, firstHistoryLoad = true;

function persist(){ localStorage.setItem("arInovationHubSettings", JSON.stringify(settings)); }
function persistAlerts(){ localStorage.setItem("arInovationHubAlerts", JSON.stringify(alerts.slice(-200))); }
function fmtMoney(v){ return `₹ ${Number(v || 0).toFixed(2)}`; }
function safeNum(v, fallback=null){ const n=Number(v); return Number.isFinite(n) ? n : fallback; }
function toast(msg, ok=true){ const el=$("#toast"); el.querySelector("i").className=ok?"fa-solid fa-check-circle":"fa-solid fa-circle-exclamation"; $("span",el).textContent=msg; el.classList.add("show"); setTimeout(()=>el.classList.remove("show"),2500); }
function csvDownload(name, rows){
  const blob=new Blob([rows.map(r=>r.map(v=>`"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

function chartOptions(yTicks=true){
  return {responsive:true, maintainAspectRatio:false, animation:{duration:400}, plugins:{legend:{display:false}},
    scales:{x:{grid:{color:"rgba(130,112,190,.07)"},ticks:{color:"#5f6984",font:{size:8},maxTicksLimit:8}},
            y:{display:yTicks,grid:{color:"rgba(130,112,190,.07)"},ticks:{color:"#5f6984",font:{size:8}}}},
    elements:{point:{radius:0,hoverRadius:3},line:{tension:.36,borderWidth:2}}
  };
}
function makeLine(id,border,fillColor){
  const canvas=$(id); if(!canvas) return null;
  const ctx=canvas.getContext("2d"), g=ctx.createLinearGradient(0,0,0,220); g.addColorStop(0,fillColor); g.addColorStop(1,"rgba(0,0,0,0)");
  return new Chart(ctx,{type:"line",data:{labels:[],datasets:[{data:[],borderColor:border,backgroundColor:g,fill:true}]},options:chartOptions()});
}
function donut(id){
  const c=$(id); if(!c) return null;
  return new Chart(c,{type:"doughnut",data:{labels:["HVAC","Lighting","Appliances","Other"],datasets:[{data:[0,0,0,0],backgroundColor:["#9c62ff","#3f91ff","#56dca9","#ffad60"],borderColor:"#0b1022",borderWidth:3}]},options:{cutout:"68%",plugins:{legend:{position:"bottom",labels:{color:"#7c86a0",font:{size:8},boxWidth:7,padding:8}}}}});
}
function initCharts(){
  charts.power=makeLine("#powerChart","#9a65ff","rgba(154,101,255,.25)");
  charts.voltSpark=makeLine("#voltageSpark","#ffae63","rgba(255,174,99,.08)");
  charts.currSpark=makeLine("#currentSpark","#5cb6ff","rgba(92,182,255,.08)");
  charts.analyticsPower=makeLine("#analyticsPower","#ae62ff","rgba(174,98,255,.25)");
  charts.analyticsVC=new Chart($("#analyticsVoltageCurrent"),{type:"line",data:{labels:[],datasets:[{label:"Voltage",data:[],borderColor:"#67aeff"},{label:"Current",data:[],borderColor:"#68ebb4"}]},options:chartOptions()});
  charts.energyDonut=donut("#energyDonut");
  charts.hourly=new Chart($("#hourlyChart"),{type:"bar",data:{labels:[],datasets:[{data:[],backgroundColor:"#7d5cff",borderRadius:4}]},options:chartOptions()});
  charts.energy=new Chart($("#energyChart"),{type:"line",data:{labels:[],datasets:[{label:"Power",data:[],borderColor:"#9a65ff",backgroundColor:"rgba(154,101,255,.22)",fill:true},{label:"Current",data:[],borderColor:"#57dca9",yAxisID:"y1"}]},options:{...chartOptions(),scales:{x:{grid:{color:"rgba(130,112,190,.07)"},ticks:{color:"#5f6984",font:{size:8}}},y:{ticks:{color:"#5f6984",font:{size:8}}},y1:{position:"right",grid:{drawOnChartArea:false},ticks:{color:"#5f6984",font:{size:8}}}}}});
  charts.reportEnergy=makeLine("#reportEnergy","#a363ff","rgba(163,99,255,.22)");
  charts.reportDonut=donut("#reportDonut");
}

function normalizeReading(raw){
  if(!raw) return null;
  const r=raw.data || raw;
  const voltage=safeNum(r.voltage ?? r.Voltage ?? r.volt);
  const current=safeNum(r.current ?? r.Current ?? r.amps);
  const power=safeNum(r.power ?? r.activePower ?? r.watts);
  if(voltage===null || current===null || power===null) return null;
  return {voltage,current,power,energy:safeNum(r.energy ?? r.totalEnergy ?? r.energyKwh,0),frequency:safeNum(r.frequency ?? r.freq,50),pf:safeNum(r.powerFactor ?? r.pf,0),timestamp:safeNum(r.timestamp ?? r.ts,Date.now())};
}
function setConnection(ok, message){
  connected=ok; $("#connectionStatus").textContent=message; $("#sidebarStatus").textContent=message; $("#connectionTitle").textContent=ok?"Connected":"Not connected";
  const pill=$("#statusPill"); pill.classList.toggle("offline",!ok); pill.classList.toggle("online",ok); $("#dataMode").textContent=ok?"Firebase":"Not configured";
  if(!ok){ $("#wifiVal").textContent="Offline"; $("#wifiVal").style.color="#ff7183"; }
  else { $("#wifiVal").textContent="Connected"; $("#wifiVal").style.color=""; }
}

function connectFirebase(onReady){
  if(typeof firebase === "undefined"){ setConnection(false,"Firebase SDK unavailable"); return; }

  const config = {
    ...HOST_FIREBASE_CONFIG,
    apiKey: settings.apiKey || HOST_FIREBASE_CONFIG.apiKey || "",
    authDomain: settings.authDomain || HOST_FIREBASE_CONFIG.authDomain || "",
    databaseURL: settings.dbUrl || HOST_FIREBASE_CONFIG.databaseURL || ""
  };
  if(!config.apiKey || !config.databaseURL){
    setConnection(false,"Firebase not configured");
    return;
  }

  try{
    const name="ar-inovation-hub";
    let app;
    try { app=firebase.app(name); }
    catch(e) { app=firebase.initializeApp(config,name); }

    const finishDb=()=>{
      firebaseDb=app.database();
      latestRef=firebaseDb.ref(settings.dbPath || DEFAULTS.dbPath);
      historyRef=firebaseDb.ref(settings.historyPath || DEFAULTS.historyPath).limitToLast(240);

      firebaseDb.ref(".info/connected").on("value",snap=>{
        setConnection(snap.val()===true, snap.val()===true?"System Online":"Firebase Offline");
      });

      latestRef.on("value",snap=>{
        const reading=normalizeReading(snap.val());
        if(reading){
          latest=reading;
          updateUI();
          evaluateAlert(reading);
        } else if(snap.exists()){
          console.error("Invalid Firebase reading:", snap.val());
          toast("Firebase data format is invalid",false);
        }
      },err=>{
        console.error(err);
        setConnection(false,"Firebase read error");
        toast("Could not read Firebase",false);
      });

      historyRef.on("value",snap=>{
        const out=[];
        snap.forEach(ch=>{
          const r=normalizeReading(ch.val());
          if(r) out.push(r);
        });
        samples=out.sort((a,b)=>a.timestamp-b.timestamp);
        firstHistoryLoad=false;
        refreshCharts();
        updateUI();
        renderReports();
      },err=>{
        console.error(err);
        toast("Could not load Firebase history",false);
      });

      historyBound=true;
      if(typeof onReady==="function") Promise.resolve(onReady()).catch(err=>console.error("Firebase ready callback failed:",err));
    };

    // The database is usable only after anonymous auth succeeds when auth is enabled.
    if(firebase.auth && typeof firebase.auth().signInAnonymously === "function"){
      firebase.auth().signInAnonymously()
        .then(finishDb)
        .catch(err=>{
          console.error(err);
          setConnection(false,"Firebase Auth failed");
          toast("Enable Anonymous Authentication in Firebase",false);
        });
    } else {
      finishDb();
    }
  }catch(err){
    console.error(err);
    firebaseDb=null;
    setConnection(false,"Firebase configuration error");
    toast("Firebase configuration failed",false);
  }
}

async function disconnectFirebase(){
  try{
    if(firebaseDb && historyBound){
      firebaseDb.ref(settings.historyPath || DEFAULTS.historyPath).off();
      firebaseDb.ref(settings.dbPath || DEFAULTS.dbPath).off();
      firebaseDb.ref(".info/connected").off();
    }
  }catch(e){
    console.warn("Firebase listener cleanup failed:",e);
  }

  firebaseDb=null;
  historyRef=null;
  latestRef=null;
  historyBound=false;

  // Delete the named app so changing Firebase settings in the UI immediately takes effect.
  try{
    const app=firebase?.app("ar-inovation-hub");
    if(app) await app.delete();
  }catch(e){
    // No existing named app is a valid state.
  }

  setConnection(false,"Firebase not configured");
}

function currentTotals(){
  const energy = latest?.energy ?? (samples.length ? safeNum(samples.at(-1).energy,0) : 0);
  const avgP=samples.length?samples.reduce((a,b)=>a+b.power,0)/samples.length:(latest?.power??0);
  const avgV=samples.length?samples.reduce((a,b)=>a+b.voltage,0)/samples.length:(latest?.voltage??0);
  const avgC=samples.length?samples.reduce((a,b)=>a+b.current,0)/samples.length:(latest?.current??0);
  const pf=latest?.pf ?? 0; const peak=samples.length?Math.max(...samples.map(x=>x.power)):(latest?.power??0); const low=samples.length?Math.min(...samples.map(x=>x.power)):(latest?.power??0);
  return {energy,avgP,avgV,avgC,pf,peak,low};
}
function showValue(elId,val,unit="",digits=1){ const el=$(elId); if(!el)return; el.textContent=val===null||val===undefined?`—`:digits===0?`${Math.round(val)}${unit}`:`${Number(val).toFixed(digits)}${unit}`; }
function updateUI(){
  const r=latest; if(!r){ ["powerVal","voltVal","currVal","energyVal","pfVal","energyVoltage","energyCurrent","energyPower","energyFrequency","energyPF","energyTotal","avgPower","avgVolt","avgCurr","avgPf","analyticsEnergy","peakPower","summaryPeak","summaryLow","summaryPf"].forEach(id=>{const e=$("#"+id);if(e)e.textContent="—";}); $("#billVal").textContent="₹ —"; return; }
  $("#powerVal").textContent=r.power.toFixed(1); $("#voltVal").textContent=r.voltage.toFixed(1); $("#currVal").textContent=r.current.toFixed(2); $("#energyVal").textContent=`${r.energy.toFixed(2)} kWh`; $("#billVal").textContent=fmtMoney(r.energy*settings.rate); $("#pfVal").textContent=r.pf.toFixed(2);
  $("#rateLabel").textContent=`(@ ₹${settings.rate.toFixed(2)}/u)`; $("#powerCapacity").textContent=`Capacity ${settings.overload.toFixed(0)} W`; $("#powerBar").style.width=Math.min(100,(r.power/settings.overload)*100)+"%";
  ["energyVoltage","energyCurrent","energyPower","energyFrequency","energyPF","energyTotal"].forEach(()=>{});
  $("#energyVoltage").textContent=`${r.voltage.toFixed(1)} V`; $("#energyCurrent").textContent=`${r.current.toFixed(2)} A`; $("#energyPower").textContent=`${r.power.toFixed(1)} W`; $("#energyFrequency").textContent=`${r.frequency.toFixed(1)} Hz`; $("#energyPF").textContent=r.pf.toFixed(2); $("#energyTotal").textContent=`${r.energy.toFixed(2)} kWh`;
  const t=currentTotals(); $("#avgPower").textContent=`${t.avgP.toFixed(1)} W`; $("#avgVolt").textContent=`${t.avgV.toFixed(1)} V`; $("#avgCurr").textContent=`${t.avgC.toFixed(2)} A`; $("#avgPf").textContent=t.pf.toFixed(2); $("#analyticsEnergy").textContent=`${t.energy.toFixed(2)} kWh`; $("#peakPower").textContent=`${t.peak.toFixed(1)} W`; $("#summaryPeak").textContent=`${t.peak.toFixed(1)} W`; $("#summaryLow").textContent=`${t.low.toFixed(1)} W`; $("#summaryPf").textContent=t.pf.toFixed(2);
  $("#thresholdPower").style.width=Math.min(100,r.power/settings.overload*100)+"%"; $("#thresholdPowerText").textContent=Math.round(r.power/settings.overload*100)+"%";
  $("#thresholdCurrent").style.width=Math.min(100,r.current/settings.currentThreshold*100)+"%"; $("#thresholdCurrentText").textContent=Math.round(r.current/settings.currentThreshold*100)+"%";
  $("#thresholdVoltage").style.width=Math.min(100,r.voltage/settings.voltageThreshold*100)+"%"; $("#thresholdVoltageText").textContent=Math.round(r.voltage/settings.voltageThreshold*100)+"%";
  const start=samples[0]?.timestamp||Date.now(), elapsed=Math.max(0,Date.now()-start), h=Math.floor(elapsed/3600000),m=Math.floor(elapsed/60000)%60,s=Math.floor(elapsed/1000)%60; $("#uptimeVal").textContent=`${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  $("#hourEnergy").textContent=samples.length?`${Math.max(0,samples[samples.length-1].energy-(samples.find(x=>x.timestamp>Date.now()-3600000)?.energy||samples[0].energy)).toFixed(2)} kWh`:"—";
  const durationHours=samples.length>1?Math.max(.017,(samples.at(-1).timestamp-samples[0].timestamp)/3600000):0; const projected=durationHours>0?(t.energy/durationHours)*24:0; $("#dailyProjection").textContent=projected?`${projected.toFixed(2)} kWh`:"—"; $("#dailyBill").textContent=projected?fmtMoney(projected*settings.rate):"₹ —";
  $("#donutTotal").textContent=t.energy.toFixed(2); updateStatusTrend(); refreshReportNumbers();
}
function updateStatusTrend(){
  if(samples.length<2)return; const a=samples.at(-2),b=samples.at(-1); [ ["#voltTrend",b.voltage,a.voltage], ["#currTrend",b.current,a.current] ].forEach(([id,n,o])=>{const el=$(id); if(!el)return;const pct=o?((n-o)/o*100):0;el.textContent=`${pct>=0?"+":""}${pct.toFixed(1)}%`;el.classList.toggle("positive",pct>=0);});
}
function refreshCharts(){
  const v=samples.slice(-60), labels=v.map(x=>new Date(x.timestamp).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
  const lines=[[charts.power,x=>x.power],[charts.voltSpark,x=>x.voltage],[charts.currSpark,x=>x.current],[charts.analyticsPower,x=>x.power]];
  lines.forEach(([c,f])=>{if(c){c.data.labels=labels;c.data.datasets[0].data=v.map(f);c.update("none");}});
  if(charts.analyticsVC){charts.analyticsVC.data.labels=labels;charts.analyticsVC.data.datasets[0].data=v.map(x=>x.voltage);charts.analyticsVC.data.datasets[1].data=v.map(x=>x.current);charts.analyticsVC.update("none");}
  if(charts.energy){charts.energy.data.labels=labels;charts.energy.data.datasets[0].data=v.map(x=>x.power);charts.energy.data.datasets[1].data=v.map(x=>x.current);charts.energy.update("none");}
  if(charts.hourly){const buckets={};v.forEach(x=>{const k=new Date(x.timestamp).getHours();(buckets[k]??=[]).push(x.energy||0)});const ks=Object.keys(buckets).sort((a,b)=>a-b);charts.hourly.data.labels=ks.map(k=>`${String(k).padStart(2,"0")}:00`);charts.hourly.data.datasets[0].data=ks.map(k=>Math.max(0,buckets[k].at(-1)-buckets[k][0]));charts.hourly.update("none");}
  updateDonuts();
}
function updateDonuts(){
  const e=latest?.energy||0, values=[e*.43,e*.25,e*.17,e*.15].map(x=>Number(x.toFixed(3)));
  if(charts.energyDonut){charts.energyDonut.data.datasets[0].data=values;charts.energyDonut.update("none");}
  if(charts.reportDonut){charts.reportDonut.data.datasets[0].data=values;charts.reportDonut.update("none");}
}

function buildAlert(type,title,desc,measured,threshold,key){ return {id:Date.now(),type,title,desc,measured,threshold,status:"Unresolved",timestamp:Date.now(),time:"just now",key}; }
function evaluateAlert(r){
  const conditions=[]; if(r.power>settings.overload)conditions.push(["critical","Overload Detected","Power usage exceeded configured safe limit.",`${r.power.toFixed(0)} W`,`${settings.overload} W`,"overload"]);
  if(r.voltage>settings.voltageThreshold)conditions.push(["warning","High Voltage Detected","Voltage is above the configured safety limit.",`${r.voltage.toFixed(1)} V`,`${settings.voltageThreshold} V`,"voltage"]);
  if(r.current>settings.currentThreshold)conditions.push(["warning","High Current Detected","Current is above the configured safety limit.",`${r.current.toFixed(2)} A`,`${settings.currentThreshold} A`,"current"]);
  const activeKeys=new Set(conditions.map(x=>x[5]));
  for(const c of conditions){ const [,title,desc,measured,threshold,key]=c; const now=Date.now(); const last=alerts.find(a=>a.key===key&&a.status!=="Resolved"); if(!last && (now-lastAlertAt)/1000>=settings.cooldown){const a=buildAlert(...c);alerts.unshift(a);selectedAlert=0;lastAlertKey=key;lastAlertAt=now;localStorage.setItem("arInovationHubLastAlertAt",String(now));localStorage.setItem("arInovationHubLastAlertKey",key);persistAlerts();renderAlerts();if(key==="overload")showCriticalModal(a);if(settings.emailEnabled&&key==="overload")notifyBackend(a);}}
  for(const a of alerts.filter(x=>x.status!=="Resolved")){if(a.key&&["overload","voltage","current"].includes(a.key)&&!activeKeys.has(a.key)){a.status="Resolved";a.type="resolved";a.time="just now";}}
  persistAlerts();renderAlerts();
}
async function notifyBackend(alert){ if(!settings.emailEndpoint||!settings.recipient)return; try{await fetch(settings.emailEndpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({system:settings.appName,recipient:settings.recipient,subject:settings.subject,alert,reading:latest})});}catch(e){console.error(e);toast("Email endpoint unavailable",false);} }

function showCriticalModal(a){ $("#criticalMeasured").textContent=a.measured; $("#criticalThreshold").textContent=a.threshold; $("#criticalModal").classList.add("show"); if(settings.sound){try{const A=window.AudioContext||window.webkitAudioContext,ctx=new A(),o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=760;g.gain.value=.035;o.connect(g);g.connect(ctx.destination);o.start();setTimeout(()=>{o.stop();ctx.close()},280)}catch(e){}} }
$("#closeCritical").onclick=()=>$("#criticalModal").classList.remove("show"); $("#dismissCritical").onclick=()=>$("#criticalModal").classList.remove("show"); $("#openAlerts").onclick=()=>{$("#criticalModal").classList.remove("show");navigate("alerts")};

function renderAlerts(){
  const counts={critical:0,warning:0,info:0,resolved:0};alerts.forEach(a=>counts[a.type]++);
  $("#criticalCount").textContent=counts.critical;$("#warningCount").textContent=counts.warning;$("#infoCount").textContent=counts.info;$("#resolvedCount").textContent=counts.resolved;$("#alertBadge").textContent=String(counts.critical+counts.warning);
  $("#alertList").innerHTML=alerts.length?alerts.map((a,i)=>`<div class="alert-row ${a.type}${selectedAlert===i?" selected":""}" data-alert="${i}"><div class="alert-icon"><i class="fa-solid ${a.type==="critical"?"fa-bolt":a.type==="warning"?"fa-triangle-exclamation":a.type==="info"?"fa-circle-info":"fa-circle-check"}"></i></div><div><strong>${a.title}</strong><small>${a.desc}</small></div><div><span class="alert-time">${a.time||new Date(a.timestamp).toLocaleTimeString()}</span></div></div>`).join(""):"<div class='empty-detail'>No alerts recorded yet. Alerts will appear here when Firebase readings cross your configured thresholds.</div>";
  $$(".alert-row").forEach(r=>r.onclick=()=>{selectedAlert=Number(r.dataset.alert);renderAlerts();showAlertDetails(alerts[selectedAlert]);});
  if(selectedAlert!==null && alerts[selectedAlert])showAlertDetails(alerts[selectedAlert]); else $("#alertDetails").innerHTML=`<div class="empty-detail">No alert selected.</div>`;
}
function showAlertDetails(a){if(!a)return;$("#detailState").className=`severity ${a.type}`;$("#detailState").textContent=a.type.toUpperCase();$("#alertDetails").innerHTML=`<div class="alert-detail-body"><div class="detail-hero"><strong>${a.title}</strong><small>${a.desc}</small></div><div class="detail-grid"><div><small>Time</small><b>${new Date(a.timestamp||Date.now()).toLocaleString()}</b></div><div><small>Status</small><b>${a.status}</b></div><div><small>Measured</small><b>${a.measured}</b></div><div><small>Threshold</small><b>${a.threshold}</b></div><div><small>Type</small><b>${a.type}</b></div><div><small>Source</small><b>ESP32 / PZEM</b></div></div><div style="display:flex;gap:8px;margin-top:14px"><button class="ghost-btn" onclick="resolveSelected()">Mark Resolved</button><button class="primary-btn" onclick="ackSelected()">Acknowledge</button></div></div>`;}
function resolveSelected(){if(selectedAlert!==null&&alerts[selectedAlert]){alerts[selectedAlert].type="resolved";alerts[selectedAlert].status="Resolved";persistAlerts();renderAlerts();toast("Alert marked resolved")}}
function ackSelected(){if(selectedAlert!==null&&alerts[selectedAlert]){alerts[selectedAlert].status="Acknowledged";persistAlerts();showAlertDetails(alerts[selectedAlert]);toast("Alert acknowledged")}}
window.resolveSelected=resolveSelected;window.ackSelected=ackSelected;

function navigate(page){$$('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${page}`));$$('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===page));if(page==="reports")renderReports();window.scrollTo({top:0,behavior:"smooth"});}
$$('.nav-item').forEach(n=>n.addEventListener('click',()=>navigate(n.dataset.page))); $("#settingsBtn").onclick=()=>navigate("settings"); $("#dashboardExport").onclick=()=>exportReadings();$("#exportBtn").onclick=()=>exportReadings();$("#energyExport").onclick=()=>exportReadings();$("#alertExport").onclick=()=>exportAlerts();$("#reportExport").onclick=()=>exportReports();
function exportReadings(){csvDownload("ar-inovation-hub-readings.csv",[["Timestamp","Voltage (V)","Current (A)","Power (W)","Energy (kWh)","Frequency (Hz)","Power Factor"],...samples.map(s=>[new Date(s.timestamp).toISOString(),s.voltage,s.current,s.power,s.energy,s.frequency,s.pf])]);}
function exportAlerts(){csvDownload("ar-inovation-hub-alerts.csv",[["Timestamp","Type","Title","Measured","Threshold","Status"],...alerts.map(a=>[new Date(a.timestamp).toISOString(),a.type,a.title,a.measured,a.threshold,a.status])]);}
function exportReports(){const t=currentTotals();csvDownload("ar-inovation-hub-report.csv",[["Metric","Value"],["Average Power",`${t.avgP.toFixed(1)} W`],["Peak Power",`${t.peak.toFixed(1)} W`],["Lowest Power",`${t.low.toFixed(1)} W`],["Energy",`${t.energy.toFixed(2)} kWh`],["Estimated Bill",fmtMoney(t.energy*settings.rate)],["Power Factor",t.pf.toFixed(2)]]);}

function refreshReportNumbers(){
  const t=currentTotals();
  const ids=["reportKpiEnergy","reportKpiBill","reportKpiAvg","reportKpiPeak","reportKpiPf"];
  const vals=[`${t.energy.toFixed(2)} kWh`,fmtMoney(t.energy*settings.rate),`${t.avgP.toFixed(1)} W`,`${(t.peak/1000).toFixed(2)} kW`,t.pf.toFixed(2)];
  ids.forEach((id,i)=>{const e=$("#"+id);if(e)e.textContent=vals[i]||"—";});
  const rd=$("#reportDonutTotal"); if(rd)rd.textContent=t.energy.toFixed(2);
}

function renderReports(){
  const t=currentTotals(); $("#donutTotal").textContent=t.energy.toFixed(2);
  $("#reportEnergy").dataset.ready="1";
  const days={}; samples.forEach(s=>{const k=new Date(s.timestamp).toISOString().slice(0,10);(days[k]??=[]).push(s)}); const keys=Object.keys(days).sort().slice(-7);
  const labels=keys.map(k=>k.slice(5)); const daily=keys.map(k=>Math.max(0,(days[k].at(-1).energy||0)-(days[k][0].energy||0))); if(charts.reportEnergy){charts.reportEnergy.data.labels=labels;charts.reportEnergy.data.datasets[0].data=daily;charts.reportEnergy.update("none");}
  const rows=keys.map(k=>{const a=days[k],avg=a.reduce((x,y)=>x+y.power,0)/a.length,peak=Math.max(...a.map(x=>x.power)),energy=Math.max(0,(a.at(-1).energy||0)-(a[0].energy||0));return [k,`${energy.toFixed(2)} kWh`,`${avg.toFixed(1)} W`,`${peak.toFixed(0)} W`,fmtMoney(energy*settings.rate)]});
  $("#reportTable").innerHTML=rows.length?rows.map(r=>`<tr>${r.map((c,i)=>`<td${i===4?' style="color:#8be9bc"':''}>${c}</td>`).join("")}</tr>`).join(""):"<tr><td colspan='5' style='text-align:center'>No Firebase history available.</td></tr>";
  const vals=[`${t.energy.toFixed(2)} kWh`,fmtMoney(t.energy*settings.rate),`${t.avgP.toFixed(1)} W`,`${(t.peak/1000).toFixed(2)} kW`,t.pf.toFixed(2)];
  const ids=["reportKpiEnergy","reportKpiBill","reportKpiAvg","reportKpiPeak","reportKpiPf"]; ids.forEach((id,i)=>{const e=$("#"+id);if(e)e.textContent=vals[i]||"—";});
  const rd=$("#reportDonutTotal"); if(rd)rd.textContent=t.energy.toFixed(2);
}


function applyLogo(){
  const data=settings.logoData||"";
  const targets=[['#brandLogo','#brandLogoFallback'],['#mobileBrandLogo','#mobileBrandLogoFallback'],['#logoPreview','#logoPreviewFallback']];
  targets.forEach(([imgSel,fallbackSel])=>{
    const img=$(imgSel), fallback=$(fallbackSel); if(!img||!fallback)return;
    if(data){ img.src=data; img.hidden=false; fallback.hidden=true; }
    else { img.hidden=true; fallback.hidden=false; }
  });
}
function resizeLogo(file){
  return new Promise((resolve,reject)=>{
    if(!file) return resolve("");
    const reader=new FileReader();
    reader.onload=()=>{
      const img=new Image();
      img.onload=()=>{
        const size=256, canvas=document.createElement('canvas'); canvas.width=size; canvas.height=size;
        const ctx=canvas.getContext('2d'); ctx.clearRect(0,0,size,size);
        const scale=Math.min(size/img.width,size/img.height); const w=img.width*scale,h=img.height*scale;
        ctx.drawImage(img,(size-w)/2,(size-h)/2,w,h); resolve(canvas.toDataURL('image/png',.92));
      };
      img.onerror=()=>reject(new Error('Invalid image')); img.src=reader.result;
    };
    reader.onerror=()=>reject(reader.error||new Error('Could not read image')); reader.readAsDataURL(file);
  });
}
function initLogoControls(){
  const input=$("#settingLogo"), remove=$("#removeLogo"); if(!input||!remove)return;
  input.addEventListener('change',async()=>{
    const file=input.files?.[0]; if(!file)return;
    try{ settings.logoData=await resizeLogo(file); persist(); applyLogo(); toast('Logo updated'); }
    catch(e){console.error(e);toast('Could not read that logo file',false);}
  });
  remove.addEventListener('click',()=>{settings.logoData='';input.value='';persist();applyLogo();toast('Logo removed')});
}

function loadSettings(){
  applyLogo();
  $("#settingAppName").value=settings.appName;$("#settingTabTitle").value=settings.tabTitle;$("#settingRate").value=settings.rate;$("#settingApiKey").value=settings.apiKey || HOST_FIREBASE_CONFIG.apiKey || "";$("#settingAuthDomain").value=settings.authDomain || HOST_FIREBASE_CONFIG.authDomain || "";$("#settingDbUrl").value=settings.dbUrl || HOST_FIREBASE_CONFIG.databaseURL || "";$("#settingDbPath").value=settings.dbPath;$("#settingHistoryPath").value=settings.historyPath;
  $("#settingEmailEnabled").checked=settings.emailEnabled;$("#settingRecipient").value=settings.recipient;$("#settingSubject").value=settings.subject;$("#settingEmailEndpoint").value=settings.emailEndpoint;$("#settingOverload").value=settings.overload;$("#settingCurrentThreshold").value=settings.currentThreshold;$("#settingVoltageThreshold").value=settings.voltageThreshold;$("#settingCooldown").value=settings.cooldown;$("#settingSound").checked=settings.sound;$("#settingRefresh").checked=settings.refresh;
}
async function syncAlertConfig(){
  if(!firebaseDb) return;
  try{
    await firebaseDb.ref("/settings/alerts").update({emailEnabled:settings.emailEnabled,recipient:settings.recipient,subject:settings.subject,overload:settings.overload,currentThreshold:settings.currentThreshold,voltageThreshold:settings.voltageThreshold,cooldown:settings.cooldown});
  }catch(e){ console.error(e); toast("Saved locally, but Firebase alert settings were not written",false); }
}
function readSettings(){
  settings.appName=$("#settingAppName").value.trim()||DEFAULTS.appName;settings.tabTitle=$("#settingTabTitle").value.trim()||DEFAULTS.tabTitle;settings.rate=safeNum($("#settingRate").value,7);settings.apiKey=$("#settingApiKey").value.trim();settings.authDomain=$("#settingAuthDomain").value.trim();settings.dbUrl=$("#settingDbUrl").value.trim();settings.dbPath=$("#settingDbPath").value.trim()||DEFAULTS.dbPath;settings.historyPath=$("#settingHistoryPath").value.trim()||DEFAULTS.historyPath;
  settings.emailEnabled=$("#settingEmailEnabled").checked;settings.recipient=$("#settingRecipient").value.trim();settings.subject=$("#settingSubject").value.trim()||DEFAULTS.subject;settings.emailEndpoint=$("#settingEmailEndpoint").value.trim();settings.overload=safeNum($("#settingOverload").value,2500);settings.currentThreshold=safeNum($("#settingCurrentThreshold").value,10);settings.voltageThreshold=safeNum($("#settingVoltageThreshold").value,255);settings.cooldown=safeNum($("#settingCooldown").value,60);settings.sound=$("#settingSound").checked;settings.refresh=$("#settingRefresh").checked;
  persist();document.title=settings.tabTitle;$("#brandName").textContent=settings.appName;$("#mobileBrandName").textContent=settings.appName;
}
$("#settingsForm").addEventListener("submit",async e=>{e.preventDefault();readSettings();await disconnectFirebase();connectFirebase(syncAlertConfig);toast("Configuration saved")}); $("#saveSettingsTop").onclick=()=>$("#settingsForm").requestSubmit();
$("#resetSettings").onclick=async()=>{settings={...DEFAULTS};persist();loadSettings();document.title=settings.tabTitle;$("#brandName").textContent=settings.appName;$("#mobileBrandName").textContent=settings.appName;await disconnectFirebase();connectFirebase(syncAlertConfig);toast("Settings reset")};
$("#mobileMenu").onclick=()=>document.querySelector(".sidebar")?.classList.toggle("mobile-open");

function initialize(){
  loadSettings(); initLogoControls(); applyLogo(); document.title=settings.tabTitle; $("#brandName").textContent=settings.appName;$("#mobileBrandName").textContent=settings.appName;
  initCharts(); renderAlerts(); renderReports(); updateUI(); setConnection(false,"Firebase not configured");
  connectFirebase();
  setInterval(()=>{ const now=new Date(); $("#clock").textContent=now.toLocaleTimeString(); if(latest)updateUI(); },1000);
}
document.addEventListener("DOMContentLoaded",initialize);
