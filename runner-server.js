// runner-server.js — AKANE MD v1 + v2 : le "backend" réel, à déployer sur Téo Héberg
// (ou tout hébergement qui garde un process Node vivant en continu, avec disque
// persistant). C'est ICI que tournent les bots pour de vrai, 24/7. Le site sur Render
// (webpair.js) n'est qu'une façade qui relaie ses requêtes vers cette API.
import express from 'express'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { REPO_CONFIG, repoReady, prepareRepos } from './repoManager.js'

const app = express()
app.use(express.json())

// ── Sécurité : seule webpair.js (le front sur Render) doit pouvoir appeler cette API.
// Sans ça, n'importe qui trouvant l'URL du runner pourrait faire tourner des bots à ta
// place. Définis la MÊME valeur pour RUNNER_KEY sur Téo Héberg et sur Render.
const RUNNER_KEY = process.env.RUNNER_KEY || ''
if (!RUNNER_KEY) {
    console.error('❌ RUNNER_KEY manquante — définis cette variable d\'env sur Téo Héberg avant de démarrer.')
    process.exit(1)
}
function requireRunnerKey(req, res, next) {
    if (req.get('x-runner-key') !== RUNNER_KEY) return res.status(401).json({ error: 'Clé runner invalide' })
    next()
}

// v1 + v2 en même temps demandent plus de RAM/disque que v2 seul (sharp +
// ffmpeg-static de v1 sont lourds à installer). Si le plan Téo Héberg est
// trop petit et que npm install de v1 plante ou que le serveur redémarre en
// boucle par manque de mémoire, repasse ça à false le temps de monter en
// gamme sur l'hébergement.
const V1_ENABLED = true

const pendingCodes  = new Map() // "version:number" -> { status, code, error }
const activeBots    = new Map() // "version:number" -> { child, version, connected, restartCount }
const intentionalStops = new WeakSet()
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
    if (!V1_ENABLED) return
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

    const entry = { child, version, connected: false, restartCount: 0 }
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
        if (intentionalStops.has(child)) {
            pendingCodes.set(key, { status: 'idle', code: null, error: null })
            return
        }

        if (entry.connected) {
            // Un bot connecté doit rester disponible 24/7 : on garde sa session
            // et on le relance automatiquement après un arrêt inattendu.
            pendingCodes.set(key, { status: 'restarting', code: null, error: 'Redémarrage automatique du bot...' })
            const delay = Math.min(5000 * Math.max(1, entry.restartCount + 1), 60000)
            console.log(`🔁 Relance automatique de +${number} (${version}) dans ${Math.round(delay / 1000)}s`)
            setTimeout(() => {
                try {
                    const restored = spawnBot(number, version, true)
                    restored.restartCount = entry.restartCount + 1
                    console.log(`✅ Bot +${number} (${version}) relancé, session conservée`)
                } catch (e) {
                    console.error(`❌ Relance impossible pour +${number} (${version}):`, e.message)
                    pendingCodes.set(key, { status: 'error', code: null, error: `Relance impossible : ${e.message}` })
                }
            }, delay)
        } else {
            pendingCodes.set(key, { status: 'error', code: null, error: `Le bot s'est arrêté au démarrage (code ${code}). Regarde les logs serveur.` })
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

// ── Routes API (appelées par webpair.js sur Render, jamais directement par le navigateur) ──

app.post('/pair', requireRunnerKey, async function(req, res) {
    const number = req.body.number
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    if (!number || number.replace(/[^0-9]/g, '').length < 7) return res.json({ error: 'Numero invalide' })
    const clean = number.replace(/[^0-9]/g, '')

    if (version === 'v1') {
        if (!V1_ENABLED) return res.json({ error: 'La version v1 est temporairement désactivée sur ce serveur (ressources limitées). Utilise v2.' })
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

app.post('/disconnect', requireRunnerKey, async function(req, res) {
    const number = (req.body.number || '').replace(/[^0-9]/g, '')
    const version = req.body.version === 'v1' ? 'v1' : 'v2'
    if (!number) return res.json({ error: 'Numero invalide' })

    if (version === 'v1') {
        return res.json({ error: 'Déconnexion v1 non disponible pour le moment — redéploie le bot pour libérer ce numéro.' })
    }

    const key = botKey(number, version)
    const entry = activeBots.get(key)
    if (!entry) return res.json({ ok: true, note: 'Aucun process actif pour ce numéro/version côté serveur' })
    intentionalStops.add(entry.child)
    try { entry.child.kill('SIGKILL') } catch (e) {}
    activeBots.delete(key)
    removeSession(number)
    pendingCodes.set(key, { status: 'error', code: null, error: 'Déconnecté manuellement' })
    res.json({ ok: true })
})

app.get('/code/:number', requireRunnerKey, async function(req, res) {
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

app.get('/stats', requireRunnerKey, async function(req, res) {
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

// Pas de clé requise sur /health et /ping : c'est ce que le panneau Téo Héberg (ou toi)
// utilise pour vérifier que le runner est vivant, sans passer par Render.
app.get('/ping',  function(req, res) { res.send('pong') })
app.get('/health',function(req, res) {
    res.set('Cache-Control', 'no-store')
    res.json({ status: 'ok', uptime: process.uptime(), connected: getConnectedCount(), bots: activeBots.size, v1: v1Ready, v2: repoReady.v2 })
})

setInterval(function() { console.log('keep-alive') }, 4 * 60 * 1000)

const PORT = process.env.PORT || 4000
const server = app.listen(PORT, function() {
    console.log('AKANE MD Runner -> http://localhost:' + PORT)
    prepareRepos()
    restoreSessions().catch(e => console.error('Erreur restoreSessions:', e.message))
    watchV1Ready()
})

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Le port ${PORT} est déjà utilisé par un autre process — le runner ne peut pas démarrer. Redémarre complètement le service.`)
    } else {
        console.error('❌ Erreur du serveur runner :', err.message)
    }
    process.exit(1)
})
