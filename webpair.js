// webpair.js — AKANE MD FAÇADE (à déployer sur Render)
// Ce fichier ne lance AUCUN bot. Il sert le site et relaie les requêtes vers le runner
// (runner-server.js) hébergé sur Téo Héberg, en envoyant l'en-tête x-runner-key.
//
// Variables d'environnement à définir sur Render :
//   RUNNER_URL = http://node02.teoheberg.fr:25576
//   RUNNER_KEY = la MÊME clé que dans runner-server.js
import express from 'express'
import fs from 'fs'

const app = express()
app.use(express.json())

const RUNNER_URL = (process.env.RUNNER_URL || 'http://node02.teoheberg.fr:25576').replace(/\/+$/, '')
const RUNNER_KEY = process.env.RUNNER_KEY || 'YK0qGQHtknCdFr0TXcVdzP9TFqGXT'
const RUNNER_TIMEOUT_MS = 20000

const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb865EJ0QeapgV7MkP2D'
const GITHUB_V1    = 'https://github.com/akanefx2003/AKANE_MD'
const GITHUB_V2    = 'https://github.com/akanefx2003/AKANE-MD-V2.git'
const STORE_LINK   = 'https://v2-five-lyart.vercel.app'
const YOUTUBE_LINK = 'https://youtube.com/@akanefx-j3k9o?si=umMPewjZUzcOhilE'

const TOTAL_FILE     = './sessions/total_users.json'   // numéros ayant déjà connecté un bot au moins une fois
const REFERRALS_FILE = './sessions/referrals.json'     // { "<numero_parrain>": { referred: [numeros...] } }
const REFERRAL_GOAL  = 15
const pendingRef = new Map() // "version:number" -> code du parrain pour ce pairing en cours

function readJSON(file, fallback) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback } catch (e) { return fallback }
}
function writeJSON(file, data) {
    try {
        if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions', { recursive: true })
        fs.writeFileSync(file, JSON.stringify(data, null, 2))
    } catch (e) {}
}

function getTotalUsers() { return readJSON(TOTAL_FILE, []) }
function registerTotalUser(number) {
    const list = getTotalUsers()
    if (!list.includes(number)) { list.push(number); writeJSON(TOTAL_FILE, list) }
    return list.length
}

function getReferralData() { return readJSON(REFERRALS_FILE, {}) }
function getReferralCount(code) { return (getReferralData()[code]?.referred || []).length }
function registerReferral(refCode, referredNumber) {
    if (!refCode || refCode === referredNumber) return
    const data = getReferralData()
    if (!data[refCode]) data[refCode] = { referred: [] }
    if (!data[refCode].referred.includes(referredNumber)) {
        data[refCode].referred.push(referredNumber)
        writeJSON(REFERRALS_FILE, data)
    }
}

function botKey(number, version) { return `${version}:${number}` }

// ── Appel au runner (Téo Héberg) avec la clé secrète ──
async function callRunner(pathname, opts = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), RUNNER_TIMEOUT_MS)
    try {
        const r = await fetch(RUNNER_URL + pathname, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', 'x-runner-key': RUNNER_KEY },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            signal: controller.signal
        })
        if (r.status === 401) return { error: 'Clé runner invalide : RUNNER_KEY doit être identique sur Render et sur Téo Héberg' }
        const text = await r.text()
        try { return JSON.parse(text) } catch (e) { return { error: `Réponse inattendue du runner (HTTP ${r.status})` } }
    } catch (e) {
        return { error: 'Runner injoignable : ' + (e.name === 'AbortError' ? 'délai dépassé' : e.message) }
    } finally {
        clearTimeout(timer)
    }
}

// ── Routes appelées par le navigateur, relayées vers le runner ──
app.post('/pair', async function(req, res) {
    const number = req.body.number
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    const ref = (req.body.ref || '').replace(/[^0-9]/g, '') || null
    if (!number || number.replace(/[^0-9]/g, '').length < 7) return res.json({ error: 'Numero invalide' })
    const clean = number.replace(/[^0-9]/g, '')

    const data = await callRunner('/pair', { method: 'POST', body: { number: clean, version } })
    if (!data.error && ref) pendingRef.set(botKey(clean, version), ref)
    res.json(data)
})

app.post('/disconnect', async function(req, res) {
    const number = (req.body.number || '').replace(/[^0-9]/g, '')
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    if (!number) return res.json({ error: 'Numero invalide' })
    res.json(await callRunner('/disconnect', { method: 'POST', body: { number, version } }))
})

app.get('/code/:number', async function(req, res) {
    const clean = req.params.number.replace(/[^0-9]/g, '')
    const version = req.query.version === 'v1' ? 'v1' : 'v2'

    const data = await callRunner(`/code/${clean}?version=${version}`)
    if (data.error && !data.status) return res.json({ status: 'error', error: data.error })

    // Quand le runner annonce "connected", on compte l'utilisateur une seule fois
    // dans le total historique et on crédite son parrain (si un ref a été fourni).
    if (data.status === 'connected') {
        const key = botKey(clean, version)
        const alreadyCounted = getTotalUsers().includes(clean)
        registerTotalUser(clean)
        if (!alreadyCounted) {
            const ref = pendingRef.get(key)
            if (ref) registerReferral(ref, clean)
        }
        pendingRef.delete(key)
    }
    res.json(data)
})

app.get('/stats', async function(req, res) {
    const data = await callRunner('/stats')
    res.json({ connected: data.connected || 0, totalUsers: getTotalUsers().length })
})

app.get('/referrals/:code', function(req, res) {
    const code = req.params.code.replace(/[^0-9]/g, '')
    const count = getReferralCount(code)
    res.json({ code, count, goal: REFERRAL_GOAL, remaining: Math.max(0, REFERRAL_GOAL - count), unlocked: count >= REFERRAL_GOAL })
})

app.get('/ping',  function(req, res) { res.send('pong') })
app.get('/health', function(req, res) {
    res.set('Cache-Control', 'no-store')
    res.json({ status: 'ok', uptime: process.uptime(), runner: RUNNER_URL })
})
app.get('/status', async function(req, res) {
    const data = await callRunner('/health')
    res.json({ v1: !!data.v1, v2: !!data.v2, runnerError: data.error || null })
})

setInterval(function() { console.log('keep-alive') }, 4 * 60 * 1000)

app.get('/', function(req, res) { res.send(buildHtml()) })


function buildHtml() {
const ICON_GITHUB = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:-2px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
const ICON_WHATSAPP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M17.47 14.38c-.29-.15-1.73-.85-2-.95-.27-.1-.46-.15-.66.15-.2.29-.76.94-.93 1.14-.17.19-.34.22-.63.07-.29-.15-1.22-.45-2.33-1.43-.86-.77-1.44-1.72-1.61-2.01-.17-.29-.02-.45.13-.6.13-.13.29-.34.44-.51.15-.17.19-.29.29-.48.1-.19.05-.36-.02-.51-.07-.15-.66-1.59-.9-2.18-.24-.57-.48-.5-.66-.5-.17-.01-.36-.01-.56-.01-.19 0-.51.07-.78.36-.27.29-1.02 1-1.02 2.43s1.05 2.82 1.19 3.01c.15.19 2.06 3.15 5 4.41.7.3 1.24.48 1.67.62.7.22 1.34.19 1.84.12.56-.08 1.73-.71 1.98-1.39.24-.68.24-1.27.17-1.39-.07-.12-.26-.19-.55-.34z"/><path d="M12 2C6.48 2 2 6.48 2 12c0 1.85.5 3.58 1.36 5.06L2 22l5.05-1.33A9.95 9.95 0 0 0 12 22c5.52 0 10-4.48 10-10S17.52 2 12 2zm0 18c-1.6 0-3.14-.43-4.48-1.24l-.32-.19-3.16.83.85-3.08-.21-.32A7.94 7.94 0 0 1 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z"/></svg>';
const ICON_YOUTUBE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.51 3.5 12 3.5 12 3.5s-7.51 0-9.38.55A3.02 3.02 0 0 0 .5 6.19 31.6 31.6 0 0 0 0 12a31.6 31.6 0 0 0 .5 5.81 3.02 3.02 0 0 0 2.12 2.14C4.49 20.5 12 20.5 12 20.5s7.51 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14A31.6 31.6 0 0 0 24 12a31.6 31.6 0 0 0-.5-5.81zM9.6 15.6V8.4l6.4 3.6-6.4 3.6z"/></svg>';
const ICON_STORE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-2px"><path d="M4 4h16l1.5 5.5a2.5 2.5 0 0 1-2.5 3.1c-.8 0-1.5-.3-2-.9-.5.6-1.2.9-2 .9s-1.5-.3-2-.9c-.5.6-1.2.9-2 .9s-1.5-.3-2-.9c-.5.6-1.2.9-2 .9a2.5 2.5 0 0 1-2.5-3.1L4 4zm1 9.9c.7.3 1.4.4 2 .4.9 0 1.7-.2 2.5-.6.8.4 1.6.6 2.5.6s1.7-.2 2.5-.6c.8.4 1.6.6 2.5.6.6 0 1.3-.1 2-.4V20H5v-6.1z"/></svg>';
const styles = `
:root {
  --bg: #0c0710;
  --bg-alt: #150c1a;
  --card: #1a1020;
  --border: rgba(255,255,255,0.08);
  --accent: #ff2d78;
  --accent-dim: rgba(255,45,120,0.15);
  --text: #f2edf5;
  --text-dim: #9a8fa8;
  --green: #34d399;
  --red: #ff5470;
  --yellow: #ffb84d;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: radial-gradient(ellipse at top, var(--bg-alt), var(--bg) 60%);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  min-height: 100vh;
}
.container { max-width: 640px; margin: 0 auto; padding: 0 16px; }

/* Navbar */
.navbar { border-bottom: 1px solid var(--border); padding: 14px 0; position: sticky; top: 0; background: var(--bg); z-index: 10; }
.navbar .container { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.nav-brand { display: flex; align-items: center; gap: 8px; }
.logo { font-size: 20px; }
.brand-name { font-weight: 800; font-size: 16px; }
.version-badge { background: var(--accent-dim); color: var(--accent); font-size: 10px; padding: 2px 7px; border-radius: 6px; font-weight: 700; }
.nav-links { display: flex; gap: 4px; background: var(--card); border-radius: 10px; padding: 3px; }
.nav-link { background: none; border: none; color: var(--text-dim); font-family: inherit; font-size: 12px; padding: 7px 12px; border-radius: 8px; cursor: pointer; }
.nav-link.active { background: var(--accent); color: #1a0a10; font-weight: 700; }

main { padding: 28px 0 50px; }
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Terminal (onglet connexion) */
.terminal-wrapper { padding-top: 4px; }
.terminal { background: var(--card); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; }
.terminal-header { display: flex; align-items: center; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.dot.red { background: var(--red); } .dot.yellow { background: var(--yellow); } .dot.green { background: var(--green); }
.terminal-title { margin-left: auto; font-size: 10px; color: var(--text-dim); letter-spacing: 0.5px; }
.terminal-body { padding: 22px; }

.status-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; font-size: 12px; flex-wrap: wrap; gap: 8px; }
.status-indicator { display: flex; align-items: center; gap: 7px; }
.pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 0 rgba(52,211,153,0.6); animation: pulse 1.8s infinite; }
@keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(52,211,153,0.5)} 70%{box-shadow:0 0 0 7px rgba(52,211,153,0)} 100%{box-shadow:0 0 0 0 rgba(52,211,153,0)} }
.bot-count { color: var(--text-dim); }
.bot-count b { color: var(--accent); font-weight: 700; }

.version-tabs { display: flex; gap: 4px; background: var(--bg-alt); border-radius: 10px; padding: 3px; margin-bottom: 16px; }
.vtab { flex: 1; background: none; border: none; color: var(--text-dim); font-family: inherit; font-size: 11px; padding: 8px; border-radius: 8px; cursor: pointer; }
.vtab.active { background: var(--accent); color: #1a0a10; font-weight: 700; }

.input-label { display: block; font-size: 11px; color: var(--text-dim); margin-bottom: 8px; }
.input-group { display: flex; gap: 8px; margin-bottom: 12px; }
.prefix { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 10px; padding: 0 12px; display: flex; align-items: center; font-size: 13px; color: var(--text-dim); }
#num { flex: 1; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 10px; padding: 0 12px; height: 42px; color: var(--text); font-family: inherit; font-size: 14px; min-width: 0; }
#num:focus { outline: none; border-color: var(--accent); }
#pairBtn { width: 100%; background: var(--accent); border: none; border-radius: 10px; padding: 13px; color: #1a0a10; font-family: inherit; font-weight: 700; font-size: 13px; cursor: pointer; }
#pairBtn:disabled { opacity: 0.6; cursor: default; }

.status-container { margin-top: 18px; }
.status-card { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 12px; padding: 18px; text-align: center; }
.status-icon { font-size: 22px; margin-bottom: 8px; }
.status-message { font-size: 13px; color: var(--text-dim); margin-bottom: 12px; }
.progress-bar { height: 4px; background: var(--border); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; width: 0%; background: var(--accent); transition: width 0.15s linear; }
.progress-text { font-size: 10px; color: var(--text-dim); margin-top: 6px; }

.code-display-wrapper { margin-top: 18px; text-align: center; background: var(--bg-alt); border: 1px solid var(--accent); border-radius: 12px; padding: 20px; }
.code-label { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; }
.code-display { font-size: 30px; font-weight: 800; letter-spacing: 4px; color: var(--accent); margin-bottom: 14px; }
.copy-btn { background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); border-radius: 8px; padding: 8px 16px; font-family: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.expire { font-size: 10px; color: var(--yellow); margin: 10px 0; }
.steps { text-align: left; font-size: 11px; color: var(--text-dim); line-height: 1.9; margin-top: 12px; }
.steps span { color: var(--accent); font-weight: 700; }

#connectedDisplay { margin-top: 18px; text-align: center; background: rgba(52,211,153,0.08); border: 1px solid var(--green); border-radius: 12px; padding: 20px; }
.connected-title { color: var(--green); font-weight: 700; font-size: 15px; margin-bottom: 8px; }
.connected-sub { font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.error-card { margin-top: 18px; background: rgba(255,84,112,0.08); border: 1px solid var(--red); border-radius: 12px; padding: 16px; font-size: 12px; color: var(--red); text-align: center; }

/* Parrainage */
.ref-card { margin-top: 18px; background: var(--bg-alt); border: 1px dashed var(--accent); border-radius: 12px; padding: 16px; }
.ref-head { font-size: 12px; color: var(--accent); margin-bottom: 10px; font-weight: 700; }
.ref-row { display: flex; gap: 8px; }
.ref-row input { flex: 1; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; color: var(--text); font-family: inherit; font-size: 12px; min-width: 0; }
.ref-row button { background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); border-radius: 8px; padding: 9px 14px; font-family: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.ref-result { margin-top: 10px; font-size: 12px; color: var(--text-dim); }
.ref-track { height: 5px; background: var(--border); border-radius: 4px; overflow: hidden; margin-top: 6px; }
.ref-fill { height: 100%; background: var(--accent); }

.links-section { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
.link-btn { flex: 1; min-width: 90px; text-align: center; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 10px; padding: 10px; color: var(--text); text-decoration: none; font-size: 11px; }
.link-btn:hover { border-color: var(--accent); color: var(--accent); }

/* Tarifs */
.plugins-header h2 { font-size: 20px; margin-bottom: 4px; }
.plugins-header p { color: var(--text-dim); font-size: 12px; margin-bottom: 18px; line-height: 1.6; }
.price-section { margin-bottom: 26px; }
.price-section h3 { font-size: 13px; margin-bottom: 4px; }
.price-section .price-note { font-size: 11px; color: var(--text-dim); margin-bottom: 12px; line-height: 1.6; }
.price-grid { display: grid; gap: 10px; }
.price-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.price-card.featured { border-color: var(--accent); }
.pc-left b { font-size: 13px; display: block; }
.pc-left span { font-size: 11px; color: var(--text-dim); }
.pc-amount { font-size: 18px; font-weight: 800; color: var(--accent); white-space: nowrap; }
.pc-amount small { font-size: 9px; color: var(--text-dim); font-weight: 500; display: block; text-align: right; }
.quote-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.quote-card .qc-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.quote-card .qc-row:last-child { border-bottom: none; }
.quote-card b { font-size: 12.5px; display: block; }
.quote-card .qc-row span.desc { font-size: 11px; color: var(--text-dim); }
.badge-devis { flex-shrink: 0; font-size: 10px; font-weight: 700; color: var(--yellow); background: rgba(255,184,77,0.12); padding: 5px 10px; border-radius: 8px; white-space: nowrap; }

/* Paiement */
.pay-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
.pay-chip { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 18px; font-size: 12px; font-weight: 700; }
.pay-chip.dim { color: var(--text-dim); font-weight: 500; }
.contact-btn { display: block; text-align: center; background: var(--accent); color: #1a0a10; border-radius: 12px; padding: 14px; font-weight: 700; font-size: 13px; text-decoration: none; margin-top: 6px; }

.footer { text-align: center; padding: 20px; color: var(--text-dim); font-size: 11px; border-top: 1px solid var(--border); }

/* Bouton commander sur les prix */
.pc-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.order-btn { background: var(--accent-dim); color: var(--accent); border: 1px solid var(--accent); border-radius: 8px; padding: 6px 12px; font-size: 10.5px; font-weight: 700; text-decoration: none; white-space: nowrap; }
.order-btn:hover { background: var(--accent); color: #1a0a10; }
.quote-card .qc-row { flex-wrap: wrap; }

/* Partage du lien de parrainage après connexion */
.ref-share-box { margin-top: 14px; background: var(--bg-alt); border: 1px solid var(--accent); border-radius: 12px; padding: 14px; text-align: left; }
.ref-share-title { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 6px; }
.ref-share-text { font-size: 11px; color: var(--text-dim); line-height: 1.6; margin-bottom: 10px; }
#myRefLink { flex: 1; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; color: var(--text); font-family: inherit; font-size: 11px; min-width: 0; }

/* Déploiement manuel */
.deploy-box { margin-top: 18px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.deploy-title { font-size: 12px; font-weight: 700; margin-bottom: 6px; }
.deploy-text { font-size: 11px; color: var(--text-dim); margin-bottom: 12px; line-height: 1.6; }
.deploy-btns { display: flex; gap: 8px; margin-bottom: 12px; }
.deploy-btn { flex: 1; text-align: center; background: var(--accent); color: #1a0a10; border-radius: 8px; padding: 10px; font-size: 11.5px; font-weight: 700; text-decoration: none; }
.deploy-steps { font-size: 10.5px; color: var(--text-dim); line-height: 1.9; }
.deploy-steps span { color: var(--accent); font-weight: 700; }
.deploy-steps code { background: var(--card); border-radius: 4px; padding: 1px 6px; color: var(--text); }

/* Mur "suivre la chaîne" */
.follow-gate { position: fixed; inset: 0; background: rgba(6,3,9,0.92); backdrop-filter: blur(6px); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 20px; }
.follow-card { background: var(--card); border: 1px solid var(--accent); border-radius: 16px; padding: 30px 26px; max-width: 340px; text-align: center; }
.follow-logo { font-size: 34px; margin-bottom: 10px; }
.follow-card h2 { font-size: 17px; margin-bottom: 10px; }
.follow-card p { font-size: 12px; color: var(--text-dim); line-height: 1.6; margin-bottom: 20px; }
.follow-btn { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--green); color: #06210f; border-radius: 10px; padding: 13px; font-weight: 700; font-size: 13px; text-decoration: none; margin-bottom: 10px; }
.continue-btn { width: 100%; background: var(--accent); border: none; border-radius: 10px; padding: 13px; color: #1a0a10; font-family: inherit; font-weight: 700; font-size: 13px; cursor: pointer; }
.continue-btn:disabled { opacity: 0.4; cursor: not-allowed; }
@media (max-width: 480px) { .terminal-body { padding: 18px; } }
`;

const script = `
var polling=null, progressTimer=null, progressValue=0, currentVersion='v2';

document.querySelectorAll('.nav-link').forEach(function(btn){
  btn.addEventListener('click', function(){
    document.querySelectorAll('.nav-link').forEach(function(b){b.classList.remove('active');});
    document.querySelectorAll('.tab-content').forEach(function(t){t.classList.remove('active');});
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
  });
});

function setVersion(v){
  currentVersion=v;
  document.getElementById('tab-v1').className='vtab'+(v==='v1'?' active':'');
  document.getElementById('tab-v2').className='vtab'+(v==='v2'?' active':'');
  document.getElementById('version-label').textContent=v==='v1'?'v1 — AKANE MD':'v2 — AKANE MD v2';
  hideAllStatus();
  document.getElementById('pairBtn').disabled=false;
}

function updateCounter(){
  fetch("/stats").then(function(r){return r.json();}).then(function(d){
    document.getElementById("liveCount").textContent=d.connected;
    document.getElementById("totalCount").textContent=d.totalUsers;
  }).catch(function(){});
}
updateCounter();setInterval(updateCounter,5000);

var refCode=(function(){
  var m=window.location.search.match(/[?&]ref=([0-9]+)/);
  if(m)localStorage.setItem("akane_ref",m[1]);
  return localStorage.getItem("akane_ref")||"";
})();

function checkReferrals(){
  var number=document.getElementById("refNum").value.replace(/[^0-9]/g,"");
  var box=document.getElementById("refResult");
  if(number.length<7){box.innerHTML="Numéro invalide";return;}
  box.innerHTML="Chargement...";
  fetch("/referrals/"+number).then(function(r){return r.json();}).then(function(d){
    var pct=Math.min(100,Math.round((d.count/d.goal)*100));
    var h=d.unlocked
      ? "🎉 Bot complet débloqué ! Écris sur WhatsApp pour le récupérer."
      : (d.count+" / "+d.goal+" filleuls — encore "+d.remaining+" pour ton bot gratuit");
    h+="<div class=\\"ref-track\\"><div class=\\"ref-fill\\" style=\\"width:"+pct+"%\\"></div></div>";
    box.innerHTML=h;
  }).catch(function(){box.innerHTML="Erreur de connexion";});
}

function hideAllStatus(){
  document.getElementById('statusContainer').style.display='none';
  document.getElementById('codeDisplay').style.display='none';
  document.getElementById('connectedDisplay').style.display='none';
  var err=document.getElementById('errorCard'); if(err) err.remove();
}

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
  var f=document.getElementById("progressFill"),p=document.getElementById("progressText");
  if(f)f.style.width=val.toFixed(0)+"%";if(p)p.textContent=val.toFixed(0)+"%";
}

function requestCode(){
  var number=document.getElementById("num").value.replace(/[^0-9]/g,"");
  if(number.length<7){showError("Numéro invalide");return;}
  document.getElementById("pairBtn").disabled=true;
  hideAllStatus();
  showLoading("Établissement de la connexion ["+currentVersion+"]...");
  if(polling)clearInterval(polling);
  fetch("/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({number:number,version:currentVersion,ref:refCode})})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.error){clearProgressTimer();showError(d.error);document.getElementById("pairBtn").disabled=false;return;}
      showLoading("Génération du code en cours...");
      polling=setInterval(function(){checkCode(number);},1500);
    }).catch(function(){clearProgressTimer();showError("Connexion au serveur impossible");document.getElementById("pairBtn").disabled=false;});
}

function checkCode(number){
  fetch("/code/"+number+"?version="+currentVersion).then(function(r){return r.json();}).then(function(d){
    if(d.status==="ready"){
      clearInterval(polling);completeProgress(function(){
        showCode(d.code,number);polling=setInterval(function(){checkConnected(number);},2000);
      });
    }else if(d.status==="error"){clearInterval(polling);clearProgressTimer();showError(d.error||"Erreur inconnue");document.getElementById("pairBtn").disabled=false;}
    else if(d.status==="connected"){clearInterval(polling);clearProgressTimer();showConnected(number);}
  }).catch(function(){});
}

function checkConnected(number){
  fetch("/code/"+number+"?version="+currentVersion).then(function(r){return r.json();}).then(function(d){
    if(d.status==="connected"){clearInterval(polling);showConnected(number);updateCounter();}
    else if(d.status==="error"){clearInterval(polling);showError(d.error||"Erreur");document.getElementById("pairBtn").disabled=false;}
  }).catch(function(){});
}

function showLoading(msg){
  hideAllStatus();
  var c=document.getElementById('statusContainer');
  c.style.display='block';
  document.getElementById('statusMessage').textContent=msg;
  startProgress();
}

function showCode(code,number){
  hideAllStatus();
  var d=document.getElementById('codeDisplay');
  d.style.display='block';
  document.getElementById('pairingCode').textContent=code;
  document.getElementById('expireText').textContent='⏱ Expire dans 60 secondes';
}

function showConnected(number){
  hideAllStatus();
  var d=document.getElementById('connectedDisplay');
  d.style.display='block';
  document.getElementById('connectedNumber').textContent='+'+number;
  document.getElementById('pairBtn').disabled=false;
  var link=window.location.origin+window.location.pathname+'?ref='+number;
  document.getElementById('myRefLink').value=link;
}

function copyRefLink(){
  var input=document.getElementById('myRefLink');
  input.select();
  navigator.clipboard.writeText(input.value).then(function(){
    var b=event.target;var original=b.textContent;
    b.textContent='Copié !';
    setTimeout(function(){b.textContent=original;},1500);
  });
}

function showError(msg){
  hideAllStatus();
  var div=document.createElement('div');
  div.id='errorCard';div.className='error-card';div.textContent='❌ '+msg;
  document.getElementById('status-anchor').after(div);
}

function copyCode(){
  var code=document.getElementById('pairingCode').textContent;
  navigator.clipboard.writeText(code).then(function(){
    var b=document.querySelector('.copy-btn');
    var original=b.textContent;
    b.textContent='✅ Copié !';
    setTimeout(function(){b.textContent=original;},1500);
  });
}
`;

return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AKANE-MD :: Déploiement &amp; Tarifs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${styles}</style>
</head>
<body>

<nav class="navbar">
  <div class="container">
    <div class="nav-brand">
      <span class="logo">🌸</span>
      <span class="brand-name">AKANE-MD</span>
      <span class="version-badge">déploiement</span>
    </div>
    <div class="nav-links">
      <button class="nav-link active" data-tab="tarifs">💰 Tarifs</button>
      <button class="nav-link" data-tab="pairing">🔐 Connexion</button>
      <button class="nav-link" data-tab="paiement">💳 Paiement</button>
    </div>
  </div>
</nav>

<main>

  <!-- ── TARIFS ── -->
  <section id="tab-tarifs" class="tab-content active">
    <div class="container">
      <div class="plugins-header">
        <h2>💰 Tarifs</h2>
        <p>Tout ce qui suit est payant, sauf la ligne "sur devis". Paiement confirmé sur WhatsApp avant chaque livraison.</p>
      </div>

      <div class="price-section">
        <h3>Bot WhatsApp personnalisé — payant</h3>
        <div class="price-note">Bot codé et configuré spécialement pour toi, avec ton style de menu.</div>
        <div class="price-grid">
          <div class="price-card"><div class="pc-left"><b>Starter</b><span>15 commandes incluses</span></div><div class="pc-right"><div class="pc-amount">1000<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20le%20forfait%20Starter%20(15%20commandes%2C%201000%20FCFA)" target="_blank">Commander</a></div></div>
          <div class="price-card featured"><div class="pc-left"><b>Pro</b><span>25 commandes incluses</span></div><div class="pc-right"><div class="pc-amount">1500<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20le%20forfait%20Pro%20(25%20commandes%2C%201500%20FCFA)" target="_blank">Commander</a></div></div>
          <div class="price-card"><div class="pc-left"><b>Complet</b><span>Toutes les commandes disponibles</span></div><div class="pc-right"><div class="pc-amount">2500<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20le%20forfait%20Complet%20(2500%20FCFA)" target="_blank">Commander</a></div></div>
        </div>
      </div>

      <div class="price-section">
        <h3>Commande ou plugin à l'unité — payant</h3>
        <div class="price-note">Une commande précise ajoutée à un bot que tu as déjà.</div>
        <div class="price-grid">
          <div class="price-card"><div class="pc-left"><b>1 commande / plugin</b><span>Codée et installée sur ton bot</span></div><div class="pc-right"><div class="pc-amount">200<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20une%20commande%20%2F%20plugin%20a%20l'unite%20(200%20FCFA)" target="_blank">Commander</a></div></div>
        </div>
      </div>

      <div class="price-section">
        <h3>Hébergement de bot — payant</h3>
        <div class="price-note">Ton bot (n'importe quelle version) reste connecté 24h/24, sans coupure, pendant la durée choisie.</div>
        <div class="price-grid">
          <div class="price-card"><div class="pc-left"><b>1 semaine</b><span>Zéro déconnexion garantie</span></div><div class="pc-right"><div class="pc-amount">dès 700<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20l'hebergement%201%20semaine" target="_blank">Commander</a></div></div>
          <div class="price-card"><div class="pc-left"><b>1 mois</b><span>Zéro déconnexion garantie</span></div><div class="pc-right"><div class="pc-amount">2000<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20l'hebergement%201%20mois" target="_blank">Commander</a></div></div>
          <div class="price-card featured"><div class="pc-left"><b>Bot + site déployés</b><span>Pack complet : bot personnalisé + hébergement + site web en ligne</span></div><div class="pc-right"><div class="pc-amount">3000<small>FCFA</small></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20le%20pack%20bot%20%2B%20site%20(3000%20FCFA)" target="_blank">Commander</a></div></div>
        </div>
      </div>

      <div class="price-section">
        <h3>Sur devis</h3>
        <div class="price-note">Le prix dépend du projet — écris-moi pour un devis exact.</div>
        <div class="quote-card">
          <div class="qc-row"><div><b>Création de site web personnel</b><span class="desc">Vitrine, portfolio, blog...</span></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20un%20devis%20pour%20un%20site%20web" target="_blank">Commander</a></div>
          <div class="qc-row"><div><b>Hébergement de site web</b><span class="desc">Mise en ligne et maintien de l'accessibilité</span></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20je%20veux%20un%20devis%20pour%20l'hebergement%20de%20mon%20site" target="_blank">Commander</a></div>
          <div class="qc-row"><div><b>Aide création compte Telegram</b><span class="desc">Accompagnement complet</span></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20j'ai%20besoin%20d'aide%20pour%20creer%20un%20compte%20Telegram" target="_blank">Commander</a></div>
          <div class="qc-row"><div><b>Aide création compte PayPal</b><span class="desc">Accompagnement pas à pas</span></div><a class="order-btn" href="https://wa.me/221760159013?text=Bonjour%2C%20j'ai%20besoin%20d'aide%20pour%20creer%20un%20compte%20PayPal" target="_blank">Commander</a></div>
        </div>
      </div>
    </div>
  </section>

  <!-- ── CONNEXION / PAIRING ── -->
  <section id="tab-pairing" class="tab-content">
    <div class="container terminal-wrapper">
      <div class="terminal">
        <div class="terminal-header">
          <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
          <span class="terminal-title">AKANE-MD :: PAIRING</span>
        </div>
        <div class="terminal-body">
          <div class="status-bar">
            <div class="status-indicator"><span class="pulse-dot"></span><span>Ready 🤖</span></div>
            <div class="bot-count"><b id="liveCount">--</b> connectés · <b id="totalCount">--</b> au total</div>
          </div>

          <div class="version-tabs">
            <button class="vtab" id="tab-v1" onclick="setVersion('v1')">V1 · stable</button>
            <button class="vtab active" id="tab-v2" onclick="setVersion('v2')">V2 · plugins</button>
          </div>

          <label class="input-label" id="version-label">v2 — AKANE MD v2</label>
          <div class="input-group">
            <span class="prefix">+</span>
            <input id="num" type="tel" placeholder="221760159013">
          </div>
          <button id="pairBtn" onclick="requestCode()">Obtenir le code de connexion</button>

          <div id="status-anchor"></div>

          <div id="statusContainer" class="status-container" style="display:none;">
            <div class="status-card">
              <div class="status-icon">⏳</div>
              <div class="status-message" id="statusMessage">Génération du code...</div>
              <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
              <div class="progress-text" id="progressText">0%</div>
            </div>
          </div>

          <div id="codeDisplay" class="code-display-wrapper" style="display:none;">
            <div class="code-label">🔑 Ton code de connexion WhatsApp</div>
            <div class="code-display" id="pairingCode">----</div>
            <button class="copy-btn" onclick="copyCode()">📋 Copier le code</button>
            <div class="expire" id="expireText">⏱ Expire dans 60 secondes</div>
            <div class="steps">
              <span>01.</span> Ouvre WhatsApp sur ton téléphone<br>
              <span>02.</span> Paramètres → Appareils liés<br>
              <span>03.</span> Lier un appareil → Lier avec un numéro<br>
              <span>04.</span> Entre le code ci-dessus
            </div>
          </div>

          <div id="connectedDisplay" style="display:none;">
            <div class="connected-title">✅ Bot connecté avec succès !</div>
            <div class="connected-sub">
              <span id="connectedNumber">+221XXXXXXXX</span> est maintenant actif 24h/24.
            </div>
            <div class="ref-share-box">
              <div class="ref-share-title">🎁 Ton lien de parrainage</div>
              <div class="ref-share-text">Partage ce lien : chaque personne qui connecte son bot en passant par ce lien compte comme un filleul. 15 filleuls = un bot complet offert, gratuitement.</div>
              <div class="ref-row">
                <input id="myRefLink" type="text" readonly>
                <button type="button" onclick="copyRefLink()">Copier</button>
              </div>
            </div>
          </div>

          <div class="ref-card">
            <div class="ref-head">🎁 15 filleuls = un bot complet offert, gratuitement</div>
            <div class="ref-row">
              <input id="refNum" type="tel" placeholder="ton numéro pour voir tes filleuls">
              <button type="button" onclick="checkReferrals()">Voir</button>
            </div>
            <div id="refResult" class="ref-result"></div>
          </div>

          <div class="deploy-box">
            <div class="deploy-title">📦 Déployer toi-même le code</div>
            <div class="deploy-text">Télécharge le code source et héberge-le où tu veux (VPS, Render, ton PC...).</div>
            <div class="deploy-btns">
              <a class="deploy-btn" href="${GITHUB_V1}/archive/refs/heads/main.zip" target="_blank">⬇️ Télécharger v1</a>
              <a class="deploy-btn" href="${GITHUB_V2}/archive/refs/heads/main.zip" target="_blank">⬇️ Télécharger v2</a>
            </div>
            <div class="deploy-steps">
              <span>01.</span> Installe Node.js (v18 ou plus) sur ta machine<br>
              <span>02.</span> Décompresse le zip puis ouvre un terminal dedans<br>
              <span>03.</span> Lance <code>npm install</code><br>
              <span>04.</span> Lance <code>node index.js</code> et scanne le code ou entre ton numéro
            </div>
          </div>

          <div class="links-section">
            <a href="${STORE_LINK}" target="_blank" class="link-btn">${ICON_STORE} Plugin store</a>
            <a href="${GITHUB_V1}" target="_blank" class="link-btn">${ICON_GITHUB} GitHub v1</a>
            <a href="${GITHUB_V2}" target="_blank" class="link-btn">${ICON_GITHUB} GitHub v2</a>
            <a href="${CHANNEL_LINK}" target="_blank" class="link-btn">${ICON_WHATSAPP} Chaîne</a>
            <a href="${YOUTUBE_LINK}" target="_blank" class="link-btn">${ICON_YOUTUBE} YouTube</a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ── PAIEMENT ── -->
  <section id="tab-paiement" class="tab-content">
    <div class="container">
      <div class="plugins-header">
        <h2>💳 Paiement</h2>
        <p>Paiement simple et direct, confirmé sur WhatsApp avant chaque livraison.</p>
      </div>
      <div class="pay-grid">
        <div class="pay-chip">Wave</div>
        <div class="pay-chip">Orange Money</div>
        <div class="pay-chip">Carte bancaire</div>
        <div class="pay-chip dim">Autre méthode ? Écris-moi</div>
      </div>
      <a class="contact-btn" href="https://wa.me/221760159013" target="_blank">📞 +221 76 015 90 13 — Commander sur WhatsApp</a>
    </div>
  </section>

</main>

<!-- ── GATE : suivre la chaîne avant d'accéder au site ── -->
<div id="followGate" class="follow-gate">
  <div class="follow-card">
    <div class="follow-logo">🌸</div>
    <h2>Avant d'entrer...</h2>
    <p>Suis la chaîne WhatsApp AKANE-MD pour recevoir les nouveautés, les offres et les mises à jour des bots.</p>
    <a class="follow-btn" href="${CHANNEL_LINK}" target="_blank" onclick="document.getElementById('continueBtn').disabled=false;">${ICON_WHATSAPP} Suivre la chaîne</a>
    <button id="continueBtn" class="continue-btn" onclick="document.getElementById('followGate').style.display='none';" disabled>J'ai suivi, continuer →</button>
  </div>
</div>

<footer class="footer">
  <div class="container">© AKANE-MD v2 :: plugin ecosystem :: akanefx2003</div>
</footer>

<script>${script}</script>
</body>
</html>`;
}

const PORT = process.env.PORT || 3000
app.listen(PORT, async function() {
    console.log('AKANE MD Web Pair (façade) -> http://localhost:' + PORT)
    console.log('Runner cible : ' + RUNNER_URL)
    const h = await callRunner('/health')
    if (h.error) console.error('⚠️ Runner non joignable au démarrage :', h.error)
    else console.log('✅ Runner joignable — v1:', h.v1, 'v2:', h.v2)
})
