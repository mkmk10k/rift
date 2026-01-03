#!/usr/bin/env node
/**
 * Post-build verification script for Rift Electron app
 * Verifies that the packaged app has all required files and correct paths
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PACKAGE_DIR = path.join(__dirname, '../dist-package/mac-arm64/Rift.app/Contents/Resources');
const ASAR_PATH = path.join(PACKAGE_DIR, 'app.asar');
const EXTRACT_DIR = '/tmp/rift-verify';

console.log('🔍 Rift Build Verification\n');

// Check if asar exists
if (!fs.existsSync(ASAR_PATH)) {
  console.error('❌ FAIL: app.asar not found at', ASAR_PATH);
  console.error('   Run "bun run package" first');
  process.exit(1);
}

// Extract asar
console.log('📦 Extracting asar...');
try {
  execSync(`rm -rf ${EXTRACT_DIR}`);
  execSync(`npx asar extract "${ASAR_PATH}" "${EXTRACT_DIR}"`, { stdio: 'pipe' });
} catch (e) {
  console.error('❌ FAIL: Could not extract asar');
  process.exit(1);
}

let errors = [];
let warnings = [];

// Test 1: Check package.json main entry
console.log('\n📋 Checking package.json...');
const pkgJson = JSON.parse(fs.readFileSync(path.join(EXTRACT_DIR, 'package.json'), 'utf8'));
const mainPath = path.join(EXTRACT_DIR, pkgJson.main);
if (fs.existsSync(mainPath)) {
  console.log(`   ✅ main: ${pkgJson.main} exists`);
} else {
  errors.push(`main entry "${pkgJson.main}" does not exist`);
  console.log(`   ❌ main: ${pkgJson.main} NOT FOUND`);
}

// Test 2: Check renderer files
console.log('\n🎨 Checking renderer...');
const indexHtml = path.join(EXTRACT_DIR, 'dist/renderer/index.html');
if (fs.existsSync(indexHtml)) {
  console.log('   ✅ index.html exists');
  
  // Check for relative paths
  const htmlContent = fs.readFileSync(indexHtml, 'utf8');
  const jsMatch = htmlContent.match(/src="([^"]+\.js)"/);
  const cssMatch = htmlContent.match(/href="([^"]+\.css)"/);
  
  if (jsMatch) {
    const jsPath = jsMatch[1];
    if (jsPath.startsWith('./')) {
      console.log(`   ✅ JS path is relative: ${jsPath}`);
      // Verify the file exists
      const fullJsPath = path.join(EXTRACT_DIR, 'dist/renderer', jsPath);
      if (fs.existsSync(fullJsPath)) {
        console.log(`   ✅ JS file exists`);
      } else {
        errors.push(`JS file not found: ${jsPath}`);
        console.log(`   ❌ JS file NOT FOUND: ${fullJsPath}`);
      }
    } else {
      errors.push(`JS path is absolute: ${jsPath} (should start with ./)`);
      console.log(`   ❌ JS path is ABSOLUTE: ${jsPath}`);
    }
  }
  
  if (cssMatch) {
    const cssPath = cssMatch[1];
    if (cssPath.startsWith('./')) {
      console.log(`   ✅ CSS path is relative: ${cssPath}`);
      const fullCssPath = path.join(EXTRACT_DIR, 'dist/renderer', cssPath);
      if (fs.existsSync(fullCssPath)) {
        console.log(`   ✅ CSS file exists`);
      } else {
        errors.push(`CSS file not found: ${cssPath}`);
        console.log(`   ❌ CSS file NOT FOUND: ${fullCssPath}`);
      }
    } else {
      errors.push(`CSS path is absolute: ${cssPath} (should start with ./)`);
      console.log(`   ❌ CSS path is ABSOLUTE: ${cssPath}`);
    }
  }
} else {
  errors.push('index.html not found');
  console.log('   ❌ index.html NOT FOUND');
}

// Test 3: Check preload script
console.log('\n🔌 Checking preload...');
// The preload is at dist/preload/preload/index.js due to tsconfig structure
const preloadPaths = [
  'dist/preload/preload/index.js',  // Current structure (double-nested)
  'dist/preload/index.js',           // Ideal structure (flat)
];
let preloadFound = false;
for (const p of preloadPaths) {
  const fullPath = path.join(EXTRACT_DIR, p);
  if (fs.existsSync(fullPath)) {
    console.log(`   ✅ preload found at: ${p}`);
    preloadFound = true;
    break;
  }
}
if (!preloadFound) {
  errors.push('preload script not found');
  console.log('   ❌ preload NOT FOUND at any expected path');
}

// Test 4: Check Python files
console.log('\n🐍 Checking Python resources...');
const pythonDir = path.join(PACKAGE_DIR, 'python');
if (fs.existsSync(pythonDir)) {
  const ttsServer = path.join(pythonDir, 'tts_server.py');
  const sttServer = path.join(pythonDir, 'stt_server.py');
  
  if (fs.existsSync(ttsServer)) {
    console.log('   ✅ tts_server.py exists');
  } else {
    warnings.push('tts_server.py not found in resources');
    console.log('   ⚠️  tts_server.py not found');
  }
  
  if (fs.existsSync(sttServer)) {
    console.log('   ✅ stt_server.py exists');
  } else {
    warnings.push('stt_server.py not found in resources');
    console.log('   ⚠️  stt_server.py not found');
  }
} else {
  warnings.push('Python directory not found in resources');
  console.log('   ⚠️  Python directory not found');
}

// Summary
console.log('\n' + '='.repeat(50));
if (errors.length === 0) {
  console.log('✅ BUILD VERIFICATION PASSED\n');
  if (warnings.length > 0) {
    console.log(`⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  console.log('\nThe packaged app should work correctly.');
  process.exit(0);
} else {
  console.log('❌ BUILD VERIFICATION FAILED\n');
  console.log(`${errors.length} error(s):`);
  errors.forEach(e => console.log(`   - ${e}`));
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  process.exit(1);
}


