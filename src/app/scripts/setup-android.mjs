import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve('android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error('Android platform not found. Run: npx cap add android');
  process.exit(1);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.VIBRATE'
];

for (const permission of permissions) {
  const tag = `<uses-permission android:name="${permission}" />`;
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(/<manifest\b[^>]*>/, match => `${match}\n    ${tag}`);
  }
}

fs.writeFileSync(manifestPath, manifest);
console.log('Added notification, coarse/fine location and vibration permissions to AndroidManifest.xml.');
console.log('Next run: npm run build:android');
