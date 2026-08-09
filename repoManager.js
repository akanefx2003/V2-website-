// repoManager.js — clonage/installation des repos AKANE v1 et v2
// Utilisé à la fois par le script de build (prepare-repos.js) et par webpair.js au runtime.
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const GITHUB_V1 = 'https://github.com/akanefx2003/AKANE_MD'
const GITHUB_V2 = 'https://github.com/akanefx2003/AKANE-MD-V2.git'

export const REPOS_DIR = './repos'
export const REPO_CONFIG = {
    v1: { url: GITHUB_V1 + '.git', dir: path.join(REPOS_DIR, 'v1') },
    v2: { url: GITHUB_V2,          dir: path.join(REPOS_DIR, 'v2') }
}
export const repoReady = { v1: false, v2: false } // true seulement une fois clone + install terminés
export const repoCommit = { v1: null, v2: null }  // hash court du commit actuellement checkouté, pour vérifier ce qui tourne vraiment

// Exécute une commande et renvoie sa sortie stdout (utilisé pour lire le hash de commit)
function runCmdCapture(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, opts)
        let out = ''
        child.stdout?.on('data', d => { out += d })
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} a échoué (code ${code})`)))
        child.on('error', reject)
    })
}

// Exécute une commande avec logs en direct + timeout strict (tue le process s'il dépasse le délai)
function runCmd(cmd, args, opts = {}, timeoutMs = 5 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, opts)
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            try { child.kill('SIGKILL') } catch (e) {}
        }, timeoutMs)

        child.stdout?.on('data', d => process.stdout.write(`[${cmd}] ${d}`))
        child.stderr?.on('data', d => process.stderr.write(`[${cmd}] ${d}`))

        child.on('close', code => {
            clearTimeout(timer)
            if (timedOut) return reject(new Error(`${cmd} a dépassé ${Math.round(timeoutMs / 1000)}s, process tué`))
            if (code !== 0) return reject(new Error(`${cmd} a échoué (code ${code})`))
            resolve()
        })
        child.on('error', err => { clearTimeout(timer); reject(err) })
    })
}

export async function cloneOrUpdateRepo(key) {
    const { url, dir } = REPO_CONFIG[key]
    try {
        if (!fs.existsSync(dir)) {
            console.log(`📥 Clonage du repo ${key} (${url})...`)
            fs.mkdirSync(REPOS_DIR, { recursive: true })
            await runCmd('git', ['clone', '--depth', '1', url, dir], {}, 3 * 60 * 1000)
        } else {
            console.log(`🔄 Mise à jour du repo ${key}...`)
            try { await runCmd('git', ['-C', dir, 'pull', '--ff-only'], {}, 60 * 1000) }
            catch (e) { console.error(`⚠️ Pull échoué pour ${key}, on garde la version locale existante:`, e.message) }
        }
        if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
            const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'))
            console.log(`📦 Installation des dépendances du repo ${key} (${hasLock ? 'npm ci' : 'npm install'})...`)
            const installArgs = hasLock
                ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
                : ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline']
            await runCmd('npm', installArgs, { cwd: dir }, 10 * 60 * 1000)
        }
        repoReady[key] = true
        try { repoCommit[key] = await runCmdCapture('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']) } catch (e) { repoCommit[key] = 'inconnu' }
        console.log(`✅ Repo ${key} prêt (commit ${repoCommit[key]})`)
    } catch (e) {
        console.error(`❌ Erreur clonage/maj du repo ${key}:`, e.message)
    }
}

// Prépare v1 et v2 en parallèle (un blocage sur l'un n'empêche pas l'autre)
export async function prepareRepos() {
    await Promise.all(Object.keys(REPO_CONFIG).map(key => cloneOrUpdateRepo(key)))
}
