import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform, arch, release } from 'node:os';
import chalk from 'chalk';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major >= 20) {
    results.push({ name: 'Node.js', status: 'ok', message: `${nodeVersion} ✓` });
  } else {
    results.push({
      name: 'Node.js',
      status: 'fail',
      message: `${nodeVersion} (requires >= 20)`,
      fix: 'Install Node.js 20+ from https://nodejs.org/',
    });
  }

  // 2. Platform info
  const os = platform();
  const archInfo = arch();
  results.push({
    name: 'Platform',
    status: 'ok',
    message: `${os} ${archInfo} (${release()})`,
  });

  // 3. Chrome detection
  const chromePath = findChromePath();
  if (chromePath) {
    let versionInfo = '';
    try {
      versionInfo = ' — ' + execSync(`"${chromePath}" --version`, { encoding: 'utf-8' }).trim();
    } catch {
      // Version detection failed, but Chrome exists
    }
    results.push({ name: 'Browser', status: 'ok', message: `Found at ${chromePath}${versionInfo}` });
  } else {
    results.push({
      name: 'Browser',
      status: 'fail',
      message: 'No Chromium-based browser found (Chrome, Thorium, Brave, Chromium, Edge, Vivaldi)',
      fix: os === 'win32'
        ? 'Install from https://www.google.com/chrome/ or https://thorium.rocks/'
        : os === 'darwin'
          ? 'Install: brew install --cask google-chrome  OR  brew install --cask brave-browser'
          : 'Install a Chromium-based browser, e.g.: google-chrome, thorium-browser, chromium, brave',
    });
  }

  // 4. Playwright-core — check via dynamic import
  try {
    await import('playwright-core');
    results.push({ name: 'playwright-core', status: 'ok', message: 'Installed ✓' });
  } catch {
    results.push({
      name: 'playwright-core',
      status: 'fail',
      message: 'Not installed',
      fix: 'Run: npm install playwright-core',
    });
  }

  // 5. Port availability
  results.push({ name: 'Default Port', status: 'ok', message: '3456 (will auto-find if busy)' });

  // 6. Data directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const stateDir = `${homeDir}/.webmodel`;
  results.push({
    name: 'Data Directory',
    status: 'ok',
    message: stateDir,
  });

  return results;
}

export function printDoctorResults(results: CheckResult[]): void {
  console.log('');
  console.log(chalk.bold('  web-model-bridge doctor'));
  console.log(chalk.gray('  ─────────────────────────'));
  console.log('');

  let hasFailure = false;
  for (const r of results) {
    const icon = r.status === 'ok' ? chalk.green('✓')
      : r.status === 'warn' ? chalk.yellow('⚠')
      : chalk.red('✗');
    console.log(`  ${icon} ${chalk.bold(r.name)}: ${r.message}`);
    if (r.fix) {
      console.log(chalk.gray(`    Fix: ${r.fix}`));
      hasFailure = true;
    }
  }

  console.log('');
  if (hasFailure) {
    console.log(chalk.yellow('  Some issues found. Fix them and try again.'));
  } else {
    console.log(chalk.green('  All checks passed! Ready to run.'));
  }
  console.log('');
}

export function findChromePath(): string | undefined {
  const os = platform();

  if (os === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Thorium.app/Contents/MacOS/Thorium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      `${process.env.HOME}/Applications/Thorium.app/Contents/MacOS/Thorium`,
      `${process.env.HOME}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
  }

  if (os === 'linux') {
    const user = process.env.USER || 'youssef';
    const home = process.env.HOME || `/home/${user}`;

    const candidates = [
      'google-chrome', 'google-chrome-stable',
      'thorium-browser', 'thorium',
      'chromium', 'chromium-browser',
      'brave-browser', 'brave',
      'microsoft-edge', 'microsoft-edge-stable',
      'vivaldi', 'vivaldi-stable',
      'ungoogled-chromium',
    ];

    const paths = [
      // Standard distro bins
      ...candidates.map(c => `/usr/bin/${c}`),
      '/snap/bin/chromium',
      // Nix/NixOS user & system profiles
      ...candidates.map(c => `${home}/.nix-profile/bin/${c}`),
      ...candidates.map(c => `/etc/profiles/per-user/${user}/bin/${c}`),
      ...candidates.map(c => `/run/current-system/sw/bin/${c}`),
    ];

    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    // Try which — covers NixOS and other distros with non-standard PATH-based installs
    for (const bin of candidates) {
      try {
        const p = execSync(`which ${bin}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        if (p) return p;
      } catch {
        // not found, try next
      }
    }
  }

  if (os === 'win32') {
    const paths = [
      `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES']}\\Chromium\\Application\\chrome.exe`,
    ];
    for (const p of paths) {
      if (p && existsSync(p)) return p;
    }
  }

  return undefined;
}
