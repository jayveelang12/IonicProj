# FitFlow — Ionic Angular + Capacitor

FitFlow is a dark-themed workout planner and interval timer starter project.

## Included
- Workout builder: add and remove exercises, set duration, reps and category
- Exercise countdown with pause, resume and skip
- Configurable rest interval between exercises
- Session progress and completion summary
- Local workout history and workout-plan persistence
- Always-visible, zoomable Leaflet map with on-demand GPS location, multiple map tile fallbacks, street/place name and distance from the previous reading
- Haptic feedback at workout phase changes
- Local notification when a workout finishes

## Requirements
- Node.js LTS (Node 20 or 22 recommended)
- npm
- Ionic CLI (`npm install -g @ionic/cli`)
- For Android APK builds: Android SDK / Android Studio build tools and a JDK supported by the installed Android Gradle Plugin

## Install and run in browser
Open this folder in VS Code, then run:

```bash
npm install
npm start
```

Browser preview supports the workout UI and timer. Native Android permission prompts, haptics and notifications work only in the installed Android app.
Location lookup works in the browser on secure origins (HTTPS or localhost) and in the installed Android app after location access is allowed.

## Add Android
Run these commands once:

```bash
npm install
npx cap add android
npm run android:setup
```

The setup script adds `POST_NOTIFICATIONS`, coarse/fine location and `VIBRATE` to `AndroidManifest.xml`.

Then build and sync:

```bash
npm run build:android
npx cap open android
```

Build and install the APK from your Android build environment.

## Permission behavior
- Notifications: Android 13+ asks for `POST_NOTIFICATIONS` at runtime through the official Capacitor Local Notifications plugin. Older Android versions do not show the same runtime prompt.
- Location: A zoomable Leaflet map opens immediately, centered on the last saved area or Manila by default. GPS access is requested only when the user taps **Get my location**; that recenters the map and shows a reverse-geocoded street/place name plus straight-line distance from the previous reading. It stores only the last point locally for that distance calculation. If standard OpenStreetMap tiles fail, it retries with HOT and OSM Germany tile services.
- Vibration: `VIBRATE` is a normal Android permission, not a runtime prompt. FitFlow uses Capacitor Haptics and gracefully handles unsupported devices.
- Users can deny permissions and still use the workout builder and timer.

## Important behavior notes
- Repetitions are targets shown in the UI; the app does not automatically count reps.
- Workout countdown is accurate while the app is active. Mobile operating systems may throttle JavaScript timers when an app is backgrounded or the screen is locked. This starter does not claim to provide a guaranteed background workout timer.
- Completion notifications are local device notifications, not remote push notifications.
- Data is stored locally in browser/device WebView storage. It is not synced to an account or cloud.
- Location coordinates are sent to [Photon](https://github.com/komoot/photon) for a nearby street/place name. The map uses [OpenStreetMap tiles](https://operations.osmfoundation.org/policies/tiles/) and displays required attribution. Public service availability and rate limits apply.

## App identity
- App name: FitFlow
- Android application ID: `com.fitflow.app`
