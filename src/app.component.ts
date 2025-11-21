import { Component, ChangeDetectionStrategy, signal, effect, computed, inject, ChangeDetectorRef, HostListener, OnDestroy, AfterViewInit, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { inject as vcinject } from '@vercel/analytics';
import { Observable, of, Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { COUNTRIES, LANGUAGES } from './countries-languages';

vcinject();

// --- TYPE DEFINITIONS ---
interface Gradient { angle: number; from: string; to: string; }
interface Shadow { x: number; y: number; blur: number; color: string; }
interface DiscoverFilters { sortBy: string; genres: string[]; year: number | null; }

type TmdbItemType = 'movie' | 'tv' | 'person';
type TmdbCollectionType = 'movie' | 'tv' | 'mixed';
type ElementType = 
  | 'text' | 'image' | 'shape' 
  | 'tmdb-poster' | 'tmdb-backdrop' | 'tmdb-title' | 'tmdb-overview' 
  | 'tmdb-poster-scroll' | 'tmdb-backdrop-slideshow' | 'tmdb-tagline' 
  | 'tmdb-release-date' | 'tmdb-runtime' | 'tmdb-genres' | 'tmdb-rating' 
  | 'tmdb-cast' | 'tmdb-logo' | 'tmdb-network-logo' | 'tmdb-season-episode-count'
  | 'tmdb-dynamic-field';

type ImageFit = 'cover' | 'contain' | 'fill';

interface CanvasElement {
  id: string;
  type: ElementType;
  x: number; y: number; width: number; height: number; rotation: number;
  zIndex: number; visible: boolean;
  content: string;
  styles: {
    backgroundColor: string; 
    backgroundOpacity: number; 
    color: string; fontFamily: string; fontSize: number;
    fontWeight: '400' | '500' | '600' | '700'; textAlign: 'left' | 'center' | 'right';
    borderRadius: number; borderWidth: number; borderColor: string; 
    opacity: number; 
    backgroundGradient?: Gradient;
    boxShadow?: Shadow; textShadow?: Shadow;
    filterBlur: number; filterGrayscale: number;
  };
  tmdbId?: string;
  tmdbItemType: TmdbItemType;
  tmdbCollectionType: TmdbCollectionType;
  tmdbEndpoint?: string;
  discoverFilters: DiscoverFilters;
  tmdbData?: any;
  linkGroup?: string; 
  imageFit: ImageFit;
  
  // For Dynamic Data Fields
  dataPath?: string;
  dataPrefix?: string;
  dataSuffix?: string;
}

interface HistoryState { elements: CanvasElement[]; selectedElementId: string | null; }
interface ContextMenuState { visible: boolean; x: number; y: number; elementId: string | null; }
interface TmdbGenre { id: number; name: string; }
interface TmdbUser { id: number; username: string; avatar_path: string | null; name: string; }

declare var interact: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule]
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private slideshowIntervals: Map<string, any> = new Map();
  private posterScrollIntervals: Map<string, any> = new Map();
  private searchTerms = new Subject<string>();
  private authCheckSubject = new Subject<void>();
  
  readonly Math = Math;

  // --- CONSTANTS & STATIC DATA ---
  readonly countries = COUNTRIES;
  readonly languages = LANGUAGES;
  readonly fonts = ['Inter', 'Roboto', 'Montserrat', 'Lato', 'Oswald'];
  
  readonly tmdbEndpoints = {
    movie: [
      { key: 'movie/popular', name: 'Popular' }, { key: 'movie/top_rated', name: 'Top Rated' },
      { key: 'movie/upcoming', name: 'Upcoming' }, { key: 'movie/now_playing', name: 'Now Playing' },
      { key: 'discover/movie', name: 'Discover (Filtered)' }
    ],
    tv: [
      { key: 'tv/popular', name: 'Popular' }, { key: 'tv/top_rated', name: 'Top Rated' },
      { key: 'tv/on_the_air', name: 'On The Air' }, { key: 'tv/airing_today', name: 'Airing Today' },
      { key: 'discover/tv', name: 'Discover (Filtered)' }
    ],
    mixed: [
        { key: 'trending/all/day', name: 'Trending Today' },
        { key: 'trending/all/week', name: 'Trending This Week' }
    ]
  };
  readonly discoverSortOptions = {
    movie: [
      { key: 'popularity.desc', name: 'Popularity' }, { key: 'vote_average.desc', name: 'Rating' },
      { key: 'revenue.desc', name: 'Revenue' }, { key: 'primary_release_date.desc', name: 'Release Date' },
      { key: 'vote_count.desc', name: 'Vote Count' }
    ],
    tv: [
      { key: 'popularity.desc', name: 'Popularity' }, { key: 'vote_average.desc', name: 'Rating' },
      { key: 'first_air_date.desc', name: 'First Air Date' },
      { key: 'vote_count.desc', name: 'Vote Count' }
    ]
  };

  // --- STATE SIGNALS ---
  elements = signal<CanvasElement[]>([]);
  selectedElementId = signal<string | null>(null);
  
  // Auth Settings
  authMethod = signal<'v3' | 'v4'>((localStorage.getItem('tmdbAuthMethod') as 'v3' | 'v4') || 'v4');
  tmdbReadToken = signal<string>(localStorage.getItem('tmdbReadToken') || '');
  tmdbApiKey = signal<string>(localStorage.getItem('tmdbApiKey') || '');
  tmdbUser = signal<TmdbUser | null>(null);
  isAuthValid = signal<boolean>(false);
  
  // Other Settings
  watchRegion = signal<string>(localStorage.getItem('tmdbWatchRegion') || 'US');
  language = signal<string>(localStorage.getItem('tmdbLanguage') || 'en-US');
  includeAdult = signal<boolean>(localStorage.getItem('tmdbIncludeAdult') === 'true');

  // UI State
  canvasBaseSizes = { 
      mobile: { width: 375, height: 667 }, 
      tablet: { width: 768, height: 1024 }, 
      tv: { width: 1920, height: 1080 } 
  };
  selectedPreset = signal<'mobile' | 'tablet' | 'tv'>('mobile');
  orientation = signal<'portrait' | 'landscape'>('portrait');
  zoomLevel = signal<number>(1);

  history = signal<HistoryState[]>([]);
  historyIndex = signal<number>(-1);
  activeLeftPanelTab = signal<'elements' | 'settings'>('elements');
  activeRightPanelTab = signal<'properties' | 'layers' | 'export'>('properties');
  previewMode = signal(false);
  contextMenu = signal<ContextMenuState>({ visible: false, x: 0, y: 0, elementId: null });
  copiedStyles = signal<Partial<CanvasElement['styles']> | null>(null);
  
  slideshowState = signal<{[id: string]: {idx1: number, idx2: number, fade: boolean, backdrops: string[], items: any[]}}>({});
  
  draggedLayerId = signal<string | null>(null);
  dragOverLayerId = signal<string | null>(null);
  
  tmdbGenres = signal<{movie: TmdbGenre[], tv: TmdbGenre[]}>({ movie: [], tv: [] });
  tmdbSearchResults = signal<any[]>([]);
  isSearching = signal(false);

  // --- COMPUTED SIGNALS ---
  canvasConfig = computed(() => {
      const base = this.canvasBaseSizes[this.selectedPreset()];
      let w = base.width;
      let h = base.height;

      if (this.selectedPreset() === 'tv') {
          if (this.orientation() === 'portrait') { w = base.height; h = base.width; }
      } else {
          if (this.orientation() === 'landscape') { w = base.height; h = base.width; }
      }

      return { width: w, height: h, scale: this.zoomLevel() };
  });

  selectedElement = computed(() => this.elements().find(el => el.id === this.selectedElementId()));
  generatedPhpCode = signal('');
  
  availableCollectionEndpoints = computed(() => {
    const el = this.selectedElement();
    if (!el || !el.tmdbCollectionType) return [];
    return this.tmdbEndpoints[el.tmdbCollectionType] || [];
  });
  
  availableSortOptions = computed(() => {
    const el = this.selectedElement();
    if (!el || el.tmdbEndpoint !== `discover/${el.tmdbCollectionType}`) return [];
    return this.discoverSortOptions[el.tmdbCollectionType as 'movie' | 'tv'] || [];
  });
  
  availableGenres = computed(() => {
    const el = this.selectedElement();
    if (!el || el.tmdbEndpoint !== `discover/${el.tmdbCollectionType}`) return [];
    return this.tmdbGenres()[el.tmdbCollectionType as 'movie' | 'tv'] || [];
  });
  
  isImageElement(elementId: string | null): boolean {
      if (!elementId) return false;
      const el = this.elements().find(e => e.id === elementId);
      if (!el) return false;
      const imageTypes = ['image', 'tmdb-poster', 'tmdb-backdrop', 'tmdb-logo', 'tmdb-network-logo'];
      return imageTypes.includes(el.type);
  }
  
  isApiConfigured(): boolean {
      return this.authMethod() === 'v3' ? !!this.tmdbApiKey() : !!this.tmdbReadToken();
  }

  constructor() {
    effect(() => localStorage.setItem('tmdbAuthMethod', this.authMethod()));
    effect(() => {
        localStorage.setItem('tmdbReadToken', this.tmdbReadToken());
        this.authCheckSubject.next();
    });
    effect(() => {
        localStorage.setItem('tmdbApiKey', this.tmdbApiKey());
        this.authCheckSubject.next();
    });
    effect(() => localStorage.setItem('tmdbWatchRegion', this.watchRegion()));
    effect(() => localStorage.setItem('tmdbLanguage', this.language()));
    effect(() => localStorage.setItem('tmdbIncludeAdult', this.includeAdult().toString()));

    effect(() => {
        if(this.isApiConfigured() && this.isAuthValid()) this.fetchTmdbGenres();
        this.elements().forEach(el => this.fetchTmdbDataForElement(el.id, true));
    }, { allowSignalWrites: true });

    effect(() => this.updatePhpCode());
    
    this.saveStateToHistory();
  }
  
  ngOnInit() {
    // Auth Verification Pipeline
    this.authCheckSubject.pipe(
        debounceTime(500),
        distinctUntilChanged()
    ).subscribe(() => this.verifyApiConnection());

    // Search Pipeline
    this.searchTerms.pipe(
      debounceTime(400),
      distinctUntilChanged(),
      switchMap((term: string) => {
        if (!term.trim() || !this.isApiConfigured() || !this.selectedElement()) return of({results: []});
        this.isSearching.set(true);
        const type = this.selectedElement()?.tmdbItemType || 'movie';
        
        let headers = new HttpHeaders({'Content-Type': 'application/json;charset=utf-8'});
        let params = new URLSearchParams({ language: this.language(), query: term });

        if (this.authMethod() === 'v4') {
            headers = headers.set('Authorization', `Bearer ${this.tmdbReadToken()}`);
        } else {
            params.append('api_key', this.tmdbApiKey());
        }
        
        return this.http.get<any>(`https://api.themoviedb.org/3/search/${type}?${params.toString()}`, { headers }).pipe(catchError(() => of({results: []})));
      })
    ).subscribe(response => {
      this.tmdbSearchResults.set(response.results);
      this.isSearching.set(false);
      this.cdr.detectChanges();
    });
    
    this.fitCanvasToScreen();
    
    // Initial check if keys exist
    if(this.isApiConfigured()) this.authCheckSubject.next();
  }

  ngAfterViewInit() { this.setupInteract(); }
  ngOnDestroy() { 
      this.slideshowIntervals.forEach(interval => clearInterval(interval)); 
      this.posterScrollIntervals.forEach(interval => clearInterval(interval));
  }

  // --- HOST LISTENERS ---
  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    const activeTag = document.activeElement?.tagName.toLowerCase();
    const isInputActive = activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select';

    if (event.ctrlKey || event.metaKey) {
      if (event.key === 'z') { event.preventDefault(); this.undo(); }
      if (event.key === 'y') { event.preventDefault(); this.redo(); }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedElementId() && !isInputActive) {
             event.preventDefault();
             this.deleteElement(this.selectedElementId()!);
      }
    } else if (!isInputActive && this.selectedElementId()) {
        const el = this.selectedElement();
        if (el) {
            const step = event.shiftKey ? 10 : 1;
            let newX = el.x;
            let newY = el.y;
            let handled = false;

            switch(event.key) {
                case 'ArrowUp': newY -= step; handled = true; break;
                case 'ArrowDown': newY += step; handled = true; break;
                case 'ArrowLeft': newX -= step; handled = true; break;
                case 'ArrowRight': newX += step; handled = true; break;
            }

            if (handled) {
                event.preventDefault();
                this.updateElementProperty('x', newX, true);
                this.updateElementProperty('y', newY, true);
            }
        }
    }
  }

  @HostListener('document:click')
  onDocumentClick() { this.contextMenu.update(cm => ({ ...cm, visible: false })); }
  
  // --- API AUTH & VERIFICATION ---
  verifyApiConnection() {
      if (!this.isApiConfigured()) {
          this.tmdbUser.set(null);
          this.isAuthValid.set(false);
          return;
      }

      let headers = new HttpHeaders({'Content-Type': 'application/json;charset=utf-8'});
      let url = 'https://api.themoviedb.org/3/account';
      
      if (this.authMethod() === 'v4') {
          headers = headers.set('Authorization', `Bearer ${this.tmdbReadToken()}`);
      } else {
          url += `?api_key=${this.tmdbApiKey()}`;
      }

      this.http.get<any>(url, { headers }).pipe(
          catchError(() => {
              this.isAuthValid.set(false);
              this.tmdbUser.set(null);
              return of(null);
          })
      ).subscribe(data => {
          if (data) {
              this.isAuthValid.set(true);
              this.tmdbUser.set({
                  id: data.id,
                  username: data.username,
                  name: data.name,
                  avatar_path: data.avatar?.tmdb?.avatar_path ? `https://image.tmdb.org/t/p/w150_and_h150_face${data.avatar.tmdb.avatar_path}` : null
              });
              this.fetchTmdbGenres();
          }
          this.cdr.detectChanges();
      });
  }
  
  openTmdbSettings() {
      window.open('https://www.themoviedb.org/settings/api', '_blank');
  }

  // --- CANVAS CONTROLS ---
  changeCanvasMode(newPreset?: 'mobile' | 'tablet' | 'tv', newOrientation?: 'portrait' | 'landscape') {
      const currentConfig = this.canvasConfig();
      const oldW = currentConfig.width;
      const oldH = currentConfig.height;

      const targetPreset = newPreset || this.selectedPreset();
      const targetOrientation = newOrientation || this.orientation();

      const base = this.canvasBaseSizes[targetPreset];
      let newW = base.width;
      let newH = base.height;

      if (targetPreset === 'tv') {
          if (targetOrientation === 'portrait') { newW = base.height; newH = base.width; }
      } else {
          if (targetOrientation === 'landscape') { newW = base.height; newH = base.width; }
      }

      if(newPreset) this.selectedPreset.set(newPreset);
      if(newOrientation) this.orientation.set(newOrientation);

      const scaleX = newW / oldW;
      const scaleY = newH / oldH;

      this.elements.update(els => els.map(el => ({
          ...el,
          x: el.x * scaleX,
          y: el.y * scaleY,
          width: el.width * scaleX,
          height: el.height * scaleY,
          styles: {
              ...el.styles,
              fontSize: el.styles.fontSize * ((scaleX + scaleY) / 2) 
          }
      })));

      this.fitCanvasToScreen(targetPreset);
      this.saveStateToHistory();
  }
  
  fitCanvasToScreen(presetOverride?: 'mobile' | 'tablet' | 'tv') {
      const preset = presetOverride || this.selectedPreset();
      if (preset === 'tv') this.zoomLevel.set(0.45);
      else if (preset === 'tablet') this.zoomLevel.set(0.75);
      else this.zoomLevel.set(1.0);
  }

  // --- HISTORY MANAGEMENT ---
  saveStateToHistory() {
    setTimeout(() => {
      const currentState: HistoryState = { elements: JSON.parse(JSON.stringify(this.elements())), selectedElementId: this.selectedElementId() };
      const lastState = this.history()[this.historyIndex()];
      if (lastState && JSON.stringify(lastState.elements) === JSON.stringify(currentState.elements)) return;
      
      const newHistory = this.history().slice(0, this.historyIndex() + 1);
      newHistory.push(currentState);
      this.history.set(newHistory);
      this.historyIndex.set(newHistory.length - 1);
    }, 300);
  }
  
  undo() { if (this.historyIndex() > 0) { this.historyIndex.update(i => i - 1); this.restoreStateFromHistory(); } }
  redo() { if (this.historyIndex() < this.history().length - 1) { this.historyIndex.update(i => i + 1); this.restoreStateFromHistory(); } }
  
  restoreStateFromHistory() {
    const state = this.history()[this.historyIndex()];
    if (state) {
      this.elements.set(state.elements);
      this.selectedElementId.set(state.selectedElementId);
      state.elements.forEach(el => {
        if (el.type === 'tmdb-backdrop-slideshow') this.setupSlideshow(el.id);
        if (el.type === 'tmdb-poster-scroll') this.setupPosterScroll(el.id);
      });
    }
  }

  // --- ELEMENT MANIPULATION ---
  addElement(type: ElementType, itemType: TmdbItemType = 'movie', collectionType: TmdbCollectionType = 'movie') {
    const isLogo = type === 'tmdb-logo' || type === 'tmdb-network-logo';
    const currentScale = this.canvasConfig().width / 1920; 
    const baseScale = this.selectedPreset() === 'mobile' ? 1 : (this.selectedPreset() === 'tablet' ? 1.5 : 2.5);
    
    const newElement: CanvasElement = {
      id: `el_${Date.now()}`, type, x: 50, y: 50,
      width: (type.includes('scroll') || type.includes('slideshow') ? 350 : (type.includes('backdrop') ? 300 : (type.includes('cast') ? 350 : (isLogo ? 120 : 150)))) * baseScale,
      height: (type.includes('text') || type.includes('title') || type.includes('tagline') || type.includes('dynamic') ? 50 : (type.includes('backdrop') || type.includes('slideshow') ? 169 : (type.includes('cast') ? 100 : (isLogo ? 60 : 225)))) * baseScale,
      rotation: 0,
      zIndex: this.elements().length + 1, content: 'New Element', visible: true,
      styles: { 
          backgroundColor: type === 'tmdb-dynamic-field' ? '#0d253f' : '#1b3a57', // TMDB Dark Blue and Surface
          backgroundOpacity: type === 'tmdb-dynamic-field' ? 0 : 1,
          color: '#f1f5f9', fontFamily: 'Inter', fontSize: 16 * baseScale, fontWeight: '400', textAlign: 'left', borderRadius: 8, borderWidth: 0, borderColor: '#f1f5f9', opacity: 1, filterBlur: 0, filterGrayscale: 0 
      },
      tmdbItemType: itemType,
      tmdbCollectionType: collectionType,
      discoverFilters: { sortBy: 'popularity.desc', genres: [], year: null },
      imageFit: isLogo ? 'contain' : 'cover',
      linkGroup: '',
      dataPath: '',
      dataPrefix: '',
      dataSuffix: ''
    };
    
    if (type === 'tmdb-dynamic-field') {
        newElement.content = 'Dynamic Data';
        newElement.dataPath = 'vote_count'; 
        newElement.dataPrefix = 'Votes: ';
    }
    
    if (type === 'image') newElement.content = 'https://picsum.photos/200/300';
    if (type === 'shape') newElement.height = 100 * baseScale;
    this.elements.update(els => [...els, newElement]);
    this.selectElement(newElement.id);
    this.activeRightPanelTab.set('properties');
    this.saveStateToHistory();
  }

  deleteElement(id: string) {
    this.elements.update(els => els.filter(el => el.id !== id));
    if (this.selectedElementId() === id) this.selectedElementId.set(null);
    if(this.slideshowIntervals.has(id)) { clearInterval(this.slideshowIntervals.get(id)); this.slideshowIntervals.delete(id); }
    if(this.posterScrollIntervals.has(id)) { clearInterval(this.posterScrollIntervals.get(id)); this.posterScrollIntervals.delete(id); }
    this.saveStateToHistory();
  }

  selectElement(id: string | null) {
    this.selectedElementId.set(id);
    if(id) {
        this.tmdbSearchResults.set([]);
    }
  }
  
  deselectCanvas(event: MouseEvent) { if ((event.target as HTMLElement).id === 'canvas-bg') this.selectedElementId.set(null); }

  bringToFront(id: string, saveHistory = true) {
    const maxZ = Math.max(...this.elements().map(e => e.zIndex), 0);
    this.elements.update(els => els.map(el => el.id === id ? { ...el, zIndex: maxZ + 1 } : el));
    if(saveHistory) this.saveStateToHistory();
    this.contextMenu.update(cm => ({ ...cm, visible: false }));
  }
  
  sendToBack(id: string, saveHistory = true) {
    const minZ = Math.min(...this.elements().map(e => e.zIndex), 0);
    this.elements.update(els => els.map(el => el.id === id ? { ...el, zIndex: minZ - 1 } : el));
    if (saveHistory) this.saveStateToHistory();
    this.contextMenu.update(cm => ({ ...cm, visible: false }));
  }

  updateElementStyle(prop: keyof CanvasElement['styles'], value: any) { this.updateSelectedElement(el => { el.styles = { ...el.styles, [prop]: value }; }); }
  
  updateElementProperty(prop: keyof CanvasElement, value: any, noHistory = false) { 
      this.updateSelectedElement(el => { (el as any)[prop] = value; }, noHistory);
      
      if (prop === 'tmdbId') {
         const el = this.selectedElement();
         if(el && el.linkGroup) {
             this.propagateTmdbId(el.linkGroup, value, el.tmdbItemType);
         } else if(el) {
             this.fetchTmdbDataForElement(el.id);
         }
      }
  }
  
  setImageFit(id: string, fit: ImageFit) {
      this.elements.update(els => els.map(el => el.id === id ? { ...el, imageFit: fit } : el));
      this.saveStateToHistory();
      this.contextMenu.update(cm => ({ ...cm, visible: false }));
  }
  
  updateDiscoverFilter(prop: keyof DiscoverFilters, value: any) { this.updateSelectedElement(el => { el.discoverFilters = { ...el.discoverFilters, [prop]: value }; }); }

  private updateSelectedElement(updateFn: (el: CanvasElement) => void, noHistory = false) {
    const id = this.selectedElementId();
    if (!id) return;
    this.elements.update(els => els.map(el => {
      if (el.id === id) { const newEl = { ...el }; updateFn(newEl); return newEl; }
      return el;
    }));
    if(!noHistory) this.saveStateToHistory();
  }

  toggleVisibility(id: string) {
    this.elements.update(els => els.map(el => el.id === id ? {...el, visible: !el.visible} : el));
    this.saveStateToHistory();
  }
  
  // --- DRAG & DROP LAYERS (GROUPING) ---
  onLayerDragStart(event: DragEvent, elementId: string) {
    this.draggedLayerId.set(elementId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'link';
      event.dataTransfer.setData('text/plain', elementId);
    }
  }

  onLayerDragOver(event: DragEvent, targetId: string) {
    event.preventDefault();
    const draggedId = this.draggedLayerId();
    if (!draggedId || draggedId === targetId) return;
    this.dragOverLayerId.set(targetId);
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
  }

  onLayerDragLeave(event: DragEvent) { this.dragOverLayerId.set(null); }

  onLayerDrop(event: DragEvent, targetId: string) {
    event.preventDefault();
    this.dragOverLayerId.set(null);
    const draggedId = this.draggedLayerId();
    if (!draggedId || draggedId === targetId) return;
    this.linkElements(draggedId, targetId);
    this.draggedLayerId.set(null);
  }

  linkElements(sourceId: string, targetId: string) {
    const allElements = this.elements();
    const sourceEl = allElements.find(e => e.id === sourceId);
    const targetEl = allElements.find(e => e.id === targetId);
    if (!sourceEl || !targetEl) return;
    let groupId = targetEl.linkGroup;
    if (!groupId) {
      groupId = 'group_' + Date.now().toString(36);
      this.elements.update(els => els.map(el => el.id === targetId ? { ...el, linkGroup: groupId } : el));
    }
    this.elements.update(els => els.map(el => {
      if (el.id === sourceId) return { ...el, linkGroup: groupId, tmdbId: targetEl.tmdbId, tmdbItemType: targetEl.tmdbItemType, tmdbData: null };
      return el;
    }));
    this.fetchTmdbDataForElement(sourceId);
    this.saveStateToHistory();
  }

  unlinkElement(id: string, event: MouseEvent) {
    event.stopPropagation();
    this.elements.update(els => els.map(el => el.id === id ? { ...el, linkGroup: '' } : el));
    this.saveStateToHistory();
  }

  // --- TMDB API IMPLEMENTATION ---
  
  fetchTmdbGenres() {
    if(!this.isApiConfigured()) return;
    
    let headers = new HttpHeaders({'Content-Type': 'application/json;charset=utf-8'});
    let params = new URLSearchParams();

    if (this.authMethod() === 'v4') {
        headers = headers.set('Authorization', `Bearer ${this.tmdbReadToken()}`);
    } else {
        params.append('api_key', this.tmdbApiKey());
    }
    
    const movieUrl = `https://api.themoviedb.org/3/genre/movie/list?${params.toString()}`;
    const tvUrl = `https://api.themoviedb.org/3/genre/tv/list?${params.toString()}`;
    
    this.http.get<any>(movieUrl, { headers }).pipe(catchError(() => of({genres: []}))).subscribe(data => this.tmdbGenres.update(g => ({...g, movie: data.genres})));
    this.http.get<any>(tvUrl, { headers }).pipe(catchError(() => of({genres: []}))).subscribe(data => this.tmdbGenres.update(g => ({...g, tv: data.genres})));
  }

  searchTmdb(query: string) { this.searchTerms.next(query); }

  selectTmdbItem(item: any) {
    const current = this.selectedElement();
    if (!current) return;
    const newItemType = current.tmdbItemType;
    if (current.linkGroup) {
        this.propagateTmdbId(current.linkGroup, item.id, newItemType);
    } else {
        this.updateElementProperty('tmdbId', item.id);
        this.fetchTmdbDataForElement(current.id);
    }
    this.tmdbSearchResults.set([]);
  }

  propagateTmdbId(groupName: string, tmdbId: string, itemType: TmdbItemType, excludeElementId?: string) {
      this.elements.update(els => els.map(el => {
          if (el.linkGroup === groupName && el.id !== excludeElementId) {
              return { ...el, tmdbId: tmdbId, tmdbItemType: itemType, tmdbData: null }; 
          }
          return el;
      }));
      this.elements().forEach(el => {
          if (el.linkGroup === groupName && el.id !== excludeElementId) this.fetchTmdbDataForElement(el.id);
      });
      if (!excludeElementId) this.saveStateToHistory();
  }

  fetchTmdbDataForElement(id: string, isInitial = false) {
    const element = this.elements().find(el => el.id === id);
    if (!element || !this.isApiConfigured() || (isInitial && element.tmdbData)) return;

    let headers = new HttpHeaders({'Content-Type': 'application/json;charset=utf-8'});
    const params = new URLSearchParams({ language: this.language(), include_adult: this.includeAdult().toString() });
    
    if (this.authMethod() === 'v4') {
        headers = headers.set('Authorization', `Bearer ${this.tmdbReadToken()}`);
    } else {
        params.append('api_key', this.tmdbApiKey());
    }

    let obs: Observable<any>;
    
    if (element.tmdbId && element.tmdbItemType) {
        const append = [
            'credits', 'images', 'videos', 'content_ratings', 'release_dates', 
            'keywords', 'external_ids', 'recommendations', 'similar', 'reviews', 
            'lists', 'translations', 'watch/providers'
        ].join(',');
        
        params.append('append_to_response', append);
        obs = this.http.get(`https://api.themoviedb.org/3/${element.tmdbItemType}/${element.tmdbId}?${params.toString()}`, { headers });
    } else if (element.tmdbEndpoint) {
        if (element.tmdbEndpoint.startsWith('discover')) {
          params.append('sort_by', element.discoverFilters.sortBy);
          if (element.discoverFilters.genres.length > 0) params.append('with_genres', element.discoverFilters.genres.join(','));
          const yearKey = element.tmdbCollectionType === 'movie' ? 'primary_release_year' : 'first_air_date_year';
          if (element.discoverFilters.year) params.append(yearKey, element.discoverFilters.year.toString());
        }
        params.append('watch_region', this.watchRegion());
        obs = this.http.get(`https://api.themoviedb.org/3/${element.tmdbEndpoint}?${params.toString()}`, { headers });
    } else { return; }
    
    obs.pipe(catchError(() => of(null))).subscribe(data => {
      if (!data) return;
      this.elements.update(els => els.map(el => el.id === id ? {...el, tmdbData: data} : el));
      if (element.type === 'tmdb-backdrop-slideshow') this.setupSlideshow(id);
      if (element.type === 'tmdb-poster-scroll') this.setupPosterScroll(id);
      this.cdr.detectChanges();
    });
  }
  
  // Dynamic Data Path Resolver (e.g. "credits.cast.0.name")
  resolveDataPath(data: any, path: string): string {
      if (!data || !path) return '';
      try {
          const parts = path.split('.');
          let current = data;
          for (const part of parts) {
              if (current === undefined || current === null) return '';
              current = current[part];
          }
          if (typeof current === 'object') return JSON.stringify(current);
          return String(current);
      } catch (e) { return ''; }
  }
  
  setupPosterScroll(elementId: string) {
      if (this.posterScrollIntervals.has(elementId)) clearInterval(this.posterScrollIntervals.get(elementId));
      
      // Simple auto-scroll simulation for editor
      const interval = setInterval(() => {
          const el = document.getElementById(elementId);
          if (el && el.firstElementChild) {
              const container = el.firstElementChild as HTMLElement;
              if(container.scrollLeft >= (container.scrollWidth - container.clientWidth)) {
                  container.scrollLeft = 0;
              } else {
                  container.scrollLeft += 1;
              }
          }
      }, 30);
      this.posterScrollIntervals.set(elementId, interval);
  }
  
  setupSlideshow(elementId: string) {
    if (this.slideshowIntervals.has(elementId)) clearInterval(this.slideshowIntervals.get(elementId));
    
    const element = this.elements().find(e => e.id === elementId);
    if (!element?.tmdbData?.results) return;

    const items = element.tmdbData.results;
    const backdrops = items.map((item: any) => item.backdrop_path).filter(Boolean).slice(0, 20).map((path: string) => 'https://image.tmdb.org/t/p/w1280' + path);
    if (backdrops.length < 2) return;

    this.slideshowState.update(s => ({...s, [elementId]: { idx1: 0, idx2: 1, fade: false, backdrops, items }}));
    
    const interval = setInterval(() => {
        this.slideshowState.update(s => {
            const current = s[elementId];
            if (!current) return s;
            return {...s, [elementId]: { ...current, fade: true } };
        });
        this.cdr.detectChanges();

        const el = this.elements().find(e => e.id === elementId);
        const state = this.slideshowState()[elementId];
        if (el && el.linkGroup && state.items && state.items.length > state.idx2) {
            const nextItem = state.items[state.idx2]; 
            if (nextItem) {
                 const itemType = nextItem.media_type || el.tmdbCollectionType || 'movie';
                 this.propagateTmdbId(el.linkGroup, nextItem.id, itemType as TmdbItemType, elementId);
            }
        }
        
        setTimeout(() => {
            this.slideshowState.update(s => {
                const current = s[elementId];
                if (!current) return s;
                return {...s, [elementId]: { ...current, idx1: current.idx2, fade: false } };
            });
            this.cdr.detectChanges();
            
            setTimeout(() => {
                 this.slideshowState.update(s => {
                    const current = s[elementId];
                    if (!current) return s;
                    const nextNextIdx = (current.idx2 + 1) % current.backdrops.length;
                    return {...s, [elementId]: { ...current, idx2: nextNextIdx } };
                 });
                 this.cdr.detectChanges();
            }, 900);
        }, 1100);

    }, 5000);
    this.slideshowIntervals.set(elementId, interval);
  }

  // --- UI & INTERACTION ---
  private setupInteract() {
    if (typeof interact === 'undefined') return;
    
    const snapModifiers = [
        interact.modifiers.snap({ targets: [], range: Infinity, relativePoints: [{ x: 0.5, y: 0.5 }] }),
        interact.modifiers.restrictRect({ restriction: 'parent', endOnly: false })
    ];

    interact('.draggable-element').unset();
    interact('.draggable-element').draggable({
      listeners: {
        move: (event: any) => {
          const scale = this.canvasConfig().scale; 
          const target = event.target;
          const currentDataX = (parseFloat(target.getAttribute('data-x')) || 0);
          const currentDataY = (parseFloat(target.getAttribute('data-y')) || 0);
          const x = currentDataX + (event.dx / scale);
          const y = currentDataY + (event.dy / scale);
          
          const element = this.elements().find(el => el.id === target.id);
          const rotation = element?.rotation || 0;
          
          target.style.transform = `translate(${x}px, ${y}px) rotate(${rotation}deg)`;
          target.setAttribute('data-x', x);
          target.setAttribute('data-y', y);
        },
        end: (event: any) => {
          const target = event.target;
          const element = this.elements().find(el => el.id === target.id);
          if (element) {
            const xOffset = (parseFloat(target.getAttribute('data-x')) || 0);
            const yOffset = (parseFloat(target.getAttribute('data-y')) || 0);
            const newX = element.x + xOffset;
            const newY = element.y + yOffset;
            
            this.updateElementProperty('x', newX, true);
            this.updateElementProperty('y', newY, true);
            
            target.style.transform = `rotate(${element.rotation}deg)`;
            target.removeAttribute('data-x');
            target.removeAttribute('data-y');
            this.saveStateToHistory();
          }
        }
      },
      modifiers: snapModifiers,
      inertia: false
    }).resizable({
      edges: { left: true, right: true, bottom: true, top: true },
      listeners: {
        move: (event: any) => {
          const id = event.target.id;
          const scale = this.canvasConfig().scale; 
          this.elements.update(els =>
            els.map(el => {
              if (el.id === id) {
                return { 
                    ...el, 
                    width: Math.max(20, el.width + (event.deltaRect.width / scale)), 
                    height: Math.max(20, el.height + (event.deltaRect.height / scale)), 
                    x: el.x + (event.deltaRect.left / scale), 
                    y: el.y + (event.deltaRect.top / scale), 
                };
              }
              return el;
            })
          );
        },
        end: () => this.saveStateToHistory()
      },
      modifiers: [interact.modifiers.restrictSize({ min: { width: 20, height: 20 } })],
      inertia: false
    });
  }

  openContextMenu(event: MouseEvent, elementId: string) {
    event.preventDefault(); event.stopPropagation();
    this.selectElement(elementId);
    const menuWidth = 200;
    const menuHeight = 300;
    const x = event.clientX + menuWidth > window.innerWidth ? window.innerWidth - menuWidth - 10 : event.clientX;
    const y = event.clientY + menuHeight > window.innerHeight ? window.innerHeight - menuHeight - 10 : event.clientY;
    this.contextMenu.set({ visible: true, x, y, elementId });
  }

  duplicateElement(id: string) {
    const elToDup = this.elements().find(el => el.id === id);
    if (!elToDup) return;
    const newEl: CanvasElement = { ...JSON.parse(JSON.stringify(elToDup)), id: `el_${Date.now()}`, x: elToDup.x + 20, y: elToDup.y + 20, zIndex: this.elements().length + 1 };
    this.elements.update(els => [...els, newEl]);
    this.selectElement(newEl.id);
    this.saveStateToHistory();
  }

  copyStyles(id: string) { const el = this.elements().find(e => e.id === id); if (el) this.copiedStyles.set(JSON.parse(JSON.stringify(el.styles))); }
  pasteStyles(id: string) { const styles = this.copiedStyles(); if (!styles) return; this.elements.update(els => els.map(el => el.id === id ? { ...el, styles: { ...el.styles, ...styles } } : el)); this.saveStateToHistory(); }

  alignElement(id: string, type: 'fill' | 'fitW' | 'fitH' | 'center' | 'centerH' | 'centerV' | 'top' | 'bottom' | 'left' | 'right') {
    const { width, height } = this.canvasConfig();
    this.elements.update(els => els.map(el => {
      if (el.id !== id) return el;
      switch(type) {
        case 'fill': return { ...el, x: 0, y: 0, width: width, height: height };
        case 'fitW': return { ...el, x: 0, width: width };
        case 'fitH': return { ...el, y: 0, height: height };
        case 'center': return { ...el, x: (width - el.width) / 2, y: (height - el.height) / 2 };
        case 'centerH': return { ...el, x: (width - el.width) / 2 };
        case 'centerV': return { ...el, y: (height - el.height) / 2 };
        case 'top': return { ...el, y: 0 };
        case 'bottom': return { ...el, y: height - el.height };
        case 'left': return { ...el, x: 0 };
        case 'right': return { ...el, x: width - el.width };
      }
      return el;
    }));
    this.saveStateToHistory();
    this.contextMenu.update(cm => ({ ...cm, visible: false }));
  }
  
  formatTypeName(type: string): string { return type.replace('tmdb-', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); }
  
  getBestLogo(element: CanvasElement): string | null {
    const logos = element.tmdbData?.images?.logos;
    if (!logos || logos.length === 0) return null;
    const langLogo = logos.find((l: any) => l.iso_639_1 === this.language().substring(0,2));
    const englishLogo = logos.find((l: any) => l.iso_639_1 === 'en');
    const chosenLogo = langLogo || englishLogo || logos[0];
    return 'https://image.tmdb.org/t/p/w500' + chosenLogo.file_path;
  }

  getBestNetworkLogo(element: CanvasElement): string | null {
      const networks = element.tmdbData?.networks;
      if (!networks || networks.length === 0) return null;
      return 'https://image.tmdb.org/t/p/w300' + networks[0].logo_path;
  }
  
  hexToRgba(hex: string, alpha: number): string {
      let r = 0, g = 0, b = 0;
      if (hex.length === 4) {
          r = parseInt('0x' + hex[1] + hex[1]);
          g = parseInt('0x' + hex[2] + hex[2]);
          b = parseInt('0x' + hex[3] + hex[3]);
      } else if (hex.length === 7) {
          r = parseInt('0x' + hex[1] + hex[2]);
          g = parseInt('0x' + hex[3] + hex[4]);
          b = parseInt('0x' + hex[5] + hex[6]);
      }
      return `rgba(${r},${g},${b},${alpha})`;
  }
  
  // --- PHP EXPORT ---
  updatePhpCode() { this.generatedPhpCode.set(this.generatePHP()); }

  generatePHP(): string {
    if (!this.isApiConfigured()) return '<!-- Error: Configure TMDB API Key (v3) or Token (v4) to generate code -->';
    
    const { width, height } = this.canvasConfig();
    const config = { 
        authMethod: this.authMethod(),
        apiKey: this.tmdbApiKey(),
        token: this.tmdbReadToken(), 
        lang: this.language(), 
        region: this.watchRegion(), 
        adult: this.includeAdult() 
    };

    // 1. Generate CSS
    const cssRules = this.elements()
        .filter(el => el.visible)
        .map(el => {
            const s = el.styles;
            const leftPct = (el.x / width) * 100;
            const topPct = (el.y / height) * 100;
            const widthPct = (el.width / width) * 100;
            const heightPct = (el.height / height) * 100;
            const fontSizeVw = (s.fontSize / width) * 100;
            const bgRgba = this.hexToRgba(s.backgroundColor, s.backgroundOpacity ?? 1);

            let props = [
                `position: absolute`,
                `top: ${topPct.toFixed(2)}%`,
                `left: ${leftPct.toFixed(2)}%`,
                `width: ${widthPct.toFixed(2)}%`,
                `height: ${heightPct.toFixed(2)}%`,
                `z-index: ${el.zIndex}`,
                `background-color: ${bgRgba}`,
                `color: ${s.color}`,
                `font-family: '${s.fontFamily}', sans-serif`,
                `font-size: ${fontSizeVw.toFixed(2)}vw`,
                `font-weight: ${s.fontWeight}`,
                `text-align: ${s.textAlign}`,
                `border-radius: ${s.borderRadius}px`,
                `border: ${s.borderWidth}px solid ${s.borderColor}`,
                `opacity: ${s.opacity}`,
                `box-sizing: border-box`,
                `overflow: hidden`
            ];

            if (el.rotation) props.push(`transform: rotate(${el.rotation}deg)`);
            if (s.backgroundGradient) props.push(`background-image: linear-gradient(${s.backgroundGradient.angle}deg, ${s.backgroundGradient.from}, ${s.backgroundGradient.to})`);
            if (s.boxShadow) props.push(`box-shadow: ${s.boxShadow.x}px ${s.boxShadow.y}px ${s.boxShadow.blur}px ${s.boxShadow.color}`);
            if (s.textShadow) props.push(`text-shadow: ${s.textShadow.x}px ${s.textShadow.y}px ${s.textShadow.blur}px ${s.textShadow.color}`);
            
            const filters = [];
            if (s.filterBlur > 0) filters.push(`blur(${s.filterBlur}px)`);
            if (s.filterGrayscale > 0) filters.push(`grayscale(${s.filterGrayscale * 100}%)`);
            if (filters.length > 0) {
                props.push(`backdrop-filter: ${filters.join(' ')}`);
                props.push(`-webkit-backdrop-filter: ${filters.join(' ')}`);
            }

            return `    /* ${this.formatTypeName(el.type)} */\n    #${el.id} {\n        ${props.join(';\n        ')};\n    }`;
        }).join('\n\n');

    // 2. Generate HTML
    const htmlElements = this.elements()
        .filter(el => el.visible)
        .map(el => {
            let dataAttrs = `data-type="${el.type}"`;
            if (el.tmdbId) dataAttrs += ` data-tmdb-id="${el.tmdbId}"`;
            dataAttrs += ` data-item-type="${el.tmdbItemType}"`;
            if (el.tmdbEndpoint) dataAttrs += ` data-tmdb-endpoint="${el.tmdbEndpoint.replace(/"/g, '&quot;')}"`;
            if (el.tmdbEndpoint?.startsWith('discover')) {
                dataAttrs += ` data-discover-filters="${encodeURIComponent(JSON.stringify(el.discoverFilters))}"`;
            }
            dataAttrs += ` data-image-fit="${el.imageFit || 'cover'}"`;
            
            // Dynamic Field Attributes
            if (el.type === 'tmdb-dynamic-field') {
                dataAttrs += ` data-data-path="${el.dataPath || ''}"`;
                if(el.dataPrefix) dataAttrs += ` data-data-prefix="${el.dataPrefix}"`;
                if(el.dataSuffix) dataAttrs += ` data-data-suffix="${el.dataSuffix}"`;
            }

            const imgStyle = `width:100%;height:100%;object-fit:${el.imageFit || 'cover'};border-radius:${el.styles.borderRadius}px;`;
            
            let content = '';
            if (el.type === 'text') content = el.content;
            else if (el.type === 'image') content = `<img src="${el.content}" style="${imgStyle}" alt="Image">`;
            
            // Wrapper for scrollable elements
            if (el.type === 'tmdb-poster-scroll') {
                 return `        <!-- ${this.formatTypeName(el.type)} -->\n        <div id="${el.id}" ${dataAttrs}>\n            <div class="poster-scroll-container" style="display:flex; gap:10px; overflow-x:hidden; height:100%;"></div>\n        </div>`;
            }
            
            return `        <!-- ${this.formatTypeName(el.type)} -->\n        <div id="${el.id}" ${dataAttrs}>\n            ${content}\n        </div>`;
        }).join('\n\n');

    // 3. Generate JavaScript (Support both v3 Key and v4 Token)
    const jsScript = `
    /**
     * TMDB Dynamic Layout Script
     * Handles data fetching via v3 API Key or v4 Bearer Token.
     */
    const config = <?php echo json_encode($config); ?>;
    const baseImgUrl = 'https://image.tmdb.org/t/p/w500';
    const baseBackdropUrl = 'https://image.tmdb.org/t/p/w1280';

    // Helper: Resolve Dot Notation
    function resolveDataPath(data, path) {
        if (!data || !path) return '';
        try {
            const parts = path.split('.');
            let current = data;
            for (const part of parts) {
                if (current === undefined || current === null) return '';
                current = current[part];
            }
            if (typeof current === 'object') return JSON.stringify(current);
            return String(current);
        } catch (e) { return ''; }
    }

    // Helper: Fetch JSON data with dynamic auth
    async function fetchData(url) {
        try {
            const headers = {
                'Content-Type': 'application/json;charset=utf-8'
            };
            
            // Append auth method
            let fetchUrl = new URL(url);
            if (config.authMethod === 'v3') {
                fetchUrl.searchParams.append('api_key', config.apiKey);
            } else {
                headers['Authorization'] = 'Bearer ' + config.token;
            }

            const r = await fetch(fetchUrl.toString(), { headers });
            return r.ok ? await r.json() : null;
        } catch (e) {
            console.error('Fetch error:', e);
            return null;
        }
    }

    // Helper: Get best available logo
    function getBestLogo(logos, lang) {
        if (!logos || logos.length === 0) return null;
        const langLogo = logos.find(l => l.iso_639_1 === lang.substring(0, 2));
        const enLogo = logos.find(l => l.iso_639_1 === 'en');
        const logo = langLogo || enLogo || logos[0];
        return baseImgUrl + (logo?.file_path || '');
    }
    
    // Helper: Auto Scroll
    function startPosterAutoScroll(element) {
        let scrollSpeed = 0.5; // pixels per frame
        function step() {
            if(element.scrollLeft >= (element.scrollWidth - element.clientWidth)) {
                // Reset or pause at end? Let's reset smoothly
                setTimeout(() => { element.scrollLeft = 0; }, 1000);
            } else {
                element.scrollLeft += scrollSpeed;
            }
            requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const elements = document.querySelectorAll('[data-type^="tmdb-"]');
        
        elements.forEach(el => {
            const { type, tmdbId, itemType, tmdbEndpoint, discoverFilters, imageFit, dataPath, dataPrefix, dataSuffix } = el.dataset;
            const imgStyle = \`width:100%;height:100%;object-fit:\${imageFit || 'cover'}\`;

            // Construct API URL
            let url;
            const p = new URLSearchParams({ 
                language: config.lang, 
                include_adult: config.adult 
            });

            if (tmdbId && itemType) {
                // Fetch specific Movie/TV Show with ALL available append data
                p.append('append_to_response', 'credits,images,videos,content_ratings,release_dates,keywords,external_ids,recommendations,similar,reviews,lists,translations,watch/providers');
                url = \`https://api.themoviedb.org/3/\${itemType}/\${tmdbId}?\${p.toString()}\`;
            } else if (tmdbEndpoint) {
                // Fetch Collection / Discovery
                if (tmdbEndpoint.startsWith('discover') && discoverFilters) {
                    const filters = JSON.parse(decodeURIComponent(discoverFilters));
                    p.append('sort_by', filters.sortBy);
                    if (filters.genres && filters.genres.length > 0) p.append('with_genres', filters.genres.join(','));
                    
                    const yearKey = itemType === 'movie' ? 'primary_release_year' : 'first_air_date_year';
                    if (filters.year) p.append(yearKey, filters.year.toString());
                }
                p.append('watch_region', config.region);
                url = \`https://api.themoviedb.org/3/\${tmdbEndpoint}?\${p.toString()}\`;
            } else {
                return; // No valid data source
            }

            // Fetch and Update UI
            fetchData(url).then(data => {
                if (!data) return;
                
                const isSingleItem = !!tmdbId;
                const results = isSingleItem ? [data] : (data.results || []);
                const item = results[0]; // Primary item for single displays
                
                if (!item && isSingleItem) return;

                // Render Content based on Type
                switch (type) {
                    case 'tmdb-dynamic-field':
                        const val = resolveDataPath(item, dataPath);
                        if (val) el.innerText = (dataPrefix || '') + val + (dataSuffix || '');
                        else el.innerText = '';
                        break;

                    case 'tmdb-poster':
                        if(item.poster_path) el.innerHTML = \`<img src="\${baseImgUrl + item.poster_path}" style="\${imgStyle}" alt="Poster">\`; 
                        break;
                    case 'tmdb-backdrop':
                        if(item.backdrop_path) el.innerHTML = \`<img src="\${baseBackdropUrl + item.backdrop_path}" style="\${imgStyle}" alt="Backdrop">\`; 
                        break;
                    case 'tmdb-logo':
                        const logoUrl = getBestLogo(item.images?.logos, config.lang);
                        if (logoUrl) el.innerHTML = \`<img src="\${logoUrl}" style="\${imgStyle}" alt="Logo">\`;
                        break;
                    case 'tmdb-title': 
                        el.innerText = item.title || item.name; 
                        break;
                    case 'tmdb-overview': 
                        el.innerText = item.overview; 
                        break;
                    case 'tmdb-tagline': 
                        el.innerText = item.tagline; 
                        break;
                    case 'tmdb-release-date': 
                        el.innerText = item.release_date || item.first_air_date; 
                        break;
                    case 'tmdb-runtime':
                        const rt = item.runtime || (item.episode_run_time && item.episode_run_time[0]);
                        if(rt) el.innerText = \`\${rt} min\`;
                        break;
                    case 'tmdb-season-episode-count':
                        if (item.number_of_seasons) el.innerHTML = \`<span>\${item.number_of_seasons} S</span><span class="mx-2 opacity-50">|</span><span>\${item.number_of_episodes} E</span>\`;
                        break;
                    case 'tmdb-network-logo':
                        if (item.networks && item.networks.length > 0 && item.networks[0].logo_path) 
                            el.innerHTML = \`<img src="\${baseImgUrl + item.networks[0].logo_path}" style="\${imgStyle}" alt="Network">\`;
                        break;
                    case 'tmdb-rating':
                        const rating = Math.round(item.vote_average / 2);
                        el.innerHTML = Array(5).fill(0).map((_, j) => \`<span class="\${j < rating ? 'star-filled' : 'star-empty'}">★</span>\`).join('');
                        break;
                    case 'tmdb-genres':
                        if (item.genres) el.innerHTML = item.genres.map(g => \`<span class="genre-pill">\${g.name}</span>\`).join('');
                        break;
                    
                    // Collections
                    case 'tmdb-poster-scroll':
                        const container = el.querySelector('.poster-scroll-container');
                        if(container) {
                            results.forEach(m => { 
                                if (m.poster_path) container.innerHTML += \`<img src="\${baseImgUrl + m.poster_path}" class="scroll-img" alt="\${m.title || m.name}">\`;
                            });
                            startPosterAutoScroll(container);
                        }
                        break;
                    
                    case 'tmdb-cast':
                        el.style.display = 'flex';
                        el.style.gap = '10px';
                        el.style.overflowX = 'auto';
                        el.style.textAlign = 'center';
                        if (item.credits && item.credits.cast) {
                            item.credits.cast.slice(0, 15).forEach(c => {
                                if (c.profile_path) el.innerHTML += \`<div class="cast-member"><img src="\${baseImgUrl + c.profile_path}" alt="\${c.name}"><p>\${c.name}</p></div>\`;
                            });
                        }
                        break;
                    
                    case 'tmdb-backdrop-slideshow':
                        const backdrops = results.map(m => m.backdrop_path).filter(Boolean);
                        if (backdrops.length > 0) {
                            let currentIdx = 0;
                            const paths = backdrops.map(p => baseBackdropUrl + p);
                            
                            // Set initial
                            el.style.backgroundImage = \`url(\${paths[0]})\`;
                            el.style.backgroundSize = 'cover';
                            el.style.backgroundPosition = 'center';
                            el.style.transition = 'background-image 1s ease-in-out';
                            
                            if (paths.length > 1) {
                                setInterval(() => {
                                    currentIdx = (currentIdx + 1) % paths.length;
                                    el.style.backgroundImage = \`url(\${paths[currentIdx]})\`;
                                }, 5000);
                            }
                        }
                        break;
                }
            });
        });
    });
    `;

    // 4. Combine into PHP file structure
    return `<?php
/**
 * TMDB Dynamic Layout
 * Generated by TMDB Layout Editor V4
 * Date: ${new Date().toISOString().split('T')[0]}
 */

// Configuration
$config = array(
    "authMethod" => "${config.authMethod}",
    "apiKey" => "${config.apiKey}",
    "token" => "${config.token}",
    "lang" => "${config.lang}",
    "region" => "${config.region}",
    "adult" => ${config.adult ? 'true' : 'false'}
);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>TMDB Dynamic Layout</title>
    
    <!-- Google Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;700&family=Montserrat:wght@400;500;600;700&family=Lato:wght@400;700&family=Oswald:wght@400;500;600;700&display=swap" rel="stylesheet">

    <style>
    /* --- Base Reset --- */
    body {
        margin: 0;
        background-color: #0d253f; /* TMDB Dark Blue */
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        font-family: 'Inter', sans-serif;
    }

    #canvas {
        position: relative;
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
    }

    /* --- Element Styles --- */
${cssRules}

    /* --- Utility Classes for Dynamic Content --- */
    .genre-pill {
        background: linear-gradient(90deg, #90cea1 0%, #01b4e4 100%);
        color: #0d253f;
        padding: 0.2em 0.6em;
        border-radius: 99px;
        margin-right: 0.3em;
        font-size: 0.9em;
        font-weight: 700;
        display: inline-block;
    }
    
    .star-filled { color: #01b4e4; }
    .star-empty { color: #1b3a57; }

    .scroll-img {
        height: 100%;
        width: auto;
        border-radius: 4px;
        flex-shrink: 0;
    }

    .cast-member {
        flex-shrink: 0;
        width: 18%;
    }
    .cast-member img {
        width: 100%;
        aspect-ratio: 1/1;
        object-fit: cover;
        border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.1);
    }
    .cast-member p {
        font-size: 0.9em;
        margin: 4px 0 0 0;
        white-space: normal;
        line-height: 1.2;
        color: inherit;
    }
    
    /* Hide scrollbars in scroll containers for clean look */
    .poster-scroll-container::-webkit-scrollbar {
        display: none;
    }
    .poster-scroll-container {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
    </style>
</head>
<body>

    <div id="canvas">
${htmlElements}
    </div>

    <script>
${jsScript}
    </script>

</body>
</html>`;
  }

  downloadPhpFile() {
    const blob = new Blob([this.generatedPhpCode()], { type: 'application/x-php' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'layout.php';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }
}
