// prepare-repos.js — à lancer pendant le BUILD (pas au runtime)
// Objectif : que repos/v1 et repos/v2 soient déjà clonés + installés avant que
// Render marque le service "live", pour ne plus jamais afficher "en préparation".
import { prepareRepos, repoReady } from './repoManager.js'

console.log('🚀 Préparation des repos v1/v2 pendant le build...')
await prepareRepos()
console.log('📋 État final :', repoReady)

if (!repoReady.v1 || !repoReady.v2) {
    console.error('❌ Un des repos n\'a pas pu être préparé — le build est marqué en échec pour éviter un déploiement cassé.')
    process.exit(1)
}

console.log('✅ v1 et v2 sont prêts, le build peut continuer.')
process.exit(0)
