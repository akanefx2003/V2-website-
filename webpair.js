// webpair.js — AKANE MD v1 + v2 Pairing Server (un process node isolé par numéro connecté)
import express from 'express'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { REPO_CONFIG, repoReady, prepareRepos } from './repoManager.js'

const app = express()
app.use(express.json())

const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb865EJ0QeapgV7MkP2D'
const GITHUB_V1    = 'https://github.com/akanefx2003/AKANE_MD'
const GITHUB_V2    = 'https://github.com/akanefx2003/AKANE-MD-V2.git'
const STORE_LINK   = 'https://v2-five-lyart.vercel.app'
const YOUTUBE_LINK = 'https://youtube.com/@akanefx-j3k9o?si=umMPewjZUzcOhilE'

const pendingCodes  = new Map() // "version:number" -> { status, code, error }
const activeBots    = new Map() // "version:number" -> { child, version, connected }
const SESSIONS_FILE = './sessions/pair_sessions.json'
const INSTANCES_DIR = './instances' // config + session par numéro (léger, pas de copie de code)

// Un même numéro peut avoir un process v1 ET un process v2 en parallèle : la clé DOIT inclure la version,
// sinon spawnBot() pense que c'est "le même bot" et tue le process de l'autre version silencieusement.
function botKey(number, version) { return `${version}:${number}` }

// ── V1 : serveur interne dédié (pair.js tourne tel quel, un seul process partagé
// pour tous les numéros v1 — pas un process par numéro, pour éviter la race condition
// sur configmanager.js/config.json que provoquerait un process séparé par numéro) ──
const V1_INTERNAL_PORT = 3001
const V1_BASE_URL = `http://127.0.0.1:${V1_INTERNAL_PORT}`
let v1Process = null
let v1Ready   = false

function startV1Server() {
    if (v1Process) return
    const repoDir = REPO_CONFIG.v1?.dir
    if (!repoDir || !repoReady.v1) return

    console.log('🚀 Démarrage du serveur interne v1 (pair.js)...')
    v1Process = spawn('node', ['pair.js'], {
        cwd: repoDir,
        env: { ...process.env, PORT: String(V1_INTERNAL_PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    })

    v1Process.stdout.on('data', d => {
        const text = d.toString()
        process.stdout.write(`[v1-server] ${text}`)
        if (/AKANE MD Web Pair/i.test(text)) v1Ready = true
    })
    v1Process.stderr.on('data', d => process.stderr.write(`[v1-server:err] ${d}`))

    v1Process.on('exit', code => {
        console.log(`⚠️ Serveur interne v1 arrêté (code ${code}) — redémarrage dans 5s`)
        v1Process = null
        v1Ready = false
        setTimeout(startV1Server, 5000)
    })
}

// Attend que le repo v1 soit prêt (cloné/installé) avant de démarrer le serveur interne
function watchV1Ready() {
    if (repoReady.v1) { startV1Server(); return }
    setTimeout(watchV1Ready, 2000)
}

function saveSession(number, version) {
    try {
        if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions', { recursive: true })
        let list = fs.existsSync(SESSIONS_FILE) ? JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')) : []
        list = list.map(entry => typeof entry === 'string' ? { number: entry, version: 'v2' } : entry)
        const existing = list.find(entry => entry.number === number)
        if (existing) existing.version = version || existing.version || 'v2'
        else list.push({ number, version: version || 'v2' })
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2))
    } catch (e) {}
}

function removeSession(number) {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return
        let list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
        list = list.map(entry => typeof entry === 'string' ? { number: entry, version: 'v2' } : entry)
        list = list.filter(entry => entry.number !== number)
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2))
    } catch (e) {}
}

function getConnectedCount() {
    let count = 0
    for (const bot of activeBots.values()) if (bot.connected) count++
    return count
}

function instanceDirFor(version, number) { return path.join(INSTANCES_DIR, version, number) }

// Lance le process du bot pour CE numéro, isolé de tous les autres (config + session séparées, code + node_modules partagés)
function spawnBot(number, version, isRestore) {
    const key = botKey(number, version)
    const existing = activeBots.get(key)
    if (existing) {
        if (existing.connected && !isRestore) return existing
        try { existing.child.kill('SIGTERM') } catch (e) {}
        activeBots.delete(key)
    }

    const repoDir = REPO_CONFIG[version]?.dir
    if (!repoDir || !repoReady[version]) throw new Error(`Le bot ${version} est encore en préparation sur le serveur, réessaie dans quelques instants`)

    const instDir = instanceDirFor(version, number)
    fs.mkdirSync(path.join(instDir, 'database'), { recursive: true })
    fs.mkdirSync(path.join(instDir, 'sessions'), { recursive: true })

    // Une demande manuelle depuis le site (isRestore=false) doit TOUJOURS repartir d'une session
    // WhatsApp vierge : sinon, si d'anciens identifiants encore valides traînent (test précédent,
    // reconnexion jamais nettoyée...), le bot se reconnecte silencieusement avec eux, sans jamais
    // générer de nouveau code — l'utilisateur voit "connecté" sans avoir rien entré sur son tel.
    // Une restauration serveur (isRestore=true) doit au contraire garder la session existante.
    if (!isRestore) {
        try { fs.rmSync(path.join(instDir, 'sessions'), { recursive: true, force: true }) } catch (e) {}
        fs.mkdirSync(path.join(instDir, 'sessions'), { recursive: true })
    }

    const child = spawn('node', ['index.js'], {
        cwd: repoDir,
        env: { ...process.env, INSTANCE_DIR: path.resolve(instDir), OWNER_NUMBER: number },
        stdio: ['ignore', 'pipe', 'pipe']
    })

    const entry = { child, version, connected: false }
    activeBots.set(key, entry)
    if (!isRestore) pendingCodes.set(key, { status: 'pending', code: null, error: null })

    child.stdout.on('data', d => {
        const text = d.toString()
        process.stdout.write(`[bot:${number}:${version}] ${text}`)

        const codeMatch = text.match(/[🔐🔑]\s*CODE\s*:\s*([A-Za-z0-9-]+)/)
        if (codeMatch && !entry.connected) {
            pendingCodes.set(key, { status: 'ready', code: codeMatch[1], error: null })
        }
        if (/✅[^\n]*connect/i.test(text)) {
            entry.connected = true
            pendingCodes.set(key, { status: 'connected', code: null, error: null })
            saveSession(number, version)
        }
    })
    child.stderr.on('data', d => process.stderr.write(`[bot:${number}:${version}:err] ${d}`))

    child.on('exit', code => {
        console.log(`⚠️ Bot +${number} (${version}) arrêté (code ${code})`)
        if (activeBots.get(key) === entry) activeBots.delete(key)
        if (!entry.connected) {
            pendingCodes.set(key, { status: 'error', code: null, error: `Le bot s'est arrêté au démarrage (code ${code}). Regarde les logs serveur.` })
        } else {
            // Il était connecté puis s'est arrêté (déconnexion/logout côté WhatsApp) :
            // on retire sa session pour ne plus jamais tenter de le relancer automatiquement au redémarrage
            removeSession(number)
            pendingCodes.set(key, { status: 'error', code: null, error: `Le bot a été déconnecté (logout WhatsApp). Reconnecte-toi depuis le site si besoin.` })
        }
    })

    return entry
}

async function restoreSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return
    let list = []
    try { list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8')) } catch (e) { return }
    list = list.map(entry => typeof entry === 'string' ? { number: entry, version: 'v2' } : entry)
    for (const { number, version } of list) {
        const v = version || 'v2'
        if (v === 'v1') continue // pair.js restaure ses propres sessions v1 en interne, tout seul
        const instDir = instanceDirFor(v, number)
        if (!fs.existsSync(path.join(instDir, 'sessions'))) { removeSession(number); continue }
        try { spawnBot(number, v, true) } catch (e) { console.error(`Erreur restauration +${number}:`, e.message) }
        await new Promise(r => setTimeout(r, 1500))
    }
}

app.post('/pair', async function(req, res) {
    const number = req.body.number
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    if (!number || number.replace(/[^0-9]/g, '').length < 7) return res.json({ error: 'Numero invalide' })
    const clean = number.replace(/[^0-9]/g, '')

    if (version === 'v1') {
        if (!v1Ready) return res.json({ error: 'Le bot v1 est encore en préparation sur le serveur, réessaie dans quelques instants' })
        try {
            const r = await fetch(`${V1_BASE_URL}/pair`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: clean })
            })
            return res.json(await r.json())
        } catch (e) {
            return res.json({ error: 'Serveur v1 injoignable : ' + e.message })
        }
    }

    try {
        spawnBot(clean, version, false)
        res.json({ ok: true, number: clean })
    } catch (e) {
        pendingCodes.set(botKey(clean, version), { status: 'error', code: null, error: e.message })
        res.json({ error: e.message })
    }
})

app.post('/disconnect', async function(req, res) {
    const number = (req.body.number || '').replace(/[^0-9]/g, '')
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    if (!number) return res.json({ error: 'Numero invalide' })

    if (version === 'v1') {
        return res.json({ error: 'Déconnexion v1 non disponible pour le moment — redéploie le bot pour libérer ce numéro.' })
    }

    const key = botKey(number, version)
    const entry = activeBots.get(key)
    if (!entry) return res.json({ ok: true, note: 'Aucun process actif pour ce numéro/version côté serveur' })
    try { entry.child.kill('SIGKILL') } catch (e) {}
    activeBots.delete(key)
    removeSession(number)
    pendingCodes.set(key, { status: 'error', code: null, error: 'Déconnecté manuellement' })
    res.json({ ok: true })
})

app.get('/code/:number', async function(req, res) {
    const clean = req.params.number.replace(/[^0-9]/g, '')
    const version = req.query.version === 'v1' ? 'v1' : 'v2'

    if (version === 'v1') {
        try {
            const r = await fetch(`${V1_BASE_URL}/code/${clean}`)
            return res.json(await r.json())
        } catch (e) {
            return res.json({ status: 'error', error: 'Serveur v1 injoignable' })
        }
    }

    const entry = pendingCodes.get(botKey(clean, version))
    if (!entry) return res.json({ status: 'not_found' })
    res.json(entry)
})

app.get('/stats', async function(req, res) {
    let v1Count = 0
    if (v1Ready) {
        try {
            const r = await fetch(`${V1_BASE_URL}/stats`)
            const d = await r.json()
            v1Count = d.connected || 0
        } catch (e) {}
    }
    res.json({ connected: getConnectedCount() + v1Count })
})
app.get('/ping',  function(req, res) { res.send('pong') })
app.get('/health',function(req, res) { res.json({ status: 'ok', uptime: process.uptime() }) })
app.get('/status',function(req, res) { res.json({ v1: v1Ready, v2: repoReady.v2 }) })

setInterval(function() { console.log('keep-alive') }, 4 * 60 * 1000)

app.get('/', function(req, res) { res.send(buildHtml()) })

function buildHtml() {
const styles = `
*{margin:0;padding:0;box-sizing:border-box;}
:root{
  --bg:#060907;--panel:#0b120c;--panel2:#081008;--border:#163322;
  --accent:#39ff7a;--accent-dim:#1f9c4b;--accent-glow:rgba(57,255,122,0.35);
  --text-dim:#5d8268;--amber:#ffb454;--red:#ff5454;
}
html,body{min-height:100vh;width:100%;}
body{
  background:var(--bg);
  background-image:radial-gradient(circle at 50% -10%,var(--accent-glow),transparent 55%);
  color:var(--accent);font-family:'JetBrains Mono','Fira Code',Consolas,monospace;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  width:100%;padding:24px;position:relative;overflow-x:hidden;
}
body::before{content:'';position:fixed;inset:0;z-index:50;pointer-events:none;
  background:repeating-linear-gradient(to bottom,rgba(255,255,255,0.025) 0px,rgba(255,255,255,0.025) 1px,transparent 1px,transparent 3px);
  mix-blend-mode:overlay;}
.noise{position:fixed;inset:0;z-index:40;pointer-events:none;opacity:.05;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");}
.terminal{width:100%;max-width:480px;background:var(--panel);border:1px solid var(--border);
  border-radius:10px;box-shadow:0 30px 80px -20px rgba(0,0,0,0.85),0 0 50px -10px var(--accent-glow);
  position:relative;z-index:1;overflow:hidden;}
.term-bar{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#081209;border-bottom:1px solid var(--border);}
.dot{width:9px;height:9px;border-radius:50%;}
.dot.r{background:#ff5f56;}.dot.y{background:#ffbd2e;}.dot.g{background:#27c93f;}
.term-body{padding:28px 26px 24px;}
.title-row{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;}
.title{font-size:25px;font-weight:800;letter-spacing:3px;text-shadow:0 0 14px var(--accent-glow);}
.cursor{display:inline-block;width:9px;height:18px;background:var(--accent);animation:blink 1.1s steps(1) infinite;vertical-align:-3px;}
.subtitle{color:var(--text-dim);font-size:12px;margin-bottom:16px;}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;}
.tag{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--accent-dim);border:1px solid var(--border);padding:4px 9px;border-radius:4px;}
.readout{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);
  background:var(--panel2);border-radius:6px;padding:13px 16px;margin-bottom:20px;}
.readout-left{display:flex;align-items:center;gap:10px;}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent);animation:pulse 1.6s ease-in-out infinite;}
.readout .num{font-size:24px;font-weight:800;color:var(--accent);text-shadow:0 0 10px var(--accent-glow);}
.readout .lbl{font-size:9.5px;color:var(--text-dim);letter-spacing:1.3px;text-transform:uppercase;text-align:right;line-height:1.5;}

/* VERSION TABS */
.version-tabs{display:flex;gap:0;margin-bottom:18px;border:1px solid var(--border);border-radius:6px;overflow:hidden;}
.vtab{flex:1;padding:10px;text-align:center;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;
  cursor:pointer;background:var(--panel2);color:var(--text-dim);border:none;font-family:inherit;
  transition:all .2s;position:relative;overflow:hidden;}
.vtab.active{background:var(--accent);color:#04140a;font-weight:800;}
.vtab:not(.active):hover{color:var(--accent);}
.vtab-badge{display:inline-block;font-size:8px;padding:1px 5px;border-radius:3px;margin-left:4px;
  background:rgba(255,255,255,.15);vertical-align:middle;}

.field-label{font-size:10px;color:var(--text-dim);letter-spacing:1.4px;text-transform:uppercase;margin-bottom:8px;}
.input-row{display:flex;align-items:center;background:var(--panel2);border:1px solid var(--border);
  border-radius:6px;padding:0 14px;margin-bottom:14px;transition:border-color .2s,box-shadow .2s;}
.input-row:focus-within{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--accent-glow);}
.prompt-sym{color:var(--accent-dim);margin-right:9px;font-weight:700;font-size:15px;}
input{flex:1;background:transparent;border:none;outline:none;color:var(--accent);
  font-family:inherit;font-size:14.5px;padding:14px 0;letter-spacing:.5px;width:100%;min-width:0;}
input::placeholder{color:#2b4a35;}
button#pairBtn{
  width:100%;padding:14px;background:transparent;border:1px solid var(--accent-dim);
  color:var(--accent);font-family:inherit;font-size:12.5px;letter-spacing:2.5px;text-transform:uppercase;
  border-radius:6px;cursor:pointer;position:relative;overflow:hidden;transition:color .25s;
}
button#pairBtn .fill{position:absolute;inset:0;background:var(--accent);transform:translateX(-101%);transition:transform .25s ease;z-index:0;}
button#pairBtn span{position:relative;z-index:1;}
button#pairBtn:hover:not(:disabled) .fill{transform:translateX(0);}
button#pairBtn:hover:not(:disabled){color:#04140a;}
button#pairBtn:disabled{opacity:.4;cursor:not-allowed;}
.status{margin-top:18px;border:1px solid var(--border);border-radius:6px;overflow:hidden;display:none;}
.status.show{display:block;}
.status-head{display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:10.5px;
  letter-spacing:1.4px;text-transform:uppercase;border-bottom:1px solid var(--border);}
.status-body{padding:18px 16px 16px;}
.status.loading .status-head{color:var(--text-dim);background:var(--panel2);}
.status.success .status-head{color:var(--accent);background:#08160d;}
.status.connected .status-head{color:#27c93f;background:#08160d;}
.status.error .status-head{color:var(--red);background:#1a0808;}
.loading-msg{font-size:13px;color:var(--accent);margin-bottom:10px;}
.progress-track{height:6px;background:#0d1b10;border-radius:3px;overflow:hidden;margin-bottom:8px;}
.progress-fill{height:100%;width:0%;background:linear-gradient(90deg,var(--accent-dim),var(--accent));
  box-shadow:0 0 8px var(--accent-glow);transition:width .25s ease;}
.progress-pct{font-size:10.5px;color:var(--text-dim);text-align:right;}
.code-label{color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:1.4px;margin-bottom:10px;text-align:center;}
.code-display{font-size:34px;font-weight:800;letter-spacing:5px;color:var(--accent);
  text-align:center;text-shadow:0 0 18px var(--accent-glow);margin-bottom:12px;}
.copy-btn{display:block;margin:0 auto 14px;padding:9px 22px;background:transparent;
  border:1px solid var(--accent-dim);color:var(--accent);border-radius:6px;cursor:pointer;
  font-size:11.5px;letter-spacing:1px;text-transform:uppercase;font-family:inherit;transition:background .2s;}
.copy-btn:hover{background:#0e2414;}
.expire{color:var(--amber);font-size:11px;text-align:center;letter-spacing:.5px;}
.steps{margin-top:14px;font-size:11.5px;color:var(--text-dim);line-height:2;
  border-top:1px dashed var(--border);padding-top:13px;}
.steps b{color:var(--accent-dim);}
.connected-title{font-size:16px;font-weight:700;color:var(--accent);}
.connected-sub{margin-top:8px;color:var(--text-dim);font-size:12.5px;line-height:1.7;}
.error-body{color:var(--red);font-size:13px;}

/* LINKS */
.links{display:flex;gap:7px;margin-top:22px;flex-wrap:wrap;}
.links a{flex:1;min-width:70px;display:flex;flex-direction:column;align-items:center;gap:6px;
  padding:11px 4px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;
  color:var(--text-dim);text-decoration:none;font-size:8.5px;letter-spacing:.8px;
  text-transform:uppercase;transition:border-color .2s,color .2s,transform .15s;}
.links a:hover{border-color:var(--accent-dim);color:var(--accent);transform:translateY(-2px);}
.links a.store{border-color:var(--accent-dim);color:var(--accent);}
.links a.store:hover{background:#0e2414;}
.links svg{width:24px;height:24px;border-radius:6px;}
.store-icon{font-size:20px;line-height:1;}
footer{margin-top:16px;text-align:center;color:#27452f;font-size:9.5px;letter-spacing:1.6px;text-transform:uppercase;}
@keyframes blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}
@keyframes pulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.5);opacity:.35;}}
@media(max-width:480px){.term-body{padding:22px 16px 18px;}.title{font-size:21px;}.code-display{font-size:26px;letter-spacing:3px;}}
`;

const colorScript = `
(function(){
  var palette=[
    {a:"#39ff7a",d:"#1f9c4b",g:"rgba(57,255,122,0.35)"},
    {a:"#39e6ff",d:"#1f8fa3",g:"rgba(57,230,255,0.35)"},
    {a:"#ff3df0",d:"#a3209c",g:"rgba(255,61,240,0.35)"},
    {a:"#ffd23f",d:"#a38a1f",g:"rgba(255,210,63,0.35)"},
    {a:"#7c5cff",d:"#4a2fa3",g:"rgba(124,92,255,0.35)"},
    {a:"#ff8a3d",d:"#a3551f",g:"rgba(255,138,61,0.35)"}
  ];
  var pick=palette[Math.floor(Math.random()*palette.length)];
  var r=document.documentElement.style;
  r.setProperty("--accent",pick.a);r.setProperty("--accent-dim",pick.d);r.setProperty("--accent-glow",pick.g);
})();
`;

const script = `
var polling=null,progressTimer=null,progressValue=0,currentVersion='v2';

function setVersion(v){
  currentVersion=v;
  document.getElementById('tab-v1').className='vtab'+(v==='v1'?' active':'');
  document.getElementById('tab-v2').className='vtab'+(v==='v2'?' active':'');
  document.getElementById('version-label').textContent=v==='v1'?'v1 — AKANE MD':'v2 — AKANE MD v2';
  document.getElementById('status').className='status';
  document.getElementById('pairBtn').disabled=false;
}

function updateCounter(){
  fetch("/stats").then(function(r){return r.json();}).then(function(d){
    document.getElementById("liveCount").textContent=d.connected;
  }).catch(function(){});
}
updateCounter();setInterval(updateCounter,5000);

function startProgress(){
  clearProgressTimer();progressValue=0;renderProgress(0);
  progressTimer=setInterval(function(){
    var rem=92-progressValue;progressValue+=Math.max(0.5,rem*0.09);
    if(progressValue>92)progressValue=92;renderProgress(progressValue);
  },140);
}
function completeProgress(cb){
  clearProgressTimer();progressValue=100;renderProgress(100);
  setTimeout(function(){if(cb)cb();},280);
}
function clearProgressTimer(){if(progressTimer){clearInterval(progressTimer);progressTimer=null;}}
function renderProgress(val){
  var f=document.getElementById("progressFill"),p=document.getElementById("progressPct");
  if(f)f.style.width=val.toFixed(0)+"%";if(p)p.textContent=val.toFixed(0)+"%";
}

function requestCode(){
  var number=document.getElementById("num").value.replace(/[^0-9]/g,"");
  if(number.length<7){showError("numero invalide");return;}
  document.getElementById("pairBtn").disabled=true;
  showLoading("etablissement de la connexion ["+currentVersion+"]...");
  if(polling)clearInterval(polling);
  fetch("/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:number,version:currentVersion})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){clearProgressTimer();showError(d.error);document.getElementById("pairBtn").disabled=false;return;}
      showLoading("generation du code en cours...");
      polling=setInterval(function(){checkCode(number);},1500);
    }).catch(function(){clearProgressTimer();showError("connexion au serveur impossible");document.getElementById("pairBtn").disabled=false;});
}

function checkCode(number){
  fetch("/code/"+number+"?version="+currentVersion).then(function(r){return r.json();}).then(function(d){
    if(d.status==="ready"){
      clearInterval(polling);completeProgress(function(){
        showCode(d.code,number);polling=setInterval(function(){checkConnected(number);},2000);
      });
    }else if(d.status==="error"){clearInterval(polling);clearProgressTimer();showError(d.error||"erreur inconnue");document.getElementById("pairBtn").disabled=false;}
    else if(d.status==="connected"){clearInterval(polling);clearProgressTimer();showConnected(number);}
  }).catch(function(){});
}

function checkConnected(number){
  fetch("/code/"+number+"?version="+currentVersion).then(function(r){return r.json();}).then(function(d){
    if(d.status==="connected"){clearInterval(polling);showConnected(number);updateCounter();}
    else if(d.status==="error"){clearInterval(polling);showError(d.error||"erreur");document.getElementById("pairBtn").disabled=false;}
  }).catch(function(){});
}

function showLoading(msg){
  var s=document.getElementById("status");s.className="status show loading";
  var h="<div class=\\"status-head\\"><span>&gt;_</span><span>processus en cours</span></div>";
  h+="<div class=\\"status-body\\">";
  h+="<div class=\\"loading-msg\\">"+msg+"</div>";
  h+="<div class=\\"progress-track\\"><div class=\\"progress-fill\\" id=\\"progressFill\\"></div></div>";
  h+="<div class=\\"progress-pct\\" id=\\"progressPct\\">0%</div></div>";
  s.innerHTML=h;startProgress();
}

function showCode(code,number){
  var s=document.getElementById("status");s.className="status show success";
  var h="<div class=\\"status-head\\"><span>&gt;_</span><span>code genere</span></div>";
  h+="<div class=\\"status-body\\">";
  h+="<div class=\\"code-label\\">ton code de connexion whatsapp</div>";
  h+="<div class=\\"code-display\\">"+code+"</div>";
  h+="<button class=\\"copy-btn\\" onclick=\\"copyCode(this.dataset.code)\\" data-code=\\""+code+"\\">copier le code</button>";
  h+="<div class=\\"expire\\">expire dans 60 secondes</div>";
  h+="<div class=\\"steps\\"><b>01.</b> ouvre whatsapp<br><b>02.</b> parametres → appareils lies<br><b>03.</b> lier un appareil → lier avec un numero<br><b>04.</b> entre le code ci-dessus</div>";
  h+="</div>";s.innerHTML=h;
}

function showConnected(number){
  var s=document.getElementById("status");s.className="status show connected";
  var h="<div class=\\"status-head\\"><span>&gt;_</span><span>connexion etablie</span></div>";
  h+="<div class=\\"status-body\\">";
  h+="<div class=\\"connected-title\\">bot connecte ["+currentVersion+"] ✓</div>";
  h+="<div class=\\"connected-sub\\">+"+number+" est actif 24h/24.<br>verifie whatsapp, un message de confirmation a ete envoye.</div>";
  h+="</div>";s.innerHTML=h;document.getElementById("pairBtn").disabled=false;
}

function showError(msg){
  var s=document.getElementById("status");s.className="status show error";
  var h="<div class=\\"status-head\\"><span>&gt;_</span><span>erreur</span></div>";
  h+="<div class=\\"status-body error-body\\">"+msg+"</div>";s.innerHTML=h;
}

function copyCode(code){
  navigator.clipboard.writeText(code).then(function(){
    var b=document.querySelector(".copy-btn");if(b){b.textContent="copie !";setTimeout(function(){b.textContent="copier le code";},2000);}
  });
}
`;

return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AKANE MD :: Pairing Terminal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${styles}</style>
<script>${colorScript}</script>
</head>
<body>
<div class="noise"></div>
<div class="terminal">
  <div class="term-bar">
    <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
    <span style="margin-left:auto;font-size:9px;color:var(--text-dim);letter-spacing:1px;">AKANE MD :: PAIRING</span>
  </div>
  <div class="term-body">
    <div class="title-row"><span class="title">AKANE_MD</span><span class="cursor"></span></div>
    <div class="subtitle">// connecte ton whatsapp au bot</div>
    <div class="tags">
      <span class="tag">multi-user</span>
      <span class="tag">plugin-system</span>
      <span class="tag">encrypted</span>
    </div>

    <div class="readout">
      <div class="readout-left"><span class="pulse"></span><span class="num" id="liveCount">--</span></div>
      <div class="lbl">bots connectes<br>en direct</div>
    </div>

    <!-- VERSION TABS -->
    <div class="version-tabs">
      <button class="vtab" id="tab-v1" onclick="setVersion('v1')">
        V1 <span class="vtab-badge">stable</span>
      </button>
      <button class="vtab active" id="tab-v2" onclick="setVersion('v2')">
        V2 <span class="vtab-badge">plugins</span>
      </button>
    </div>

    <div class="field-label" id="version-label">v2 — AKANE MD v2</div>
    <div class="input-row">
      <span class="prompt-sym">&gt;</span>
      <input id="num" type="tel" placeholder="221705928204" />
    </div>

    <button id="pairBtn" onclick="requestCode()"><span class="fill"></span><span>obtenir le code de connexion</span></button>

    <div id="status" class="status"></div>

    <div class="links">
      <a href="${STORE_LINK}" target="_blank" class="store">
        <span class="store-icon">🏪</span>
        <span>plugin store</span>
      </a>
      <a href="${GITHUB_V1}" target="_blank">
        <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#161b22"/><path fill="#fff" d="M16 8c-4.4 0-8 3.6-8 8 0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.1 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3-1.8 3.7-3.6 3.9.3.3.5.8.5 1.6v2.4c0 .2.1.5.5.4 3.2-1.1 5.5-4.1 5.5-7.6 0-4.4-3.6-8-8-8z"/></svg>
        <span>github v1</span>
      </a>
      <a href="${GITHUB_V2}" target="_blank">
        <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#161b22"/><path fill="#fff" d="M16 8c-4.4 0-8 3.6-8 8 0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-3.9 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.4 1.1.1 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3-1.8 3.7-3.6 3.9.3.3.5.8.5 1.6v2.4c0 .2.1.5.5.4 3.2-1.1 5.5-4.1 5.5-7.6 0-4.4-3.6-8-8-8z"/></svg>
        <span>github v2</span>
      </a>
      <a href="${CHANNEL_LINK}" target="_blank">
        <svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#25D366"/><path fill="#fff" d="M16 7c-5 0-9 4-9 9 0 1.6.4 3.1 1.2 4.4L7 24l3.8-1.2c1.3.7 2.7 1.1 4.2 1.1 5 0 9-4 9-9s-4-9-9-9zm5.1 12.7c-.2.6-1.2 1.1-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6-2.6-1.1-4.3-3.7-4.4-3.9-.1-.2-1-1.4-1-2.6 0-1.2.6-1.8.9-2.1.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .5.4.2.4.7 1.7.7 1.8.1.1.1.3 0 .4-.4.8-.8.8-.5 1.3.6 1 1.1 1.4 1.9 2 .1.1.3.1.4 0 .2-.2.7-.8.9-1.1.2-.2.3-.2.5-.1.2.1 1.5.7 1.7.8.2.1.4.2.4.3.1.2.1.6-.1 1.2z"/></svg>
        <span>chaine</span>
      </a>
      <a href="${YOUTUBE_LINK}" target="_blank">
        <svg viewBox="0 0 32 32"><rect x="1" y="6" width="30" height="20" rx="6" fill="#FF0000"/><polygon points="13,11.5 22,16 13,20.5" fill="#fff"/></svg>
        <span>youtube</span>
      </a>
    </div>
  </div>
</div>
<footer>akane md v2 :: plugin ecosystem :: akanefx2003</footer>
<script>${script}</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000
app.listen(PORT, function() {
    console.log('AKANE MD Web Pair -> http://localhost:' + PORT)
    // Ne pas attendre : le serveur doit répondre immédiatement (health check Render, etc.)
    prepareRepos()
    restoreSessions().catch(e => console.error('Erreur restoreSessions:', e.message))
    watchV1Ready() // démarre pair.js (v1) dès que le repo v1 est prêt
})

export { spawnBot as startWebpairBot, getConnectedCount }

// version optionnelle : si fournie, vérifie ce process précis (v1 OU v2) ;
// sinon, cherche n'importe quel process actif pour ce numéro, toutes versions confondues
export function isWebpairManaged(number, version) {
    if (version) return activeBots.has(botKey(number, version))
    for (const key of activeBots.keys()) if (key.endsWith(`:${number}`)) return true
    return false
}
export function getWebpairBot(number, version) {
    if (version) return activeBots.get(botKey(number, version))
    for (const [key, bot] of activeBots) if (key.endsWith(`:${number}`)) return bot
    return undefined
}
