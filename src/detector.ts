import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Framework =
  | 'vite'
  | 'next'
  | 'cra'
  | 'vue'
  | 'angular'
  | 'express'
  | 'static'
  | 'expo'
  | 'flutter'
  | 'unknown';

export interface DetectionResult {
  framework: Framework;
  command: string;
  buildCommand?: string;
  isMobile: boolean;
  portHint?: number;
}

export function detectFramework(projectPath: string): DetectionResult {
  const pkgPath = join(projectPath, 'package.json');
  let pkg: any = null;
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      // ignore
    }
  }

  // Flutter
  const pubspec = join(projectPath, 'pubspec.yaml');
  if (existsSync(pubspec)) {
    const content = readFileSync(pubspec, 'utf-8');
    if (content.includes('flutter:')) {
      return {
        framework: 'flutter',
        command: 'flutter run -d web-server --web-port 8080',
        isMobile: true,
        portHint: 8080,
      };
    }
  }

  // Expo / React Native
  const appJson = join(projectPath, 'app.json');
  if (existsSync(appJson) || (pkg && (pkg.dependencies?.expo || pkg.devDependencies?.expo))) {
    let hasExpo = false;
    if (existsSync(appJson)) {
      try {
        const aj = JSON.parse(readFileSync(appJson, 'utf-8'));
        if (aj.expo) hasExpo = true;
      } catch {}
    }
    if (hasExpo || pkg?.dependencies?.expo || pkg?.devDependencies?.expo) {
      return {
        framework: 'expo',
        command: 'npx expo start --web',
        isMobile: true,
        portHint: 8081,
      };
    }
  }

  // Vite
  if (
    existsSync(join(projectPath, 'vite.config.js')) ||
    existsSync(join(projectPath, 'vite.config.ts')) ||
    existsSync(join(projectPath, 'vite.config.mjs'))
  ) {
    return { framework: 'vite', command: 'npm run dev', isMobile: false, portHint: 5173 };
  }

  // Next.js
  if (
    existsSync(join(projectPath, 'next.config.js')) ||
    existsSync(join(projectPath, 'next.config.ts')) ||
    existsSync(join(projectPath, 'next.config.mjs')) ||
    existsSync(join(projectPath, 'pages')) ||
    existsSync(join(projectPath, 'app'))
  ) {
    if (pkg?.dependencies?.next || pkg?.devDependencies?.next) {
      return { framework: 'next', command: 'npm run dev', isMobile: false, portHint: 3000 };
    }
  }

  // CRA
  if (pkg?.dependencies?.['react-scripts'] || pkg?.devDependencies?.['react-scripts']) {
    return { framework: 'cra', command: 'npm start', isMobile: false, portHint: 3000 };
  }

  // Vue
  if (existsSync(join(projectPath, 'vue.config.js')) || existsSync(join(projectPath, 'vue.config.ts'))) {
    return { framework: 'vue', command: 'npm run serve', isMobile: false, portHint: 8080 };
  }

  // Angular
  if (existsSync(join(projectPath, 'angular.json'))) {
    return { framework: 'angular', command: 'ng serve', isMobile: false, portHint: 4200 };
  }

  // Express / Node
  if (
    existsSync(join(projectPath, 'server.js')) ||
    existsSync(join(projectPath, 'app.js')) ||
    existsSync(join(projectPath, 'index.js'))
  ) {
    if (pkg?.dependencies?.express || existsSync(join(projectPath, 'server.js'))) {
      return { framework: 'express', command: 'node server.js', isMobile: false, portHint: 3000 };
    }
  }

  // Static
  if (existsSync(join(projectPath, 'index.html'))) {
    return { framework: 'static', command: 'npx serve . -p 5000', isMobile: false, portHint: 5000 };
  }

  // Fallback from package.json scripts
  if (pkg?.scripts) {
    if (pkg.scripts.dev) return { framework: 'unknown', command: 'npm run dev', isMobile: false };
    if (pkg.scripts.start) return { framework: 'unknown', command: 'npm start', isMobile: false };
  }

  return {
    framework: 'unknown',
    command: '',
    isMobile: false,
  };
}
