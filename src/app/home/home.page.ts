
import { CommonModule, DatePipe } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertController,
  IonicModule,
  Platform,
  ToastController
} from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Geolocation, Position } from '@capacitor/geolocation';
import { Subscription } from 'rxjs';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

interface Exercise {
  id: number;
  name: string;
  duration: number;
  reps: number;
  sets: number;
  category: string;
}

interface WorkoutRecord {
  id: number;
  date: string;
  durationMinutes: number;
  exerciseCount: number;
  workoutName: string;
}

type Phase = 'ready' | 'work' | 'rest' | 'done';
type RestTarget = 'set' | 'exercise';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, DatePipe],
  templateUrl: './home.page.html',
  styleUrls: ['./home.page.scss']
})
export class HomePage implements OnInit, AfterViewInit, OnDestroy {
  tab: 'home' | 'timer' | 'history' = 'home';

  phase: Phase = 'ready';
  paused = false;

  exercises: Exercise[] = [
    { id: 1, name: 'Jumping Jacks', duration: 30, reps: 20, sets: 3, category: 'Cardio' },
    { id: 2, name: 'Push-ups', duration: 45, reps: 15, sets: 3, category: 'Strength' },
    { id: 3, name: 'Bodyweight Squats', duration: 45, reps: 20, sets: 3, category: 'Strength' },
    { id: 4, name: 'Plank', duration: 45, reps: 1, sets: 3, category: 'Core' }
  ];

  history: WorkoutRecord[] = [];

  restSeconds = 30;
  workoutName = 'Full Body Starter';

  currentIndex = 0;
  currentSet = 1;
  remaining = 0;

  completedCount = 0;
  completedSets = 0;

  // Location is requested only when the user taps the location button.
  currentLocation: Position | null = null;
  locationName = '';
  locationStatus = 'Location is off until you request it';
  locationBusy = false;
  mapStatus = 'Loading map...';
  distanceFromPreviousMeters: number | null = null;

  @ViewChild('locationMap') private locationMapElement?: ElementRef<HTMLDivElement>;
  private locationMap?: import('leaflet').Map;
  private locationMarker?: import('leaflet').CircleMarker;
  private previousLocationPoint: { latitude: number; longitude: number } | null = null;
  private readonly defaultMapCenter: [number, number] = [14.5995, 120.9842];

  private deadline = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private backButtonSubscription?: Subscription;
  private sessionStartedAt = 0;
  private lastTickRemaining = -1;

  // Timer sound and voice
  private audioContext: AudioContext | null = null;

  restTarget: RestTarget = 'set';

  addFormOpen = false;
  editingExerciseId: number | null = null;

  draftName = '';
  draftDuration = 30;
  draftReps = 15;
  draftSets = 3;
  draftCategory = 'Strength';

  constructor(
    private toastController: ToastController,
    private alertController: AlertController,
    private platform: Platform
  ) {}

  ngOnInit(): void {
    this.loadSavedData();
    this.loadPreviousLocationPoint();

    this.backButtonSubscription =
      this.platform.backButton.subscribeWithPriority(10, () => {
        void this.handleAndroidBack();
      });

  }

  ngAfterViewInit(): void {
    const center: [number, number] = this.previousLocationPoint
      ? [this.previousLocationPoint.latitude, this.previousLocationPoint.longitude]
      : this.defaultMapCenter;
    void this.renderLocationMap(center, null, this.previousLocationPoint ? 16 : 13)
      .catch(error => {
        console.warn('Could not initialize the initial map:', error);
        this.mapStatus = `Map could not load: ${this.locationErrorMessage(error)}`;
      });
  }

  ngOnDestroy(): void {
    this.clearInterval();
    this.backButtonSubscription?.unsubscribe();

    this.disposeLocationMap();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  async getCurrentLocation(): Promise<void> {
    if (this.locationBusy) return;

    this.locationBusy = true;
    this.locationStatus = 'Getting your location...';

    try {
      const position = await this.acquireCurrentPosition();

      this.distanceFromPreviousMeters = this.previousLocationPoint
        ? this.calculateDistanceMeters(this.previousLocationPoint, position.coords)
        : null;
      this.previousLocationPoint = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude
      };
      this.savePreviousLocationPoint();

      this.currentLocation = position;
      this.locationName = 'Finding street or place name...';
      this.locationStatus = 'Location found';

      try {
        await this.updateLocationMap(position);
      } catch (error) {
        console.warn('Could not render the location map:', error);
        const reason = this.locationErrorMessage(error).trim();
        this.mapStatus = reason
          ? `Map could not load: ${reason}`
          : 'Map could not be initialized.';
      }

      try {
        this.locationName = await this.reverseGeocode(position);
        if (this.locationStatus === 'Location found') {
          this.locationStatus = 'Location updated';
        }
      } catch (error) {
        console.warn('Could not resolve a street or place name:', error);
        this.locationName = 'Street name unavailable near this location';
        this.locationStatus = this.locationStatus === 'Location found'
          ? 'Location found; place name unavailable'
          : `${this.locationStatus}; place name unavailable`;
      }
    } catch (error) {
      console.warn('Could not get current location:', error);
      const failure = this.describeLocationFailure(error);
      this.locationStatus = failure.status;
      void this.showToast(failure.help);
    } finally {
      this.locationBusy = false;
    }
  }

  get distanceFromPreviousLabel(): string | null {
    const distance = this.distanceFromPreviousMeters;
    if (distance === null) return null;
    return distance < 1000
      ? `${Math.round(distance)} m`
      : `${(distance / 1000).toFixed(2)} km`;
  }

  private loadPreviousLocationPoint(): void {
    try {
      const saved = localStorage.getItem('fitflow.previousLocation');
      if (!saved) return;

      const point = JSON.parse(saved) as { latitude?: unknown; longitude?: unknown };
      const latitude = Number(point.latitude);
      const longitude = Number(point.longitude);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90
        && longitude >= -180 && longitude <= 180) {
        this.previousLocationPoint = { latitude, longitude };
      }
    } catch (error) {
      console.warn('Could not read the previous location:', error);
    }
  }

  private savePreviousLocationPoint(): void {
    if (!this.previousLocationPoint) return;
    try {
      localStorage.setItem('fitflow.previousLocation', JSON.stringify(this.previousLocationPoint));
    } catch (error) {
      console.warn('Could not save the previous location:', error);
    }
  }

  private calculateDistanceMeters(
    from: { latitude: number; longitude: number },
    to: { latitude: number; longitude: number }
  ): number {
    const radians = (degrees: number): number => degrees * Math.PI / 180;
    const latitudeDelta = radians(to.latitude - from.latitude);
    const longitudeDelta = radians(to.longitude - from.longitude);
    const startLatitude = radians(from.latitude);
    const endLatitude = radians(to.latitude);
    const a = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(startLatitude) * Math.cos(endLatitude)
      * Math.sin(longitudeDelta / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async acquireCurrentPosition(): Promise<Position> {
    try {
      return await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000
      });
    } catch (error) {
      const code = this.locationErrorCode(error);
      const message = this.locationErrorMessage(error).toLowerCase();
      const terminalError = ['0003', '0007', '0009', '0017', '0018'].some(suffix => code.endsWith(suffix))
        || code === '1'
        || message.includes('permission denied')
        || message.includes('location services are not enabled');

      if (terminalError) throw error;

      // Retry using Android's lower-power network/coarse location provider.
      return Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: 20000,
        maximumAge: 60000
      });
    }
  }

  private locationErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as { code?: unknown }).code ?? '');
    }
    return '';
  }

  private locationErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String((error as { message?: unknown }).message ?? '');
    }
    return String(error ?? '');
  }

  private describeLocationFailure(error: unknown): { status: string; help: string } {
    const code = this.locationErrorCode(error);
    const message = this.locationErrorMessage(error).toLowerCase();

    if (code.endsWith('0003') || code === '1' || message.includes('permission denied')) {
      return {
        status: 'Location permission was denied',
        help: 'Allow FitFlow to use your location in Android Settings, then try again.'
      };
    }
    if (code.endsWith('0007') || code.endsWith('0009') || code.endsWith('0017')
      || message.includes('location services are not enabled')) {
      return {
        status: 'Device location is turned off',
        help: 'Turn on Location in Android Quick Settings or Settings, then try again.'
      };
    }
    if (code.endsWith('0018')) {
      return {
        status: 'Location permission is missing from this app build',
        help: 'Rebuild and reinstall the APK so it includes the Android location permissions.'
      };
    }
    if (code.endsWith('0010') || code === '3' || message.includes('timed out')) {
      return {
        status: 'Could not get a GPS fix yet',
        help: 'Move near a window or outdoors, make sure Location is on, and try again.'
      };
    }
    return {
      status: 'Location unavailable',
      help: 'Check that Android Location is on and FitFlow has location permission, then try again.'
    };
  }

  private async reverseGeocode(position: Position): Promise<string> {
    const { latitude, longitude } = position.coords;
    const url = new URL('https://photon.komoot.io/reverse');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Place lookup failed (${response.status})`);

    const data = await response.json() as {
      features?: Array<{ properties?: Record<string, string | undefined> }>;
    };
    const place = data.features?.[0]?.properties;
    if (!place) return 'Street name unavailable near this location';

    const street = [place['housenumber'], place['street']]
      .filter((value): value is string => Boolean(value))
      .join(' ');
    const locality = [place['district'], place['city'], place['state'], place['country']]
      .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
      .join(', ');

    if (street && locality) return `${street}, ${locality}`;
    return street || place['name'] || locality || 'Street name unavailable near this location';
  }

  private async updateLocationMap(position: Position): Promise<void> {
    const { latitude, longitude } = position.coords;
    await this.renderLocationMap([latitude, longitude], [latitude, longitude], 17);
  }

  private async renderLocationMap(
    center: [number, number],
    currentPosition: [number, number] | null,
    zoom: number
  ): Promise<void> {
    const element = this.locationMapElement?.nativeElement;
    if (!element) throw new Error('The Leaflet map element is not available.');

    const leafletModule = await import('leaflet');
    const leaflet = (
      (leafletModule as unknown as { default?: typeof import('leaflet') }).default
      ?? leafletModule
    ) as typeof import('leaflet');
    if (typeof leaflet.map !== 'function') {
      throw new Error('Leaflet did not expose its map API.');
    }

    // Re-create the map against the current view element. Ionic removes and
    // recreates tab content, so a previous Leaflet instance can point at a
    // detached element after switching tabs.
    this.locationMap?.remove();
    this.locationMap = undefined;
    this.locationMarker = undefined;

    try {
      const map = leaflet.map(element, { zoomControl: true });
      this.locationMap = map;
      map.setView(center, zoom);
      const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
      const tileLayers = [
        leaflet.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution
        }),
        leaflet.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
          subdomains: 'abc',
          maxZoom: 19,
          attribution: `${attribution} · Tiles by <a href="https://www.hotosm.org/">HOT</a>`
        }),
        leaflet.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: `${attribution} · <a href="https://www.openstreetmap.de/">OSM Germany tiles</a>`
        })
      ];
      const tileLabels = ['OpenStreetMap', 'HOT', 'OSM Germany'];
      let activeLayerIndex = -1;
      let activeLayerLoaded = false;
      this.mapStatus = 'Loading map tiles...';

      const useTileLayer = (index: number): void => {
        if (this.locationMap !== map) return;
        if (index >= tileLayers.length) {
          this.mapStatus = 'Map tiles are unreachable. Check your internet connection.';
          return;
        }

        if (activeLayerIndex >= 0) map.removeLayer(tileLayers[activeLayerIndex]);
        activeLayerIndex = index;
        activeLayerLoaded = false;
        const layer = tileLayers[index];
        this.mapStatus = index === 0
          ? 'Loading map tiles...'
          : `Trying alternate map tiles (${tileLabels[index]})...`;

        layer.on('tileload', () => {
          if (this.locationMap === map && activeLayerIndex === index) {
            activeLayerLoaded = true;
            this.mapStatus = 'Map loaded';
          }
        });
        layer.on('tileerror', () => {
          if (this.locationMap === map && activeLayerIndex === index && !activeLayerLoaded) {
            useTileLayer(index + 1);
          }
        });
        layer.addTo(map);

        // Some WebViews leave failed tile requests pending without emitting
        // tileerror. Move to the next source if no tile arrives in time.
        window.setTimeout(() => {
          if (this.locationMap === map && activeLayerIndex === index && !activeLayerLoaded) {
            useTileLayer(index + 1);
          }
        }, 7000);
      };

      useTileLayer(0);
      if (currentPosition) {
        this.locationMarker = leaflet.circleMarker(currentPosition, {
          radius: 8,
          color: '#f5f7f2',
          weight: 3,
          fillColor: '#b7f45b',
          fillOpacity: 1
        }).addTo(map);
      }
    } catch (error) {
      this.locationMap?.remove();
      this.locationMap = undefined;
      this.locationMarker = undefined;
      throw error;
    }

    window.setTimeout(() => this.locationMap?.invalidateSize(), 0);
  }

  private disposeLocationMap(): void {
    this.locationMap?.remove();
    this.locationMap = undefined;
    this.locationMarker = undefined;
  }

  private async handleAndroidBack(): Promise<void> {
    if (this.addFormOpen) {
      this.cancelExerciseForm();
      return;
    }

    if (this.phase === 'work' || this.phase === 'rest') {
      const alert = await this.alertController.create({
        header: 'Workout in progress',
        message: 'Your workout is still running. Leave the timer and pause your workout?',
        buttons: [
          { text: 'Stay', role: 'cancel' },
          {
            text: 'Leave timer',
            role: 'confirm',
            handler: () => {
              if (!this.paused) this.togglePause();
              this.selectTab('home');
            }
          }
        ]
      });

      await alert.present();
      return;
    }

    if (this.tab !== 'home') {
      this.selectTab('home');
      return;
    }

    if (Capacitor.isNativePlatform()) {
      try {
        await App.minimizeApp();
      } catch (error) {
        console.warn('Could not minimize FitFlow:', error);
      }
    }
  }

  get currentExercise(): Exercise | null {
    return this.exercises[this.currentIndex] ?? null;
  }

  get nextExercise(): Exercise | null {
    return this.exercises[this.currentIndex + 1] ?? null;
  }

  get totalSets(): number {
    return this.exercises.reduce(
      (sum, exercise) => sum + exercise.sets,
      0
    );
  }

  get totalSeconds(): number {
    const workSeconds = this.exercises.reduce(
      (sum, exercise) => sum + exercise.duration * exercise.sets,
      0
    );

    const totalRestPeriods = Math.max(0, this.totalSets - 1);

    return workSeconds + totalRestPeriods * this.restSeconds;
  }

  get totalMinutesLabel(): string {
    return `${Math.ceil(this.totalSeconds / 60)} min`;
  }

  get formattedTime(): string {
    const minutes = Math.floor(this.remaining / 60)
      .toString()
      .padStart(2, '0');

    const seconds = (this.remaining % 60)
      .toString()
      .padStart(2, '0');

    return `${minutes}:${seconds}`;
  }

  get progress(): number {
    if (!this.totalSets) return 0;
    if (this.phase === 'done') return 100;

    let progressSets = this.completedSets;

    if (this.phase === 'work' && this.currentExercise) {
      const duration = Math.max(1, this.currentExercise.duration);
      const fraction = 1 - this.remaining / duration;
      progressSets += Math.max(0, Math.min(1, fraction));
    }

    return Math.min(
      100,
      Math.round((progressSets / this.totalSets) * 100)
    );
  }

  get completedWorkouts(): number {
    return this.history.length;
  }

  get totalTrainingMinutes(): number {
    return this.history.reduce(
      (sum, item) => sum + item.durationMinutes,
      0
    );
  }

  get canEdit(): boolean {
    return this.phase === 'ready' || this.phase === 'done';
  }

  loadSavedData(): void {
    try {
      const savedExercises = localStorage.getItem('fitflow.exercises');
      const savedHistory = localStorage.getItem('fitflow.history');
      const savedRest = Number(localStorage.getItem('fitflow.rest'));
      const savedName = localStorage.getItem('fitflow.workoutName');

      if (savedExercises) {
        const parsed = JSON.parse(savedExercises);

        if (Array.isArray(parsed)) {
          this.exercises = parsed.map((item: any, index: number) => ({
            id: Number(item.id) || Date.now() + index,
            name: String(item.name || 'Untitled exercise'),
            duration: this.validNumber(item.duration, 30, 1, 3600),
            reps: this.validNumber(item.reps, 15, 1, 999),
            sets: this.validNumber(item.sets, 1, 1, 99),
            category: String(item.category || 'Strength')
          }));
        }
      }

      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);

        if (Array.isArray(parsed)) {
          this.history = parsed;
        }
      }

      if (
        Number.isFinite(savedRest) &&
        savedRest >= 0 &&
        savedRest <= 600
      ) {
        this.restSeconds = savedRest;
      }

      if (savedName) {
        this.workoutName = savedName;
      }
    } catch (error) {
      console.warn('FitFlow could not read saved data:', error);
    }
  }

  private validNumber(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number
  ): number {
    const number = Number(value);

    if (!Number.isInteger(number)) return fallback;

    return Math.max(minimum, Math.min(maximum, number));
  }

  saveData(): void {
    try {
      localStorage.setItem(
        'fitflow.exercises',
        JSON.stringify(this.exercises)
      );

      localStorage.setItem(
        'fitflow.history',
        JSON.stringify(this.history)
      );

      localStorage.setItem('fitflow.rest', String(this.restSeconds));
      localStorage.setItem('fitflow.workoutName', this.workoutName);
    } catch (error) {
      console.error('Could not save FitFlow data:', error);
      void this.showToast('Could not save your changes on this device.');
    }
  }

  selectTab(tab: 'home' | 'timer' | 'history'): void {
    if (tab === this.tab) return;

    if (this.tab === 'home') {
      this.disposeLocationMap();
    }
    this.tab = tab;

    if (tab === 'home') {
      window.setTimeout(() => {
        const current = this.currentLocation?.coords;
        const center: [number, number] = current
          ? [current.latitude, current.longitude]
          : this.previousLocationPoint
            ? [this.previousLocationPoint.latitude, this.previousLocationPoint.longitude]
            : this.defaultMapCenter;
        void this.renderLocationMap(
          center,
          current ? center : null,
          current ? 17 : this.previousLocationPoint ? 16 : 13
        ).catch(error => {
          console.warn('Could not restore the map:', error);
          this.mapStatus = `Map could not load: ${this.locationErrorMessage(error)}`;
        });
      }, 0);
    }
  }

  async showToast(message: string): Promise<void> {
    const toast = await this.toastController.create({
      message,
      duration: 2200,
      position: 'bottom',
      color: 'dark'
    });

    await toast.present();
  }

  editExercise(exercise: Exercise): void {
    if (!this.canEdit) return;

    this.editingExerciseId = exercise.id;
    this.draftName = exercise.name;
    this.draftDuration = exercise.duration;
    this.draftReps = exercise.reps;
    this.draftSets = exercise.sets || 1;
    this.draftCategory = exercise.category || 'Strength';
    this.addFormOpen = true;

    this.scrollToExerciseEditor();
  }

  private scrollToExerciseEditor(): void {
    setTimeout(() => {
      document.getElementById('exercise-editor')?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    }, 50);
  }

  openAddExerciseForm(): void {
    if (!this.canEdit) return;

    this.cancelExerciseForm();
    this.addFormOpen = true;
    this.scrollToExerciseEditor();
  }

  cancelExerciseForm(): void {
    this.addFormOpen = false;
    this.editingExerciseId = null;

    this.draftName = '';
    this.draftDuration = 30;
    this.draftReps = 15;
    this.draftSets = 3;
    this.draftCategory = 'Strength';
  }

  addExercise(): void {
    const name = this.draftName.trim();
    const duration = Number(this.draftDuration);
    const reps = Number(this.draftReps);
    const sets = Number(this.draftSets);

    if (
      !name ||
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 3600 ||
      !Number.isInteger(reps) ||
      reps < 1 ||
      reps > 999 ||
      !Number.isInteger(sets) ||
      sets < 1 ||
      sets > 99
    ) {
      void this.showToast(
        'Enter a name, duration from 1–3600, repetitions from 1–999, and sets from 1–99.'
      );
      return;
    }

    if (this.editingExerciseId !== null) {
      this.exercises = this.exercises.map(item =>
        item.id === this.editingExerciseId
          ? {
              ...item,
              name,
              duration,
              reps,
              sets,
              category: this.draftCategory
            }
          : item
      );

      this.cancelExerciseForm();
      this.saveData();

      void this.showToast('Exercise updated.');
      return;
    }

    this.exercises.push({
      id: Date.now(),
      name,
      duration,
      reps,
      sets,
      category: this.draftCategory
    });

    this.cancelExerciseForm();
    this.saveData();

    void this.showToast('Exercise added to your workout.');
  }

  removeExercise(id: number): void {
    if (!this.canEdit) return;

    this.exercises = this.exercises.filter(item => item.id !== id);

    if (this.editingExerciseId === id) {
      this.cancelExerciseForm();
    }

    this.saveData();

    void this.showToast('Exercise removed.');
  }

  updateRest(): void {
    this.restSeconds = Math.max(
      0,
      Math.min(600, Math.floor(Number(this.restSeconds) || 0))
    );

    this.saveData();
  }

  async startWorkout(): Promise<void> {
    if (!this.exercises.length) {
      await this.showToast('Add at least one exercise before starting.');
      return;
    }

    // Initialize audio directly from the user's start-button interaction.
    this.prepareAudio();

    this.clearInterval();

    this.currentIndex = 0;
    this.currentSet = 1;

    this.completedCount = 0;
    this.completedSets = 0;

    this.paused = false;
    this.sessionStartedAt = Date.now();

    this.selectTab('timer');

    this.beginWork();

    await this.hapticImpact();
  }

  private beginWork(): void {
    const exercise = this.currentExercise;

    if (!exercise) {
      void this.finishWorkout();
      return;
    }

    this.phase = 'work';
    this.remaining = exercise.duration;

    this.speakPhase('Time to work');

    this.startClock();
  }

  private beginRest(): void {
    this.phase = 'rest';
    this.remaining = this.restSeconds;

    this.speakPhase('Time to rest');

    this.startClock();
  }

  private startClock(): void {
    this.clearInterval();

    this.deadline = Date.now() + this.remaining * 1000;
    this.lastTickRemaining = this.remaining;

    this.interval = setInterval(() => {
      const nextRemaining = Math.max(
        0,
        Math.ceil((this.deadline - Date.now()) / 1000)
      );

      if (nextRemaining !== this.remaining) {
        this.remaining = nextRemaining;

        if (nextRemaining > 0) {
          this.playTimerBeep(nextRemaining <= 5);
        }
      }

      if (this.remaining <= 0) {
        void this.advancePhase();
      }
    }, 200);
  }

  private async advancePhase(): Promise<void> {
    this.clearInterval();

    await this.hapticNotification();

    if (this.phase === 'work') {
      this.completeCurrentSet();
    } else if (this.phase === 'rest') {
      this.continueAfterRest();
    }
  }

  private completeCurrentSet(): void {
    const exercise = this.currentExercise;

    if (!exercise) {
      void this.finishWorkout();
      return;
    }

    this.completedSets++;

    if (this.currentSet < exercise.sets) {
      this.restTarget = 'set';
    } else {
      this.completedCount++;

      if (this.currentIndex < this.exercises.length - 1) {
        this.restTarget = 'exercise';
      } else {
        void this.finishWorkout();
        return;
      }
    }

    if (this.restSeconds > 0) {
      this.beginRest();
    } else {
      this.continueAfterRest();
    }
  }

  private continueAfterRest(): void {
    this.clearInterval();

    this.paused = false;

    if (this.restTarget === 'set') {
      this.currentSet++;
      this.beginWork();
    } else {
      this.moveNext();
    }
  }

  private moveNext(): void {
    this.currentIndex++;
    this.currentSet = 1;

    if (this.currentIndex >= this.exercises.length) {
      void this.finishWorkout();
    } else {
      this.beginWork();
    }
  }

  togglePause(): void {
    if (this.phase !== 'work' && this.phase !== 'rest') return;

    if (!this.paused) {
      this.remaining = Math.max(
        0,
        Math.ceil((this.deadline - Date.now()) / 1000)
      );

      this.clearInterval();
      this.paused = true;
    } else {
      this.paused = false;

      if (this.remaining <= 0) {
        void this.advancePhase();
      } else {
        this.startClock();
      }
    }
  }

  async skipPhase(): Promise<void> {
    if (this.phase !== 'work' && this.phase !== 'rest') return;

    this.clearInterval();
    this.paused = false;

    if (this.phase === 'work') {
      this.completeCurrentSet();
    } else {
      this.continueAfterRest();
    }
  }

  async finishWorkout(): Promise<void> {
    this.clearInterval();

    if (this.phase === 'done') return;

    this.phase = 'done';
    this.paused = false;
    this.remaining = 0;

    this.playCompletionSound();

    const minutes = Math.max(
      1,
      Math.round((Date.now() - this.sessionStartedAt) / 60000)
    );

    const record: WorkoutRecord = {
      id: Date.now(),
      date: new Date().toISOString(),
      durationMinutes: minutes,
      exerciseCount: this.completedCount,
      workoutName: this.workoutName
    };

    this.history.unshift(record);
    this.history = this.history.slice(0, 100);

    this.saveData();

    await this.hapticNotification();
  }

  resetWorkout(): void {
    this.clearInterval();

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    this.phase = 'ready';
    this.currentIndex = 0;
    this.currentSet = 1;

    this.remaining = 0;
    this.completedCount = 0;
    this.completedSets = 0;

    this.paused = false;
    this.selectTab('home');
  }

  private clearInterval(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // AUDIO

  private prepareAudio(): void {
    try {
      if (!this.audioContext) {
        const AudioContextClass =
          window.AudioContext ||
          (window as any).webkitAudioContext;

        if (AudioContextClass) {
          this.audioContext = new AudioContextClass();
        }
      }

      if (this.audioContext?.state === 'suspended') {
        void this.audioContext.resume().catch(error => {
          console.warn('Could not resume timer audio:', error);
        });
      }
    } catch (error) {
      console.warn('Audio is unavailable:', error);
    }
  }

  private playTone(
    frequency: number,
    duration: number,
    volume: number
  ): void {
    try {
      this.prepareAudio();

      if (!this.audioContext) return;

      const context = this.audioContext;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        volume,
        now + 0.01
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + duration
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    } catch (error) {
      console.warn('Could not play timer sound:', error);
    }
  }

  private playTimerBeep(finalFiveSeconds: boolean): void {
    if (finalFiveSeconds) {
      this.playTone(1050, 0.16, 0.22);
    } else {
      this.playTone(720, 0.09, 0.10);
    }
  }

  private playCompletionSound(): void {
    this.playTone(660, 0.18, 0.18);

    window.setTimeout(() => {
      this.playTone(830, 0.18, 0.18);
    }, 180);

    window.setTimeout(() => {
      this.playTone(1050, 0.35, 0.22);
    }, 360);
  }

  private speakPhase(message: string): void {
    try {
      if (!('speechSynthesis' in window)) return;

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(message);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.warn('Voice announcement unavailable:', error);
    }
  }

  // HAPTIC FEEDBACK

  private async hapticImpact(): Promise<void> {
    try {
      await Haptics.impact({
        style: ImpactStyle.Medium
      });
    } catch {
      // Haptic feedback may not be available on every device.
    }
  }

  private async hapticNotification(): Promise<void> {
    try {
      await Haptics.notification({
        type: NotificationType.Success
      });
    } catch {
      // Haptic feedback may not be available on every device.
    }
  }
}
