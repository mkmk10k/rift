const { notarize } = require('@electron/notarize');
const path = require('path');

// Load .env if not already set (for local builds)
if (!process.env.APPLE_ID) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

// afterAllArtifactBuild — runs after DMG/ZIP are fully built
// Notarizes and staples each DMG artifact so Gatekeeper works offline too
exports.default = async function notarizeArtifacts(buildResult) {
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword) {
    console.warn('⚠️  Skipping notarization: APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set');
    return;
  }

  const artifacts = Array.isArray(buildResult) ? buildResult : (buildResult.artifactPaths || []);
  const dmgs = artifacts.filter(f => f.endsWith('.dmg'));
  for (const dmgPath of dmgs) {
    console.log(`\n🔏 Notarizing ${path.basename(dmgPath)}...`);
    await notarize({ appPath: dmgPath, appleId, appleIdPassword, teamId });
    console.log(`✅ Notarized + stapled ${path.basename(dmgPath)}`);
  }
};
