#!/usr/bin/env node
/**
 * Post-build verification script for Rift Electron app
 * Verifies that the packaged app has all required files and correct paths.
 * 
 * CRITICAL: Python bundle checks are ERRORS (not warnings).
 * A missing or incomplete Python bundle means the app will not work.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PACKAGE_DIR = path.join(__dirname, '../dist-package/mac-arm64/Rift.app/Contents/Resources');
const ASAR_PATH = path.join(PACKAGE_DIR, 'app.asar');
const EXTRACT_DIR = '/tmp/rift-verify';

/** Some wheels ship a single .py module (e.g. soundfile.py) instead of a package dir. */
function sitePackageExists(sitePackagesDir, name) {
  return (
    fs.existsSync(path.join(sitePackagesDir, name)) ||
    fs.existsSync(path.join(sitePackagesDir, `${name}.py`))
  );
}

console.log('Rift Build Verification\n');

// Check if asar exists
if (!fs.existsSync(ASAR_PATH)) {
  console.error('FAIL: app.asar not found at', ASAR_PATH);
  console.error('   Run "bun run package" first');
  process.exit(1);
}

// Extract asar
console.log('Extracting asar...');
try {
  execSync(`rm -rf ${EXTRACT_DIR}`);
  execSync(`npx asar extract "${ASAR_PATH}" "${EXTRACT_DIR}"`, { stdio: 'pipe' });
} catch (e) {
  console.error('FAIL: Could not extract asar');
  process.exit(1);
}

let errors = [];
let warnings = [];

// Test 1: Check package.json main entry
console.log('\nChecking package.json...');
const pkgJson = JSON.parse(fs.readFileSync(path.join(EXTRACT_DIR, 'package.json'), 'utf8'));
const mainPath = path.join(EXTRACT_DIR, pkgJson.main);
if (fs.existsSync(mainPath)) {
  console.log(`   OK main: ${pkgJson.main} exists`);
} else {
  errors.push(`main entry "${pkgJson.main}" does not exist`);
  console.log(`   FAIL main: ${pkgJson.main} NOT FOUND`);
}

// Test 2: Check renderer files
console.log('\nChecking renderer...');
const indexHtml = path.join(EXTRACT_DIR, 'dist/renderer/index.html');
if (fs.existsSync(indexHtml)) {
  console.log('   OK index.html exists');
  
  const htmlContent = fs.readFileSync(indexHtml, 'utf8');
  const jsMatch = htmlContent.match(/src="([^"]+\.js)"/);
  const cssMatch = htmlContent.match(/href="([^"]+\.css)"/);
  
  if (jsMatch) {
    const jsPath = jsMatch[1];
    if (jsPath.startsWith('./')) {
      console.log(`   OK JS path is relative: ${jsPath}`);
      const fullJsPath = path.join(EXTRACT_DIR, 'dist/renderer', jsPath);
      if (fs.existsSync(fullJsPath)) {
        console.log(`   OK JS file exists`);
      } else {
        errors.push(`JS file not found: ${jsPath}`);
        console.log(`   FAIL JS file NOT FOUND: ${fullJsPath}`);
      }
    } else {
      errors.push(`JS path is absolute: ${jsPath} (should start with ./)`);
      console.log(`   FAIL JS path is ABSOLUTE: ${jsPath}`);
    }
  }
  
  if (cssMatch) {
    const cssPath = cssMatch[1];
    if (cssPath.startsWith('./')) {
      console.log(`   OK CSS path is relative: ${cssPath}`);
      const fullCssPath = path.join(EXTRACT_DIR, 'dist/renderer', cssPath);
      if (fs.existsSync(fullCssPath)) {
        console.log(`   OK CSS file exists`);
      } else {
        errors.push(`CSS file not found: ${cssPath}`);
        console.log(`   FAIL CSS file NOT FOUND: ${fullCssPath}`);
      }
    } else {
      errors.push(`CSS path is absolute: ${cssPath} (should start with ./)`);
      console.log(`   FAIL CSS path is ABSOLUTE: ${cssPath}`);
    }
  }
} else {
  errors.push('index.html not found');
  console.log('   FAIL index.html NOT FOUND');
}

// Test 3: Check preload script
console.log('\nChecking preload...');
const preloadPaths = [
  'dist/preload/preload/index.js',
  'dist/preload/index.js',
];
let preloadFound = false;
for (const p of preloadPaths) {
  const fullPath = path.join(EXTRACT_DIR, p);
  if (fs.existsSync(fullPath)) {
    console.log(`   OK preload found at: ${p}`);
    preloadFound = true;
    break;
  }
}
if (!preloadFound) {
  errors.push('preload script not found');
  console.log('   FAIL preload NOT FOUND at any expected path');
}

// Test 4: Check Python bundle (CRITICAL - these are ERRORS, not warnings)
console.log('\nChecking Python bundle (CRITICAL)...');
const pythonDir = path.join(PACKAGE_DIR, 'python');

if (!fs.existsSync(pythonDir)) {
  errors.push('Python directory not found in resources - app will not work');
  console.log('   FAIL Python directory not found');
  console.log('   --> Run "bun run bundle:python" before packaging');
} else {
  // Check interpreter binary
  const interpreterPath = path.join(pythonDir, 'bin', 'python3.11');
  if (fs.existsSync(interpreterPath)) {
    console.log('   OK python3.11 interpreter exists');
    
    // Verify it's executable and ARM64
    try {
      const fileInfo = execSync(`file "${interpreterPath}"`).toString();
      if (fileInfo.includes('arm64')) {
        console.log('   OK interpreter is ARM64');
      } else {
        errors.push('Python interpreter is not ARM64 - MLX requires Apple Silicon');
        console.log('   FAIL interpreter is NOT ARM64:', fileInfo.trim());
      }
    } catch {
      warnings.push('Could not verify interpreter architecture');
    }
  } else {
    errors.push('python3.11 interpreter not found - python-bundle was not included');
    console.log('   FAIL python3.11 NOT FOUND at', interpreterPath);
    console.log('   --> Run "bun run bundle:python" before packaging');
  }

  // Check critical site-packages
  const sitePackagesDir = path.join(pythonDir, 'lib', 'python3.11', 'site-packages');
  const criticalPackages = [
    { dir: 'mlx', label: 'MLX (core ML framework)' },
    { dir: 'mlx_lm', label: 'MLX-LM (language models)' },
    { dir: 'parakeet_mlx', label: 'Parakeet MLX (speech-to-text)' },
    { dir: 'mlx_audio', label: 'MLX Audio (text-to-speech / Kokoro)' },
    { dir: 'huggingface_hub', label: 'HuggingFace Hub (model downloads)' },
    { dir: 'soundfile', label: 'SoundFile (audio I/O)' },
    { dir: 'numpy', label: 'NumPy (numerical)' },
  ];

  if (fs.existsSync(sitePackagesDir)) {
    for (const pkg of criticalPackages) {
      if (sitePackageExists(sitePackagesDir, pkg.dir)) {
        console.log(`   OK ${pkg.label}`);
      } else {
        errors.push(`Missing package: ${pkg.label} - not in site-packages`);
        console.log(`   FAIL ${pkg.label} NOT FOUND`);
      }
    }
  } else {
    errors.push('site-packages directory not found - python-bundle is incomplete');
    console.log('   FAIL site-packages NOT FOUND at', sitePackagesDir);
  }

  // Check Python server scripts
  const serverScripts = ['tts_server.py', 'stt_server.py', 'llm_server.py', 'download_models.py'];
  for (const script of serverScripts) {
    const scriptPath = path.join(pythonDir, script);
    if (fs.existsSync(scriptPath)) {
      console.log(`   OK ${script}`);
    } else {
      errors.push(`Missing server script: ${script}`);
      console.log(`   FAIL ${script} NOT FOUND`);
    }
  }
}

// Test 5: Check setup files
console.log('\nChecking setup resources...');
const setupDir = path.join(PACKAGE_DIR, 'setup');
if (fs.existsSync(setupDir)) {
  const setupHtml = path.join(setupDir, 'setup.html');
  if (fs.existsSync(setupHtml)) {
    console.log('   OK setup.html exists');
  } else {
    warnings.push('setup.html not found');
    console.log('   WARN setup.html not found');
  }
} else {
  warnings.push('Setup directory not found');
  console.log('   WARN Setup directory not found');
}

// Summary
console.log('\n' + '='.repeat(50));
if (errors.length === 0) {
  console.log('BUILD VERIFICATION PASSED\n');
  if (warnings.length > 0) {
    console.log(`${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  console.log('\nThe packaged app should work correctly.');
  process.exit(0);
} else {
  console.log('BUILD VERIFICATION FAILED\n');
  console.log(`${errors.length} error(s):`);
  errors.forEach(e => console.log(`   - ${e}`));
  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
  }
  console.log('\nFix the errors above before distributing.');
  process.exit(1);
}
