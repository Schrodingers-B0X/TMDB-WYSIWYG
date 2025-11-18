import { Component, ChangeDetectionStrategy, signal, effect, computed, inject, ChangeDetectorRef, HostListener, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { inject as vcinject } from '@vercel/analytics';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

vcinject();

// V3 Type definitions
interface Gradient { angle: number; from: string; to: string; }
interface Shadow { x: number; y: number; blur: number; color: string; }

interface CanvasElement {
  id: string;
  type: 'text' | 'image' | 'shape' | 'tmdb-poster' | 'tmdb-backdrop' | 'tmdb-title' | 'tmdb-overview' | 'tmdb-poster-scroll' | 'tmdb-backdrop-slideshow' | 'tmdb-tagline' | 'tmdb-release-date' | 'tmdb-runtime' | 'tmdb-genres' | 'tmdb-rating' | 'tmdb-cast' | 'tmdb-logo';
  x: number; y: number; width: number; height: number;
  zIndex: number; visible: boolean;
  content: string; // for text, image url
  styles: {
    backgroundColor: string; color: string; fontFamily: string; fontSize: number;
    fontWeight: '400' | '500' | '600' | '700'; textAlign: 'left' | 'center' | 'right';
    borderRadius: number; borderWidth: number; borderColor: string; opacity: number;
    backgroundGradient?: Gradient;
    boxShadow?: Shadow; textShadow?: Shadow;
    filterBlur: number; filterGrayscale: number;
  };
  tmdbId?: string;
  tmdbEndpoint?: 'movie/now_playing' | 'movie/popular' | 'movie/top_rated' | 'movie/upcoming';
  tmdbData?: any;
}

interface HistoryState { elements: CanvasElement[]; selectedElementId: string | null; }
interface ContextMenuState { visible: boolean; x: number; y: number; elementId: string | null; }

declare var interact: any;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, FormsModule]
})
export class AppComponent implements OnDestroy, AfterViewInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private slideshowIntervals: Map<string, any> = new Map();

  // State Signals
  elements = signal<CanvasElement[]>([]);
  selectedElementId = signal<string | null>(null);
  tmdbApiKey = signal<string>(localStorage.getItem('tmdbApiKey') || '');
  
  canvasSizePresets = {
    mobile: { width: 375, height: 667, scale: 1 },
    tablet: { width: 768, height: 1024, scale: 0.75 },
    tv: { width: 1920, height: 1080, scale: 0.4 },
  };
  selectedPreset = signal<'mobile' | 'tablet' | 'tv'>('mobile');
  canvasConfig = computed(() => this.canvasSizePresets[this.selectedPreset()]);
  
  history = signal<HistoryState[]>([]);
  historyIndex = signal<number>(-1);

  activeRightPanelTab = signal<'layers' | 'properties' | 'code'>('layers');
  previewMode = signal(false);
  
  fonts = ['Inter', 'Roboto', 'Montserrat', 'Lato', 'Oswald'];
  tmdbEndpoints = [
    { key: 'movie/now_playing', name: 'Now Playing' }, { key: 'movie/popular', name: 'Popular' },
    { key: 'movie/top_rated', name: 'Top Rated' }, { key: 'movie/upcoming', name: 'Upcoming' }
  ];

  selectedElement = computed(() => this.elements().find(el => el.id === this.selectedElementId()));
  generatedPhpCode = signal('');
  contextMenu = signal<ContextMenuState>({ visible: false, x: 0, y: 0, elementId: null });
  copiedStyles = signal<Partial<CanvasElement['styles']> | null>(null);
  slideshowState = signal<{[id: string]: {idx1: number, idx2: number, fade: boolean, backdrops: string[]}}>({});

  constructor() {
    effect(() => {
      localStorage.setItem('tmdbApiKey', this.tmdbApiKey());
      this.elements().forEach(el => this.fetchTmdbDataForElement(el.id, true));
    }, { allowSignalWrites: true });

    effect(() => this.updatePhpCode());
    this.saveStateToHistory();
  }
  
  ngAfterViewInit() { this.setupInteract(); }
  ngOnDestroy() { this.slideshowIntervals.forEach(interval => clearInterval(interval)); }

  @HostListener('window:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case 'z': event.preventDefault(); this.undo(); break;
        case 'y': event.preventDefault(); this.redo(); break;
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selectedElementId()) {
        event.preventDefault();
        this.deleteElement(this.selectedElementId()!);
      }
    }
  }

  @HostListener('document:click')
  onDocumentClick() { this.contextMenu.update(cm => ({ ...cm, visible: false })); }

  saveStateToHistory() {
    setTimeout(() => {
      const currentState: HistoryState = { elements: JSON.parse(JSON.stringify(this.elements())), selectedElementId: this.selectedElementId() };
      const lastState = this.history()[this.historyIndex()];
      if (JSON.stringify(lastState?.elements) === JSON.stringify(currentState.elements)) return;
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
      });
    }
  }

  addElement(type: CanvasElement['type']) {
    const newElement: CanvasElement = {
      id: `el_${Date.now()}`, type, x: 50, y: 50,
      width: type.includes('scroll') || type.includes('slideshow') ? 350 : (type.includes('backdrop') ? 300 : (type.includes('cast') ? 350 : (type === 'tmdb-logo' ? 120 : 150))),
      height: type.includes('text') || type.includes('title') || type.includes('tagline') ? 50 : (type.includes('backdrop') || type.includes('slideshow') ? 169 : (type.includes('cast') ? 100 : (type === 'tmdb-logo' ? 60 : 225))),
      zIndex: this.elements().length + 1, content: 'New Text', visible: true,
      styles: {
        backgroundColor: '#334155', color: '#f1f5f9', fontFamily: 'Inter',
        fontSize: 16, fontWeight: '400', textAlign: 'left', borderRadius: 8,
        borderWidth: 0, borderColor: '#f1f5f9', opacity: 1,
        filterBlur: 0, filterGrayscale: 0
      },
    };
    if (type === 'image') newElement.content = 'https://picsum.photos/200/300';
    if (type === 'shape') newElement.height = 100;
    this.elements.update(els => [...els, newElement]);
    this.selectElement(newElement.id);
    this.saveStateToHistory();
  }

  deleteElement(id: string) {
    this.elements.update(els => els.filter(el => el.id !== id));
    if (this.selectedElementId() === id) this.selectedElementId.set(null);
    if(this.slideshowIntervals.has(id)) { clearInterval(this.slideshowIntervals.get(id)); this.slideshowIntervals.delete(id); }
    this.saveStateToHistory();
  }

  selectElement(id: string | null, event?: MouseEvent) {
    this.selectedElementId.set(id);
    if(id) this.bringToFront(id, false);
  }
  
  deselectCanvas(event: MouseEvent) { if ((event.target as HTMLElement).id === 'canvas-bg') this.selectedElementId.set(null); }

  bringToFront(id: string, saveHistory = true) {
    const maxZ = Math.max(...this.elements().map(e => e.zIndex), 0);
    this.elements.update(els => els.map(el => el.id === id ? { ...el, zIndex: maxZ + 1 } : el));
    if(saveHistory) this.saveStateToHistory();
  }
  
  sendToBack(id: string, saveHistory = true) {
    const minZ = Math.min(...this.elements().map(e => e.zIndex), 0);
    this.elements.update(els => els.map(el => el.id === id ? { ...el, zIndex: minZ - 1 } : el));
    if (saveHistory) this.saveStateToHistory();
  }

  updateElementStyle(prop: keyof CanvasElement['styles'], value: any) { this.updateSelectedElement(el => { el.styles = { ...el.styles, [prop]: value }; }); }
  updateElementProperty(prop: keyof CanvasElement, value: any, noHistory = false) { this.updateSelectedElement(el => { (el as any)[prop] = value; }, noHistory); }
  
  private updateSelectedElement(updateFn: (el: CanvasElement) => void, noHistory = false) {
    const id = this.selectedElementId();
    if (!id) return;
    this.elements.update(els => els.map(el => {
      if (el.id === id) { const newEl = { ...el }; updateFn(newEl); return newEl; }
      return el;
    }));
    if(!noHistory) this.saveStateToHistory();
  }

  reorderLayer(draggedIndex: number, targetIndex: number) {
    this.elements.update(currentElements => {
      const draggedItem = currentElements[draggedIndex];
      const items = [...currentElements];
      items.splice(draggedIndex, 1);
      items.splice(targetIndex, 0, draggedItem);
      return items.map((item, index) => ({...item, zIndex: index + 1}));
    });
    this.saveStateToHistory();
  }

  toggleVisibility(id: string) {
    this.elements.update(els => els.map(el => el.id === id ? {...el, visible: !el.visible} : el));
    this.saveStateToHistory();
  }
  
  fetchTmdbDataForElement(id: string, isInitial = false) {
    const element = this.elements().find(el => el.id === id);
    if (!element || !this.tmdbApiKey() || (isInitial && element.tmdbData)) return;
    let obs: Observable<any>;
    if (element.tmdbId) {
        obs = this.http.get(`https://api.themoviedb.org/3/movie/${element.tmdbId}?api_key=${this.tmdbApiKey()}&append_to_response=credits,images`);
    } else if (element.tmdbEndpoint) {
        obs = this.http.get(`https://api.themoviedb.org/3/${element.tmdbEndpoint}?api_key=${this.tmdbApiKey()}`);
    } else { return; }
    
    obs.pipe(catchError(() => of(null))).subscribe(data => {
      if (!data) return;
      this.elements.update(els => els.map(el => el.id === id ? {...el, tmdbData: data} : el));
      if (element.type === 'tmdb-backdrop-slideshow' && element.tmdbEndpoint) {
        this.setupSlideshow(id);
      }
      this.cdr.detectChanges();
    });
  }
  
  setupSlideshow(elementId: string) {
    if (this.slideshowIntervals.has(elementId)) clearInterval(this.slideshowIntervals.get(elementId));
    
    const backdrops = this.getCollectionBackdrops(this.elements().find(e => e.id === elementId));
    if (backdrops.length < 2) return;

    this.slideshowState.update(s => ({...s, [elementId]: { idx1: 0, idx2: 1, fade: false, backdrops }}));
    
    const interval = setInterval(() => {
        const state = this.slideshowState()[elementId];
        if (state && state.backdrops.length > 1) {
            this.slideshowState.update(s => {
                const current = s[elementId];
                const nextIdx = (current.idx1 + 1) % current.backdrops.length;
                return {...s, [elementId]: { ...current, idx2: nextIdx, fade: true } };
            });
            this.cdr.detectChanges();
            
            setTimeout(() => {
                this.slideshowState.update(s => {
                    const current = s[elementId];
                    if (!current) return s;
                    const nextIdx = (current.idx2 + 1) % current.backdrops.length;
                    return {...s, [elementId]: { ...current, idx1: current.idx2, idx2: nextIdx, fade: false } };
                });
                this.cdr.detectChanges();
            }, 1000); // must match CSS transition duration
        }
    }, 5000);
    this.slideshowIntervals.set(elementId, interval);
  }

  private setupInteract() {
    if (typeof interact === 'undefined') return;
    interact('.draggable-element').unset();

    interact('.draggable-element').draggable({
      listeners: {
        move: (event: any) => {
          const target = event.target;
          const x = (parseFloat(target.getAttribute('data-x')) || 0) + event.dx;
          const y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy;
          target.style.transform = `translate(${x}px, ${y}px)`;
          target.setAttribute('data-x', x);
          target.setAttribute('data-y', y);
        },
        end: (event: any) => {
          const target = event.target;
          const element = this.elements().find(el => el.id === target.id);
          if (element) {
            const newX = element.x + (parseFloat(target.getAttribute('data-x')) || 0);
            const newY = element.y + (parseFloat(target.getAttribute('data-y')) || 0);
            this.updateElementProperty('x', newX, true);
            this.updateElementProperty('y', newY, true);
            target.style.transform = '';
            target.removeAttribute('data-x');
            target.removeAttribute('data-y');
            this.saveStateToHistory();
          }
        }
      },
      modifiers: [interact.modifiers.snap({ targets: [], range: Infinity, relativePoints: [{ x: 0.5, y: 0.5 }] }), interact.modifiers.restrictRect({ restriction: 'parent' })],
      inertia: false
    }).resizable({
      edges: { left: true, right: true, bottom: true, top: true },
      listeners: {
        move: (event: any) => {
          const id = event.target.id;
          this.elements.update(els =>
            els.map(el => {
              if (el.id === id) {
                return { ...el, width: event.rect.width, height: event.rect.height, x: el.x + event.deltaRect.left, y: el.y + event.deltaRect.top, };
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
    const menuWidth = 180, menuHeight = 250;
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

  alignElement(id: string, type: 'fill' | 'fitW' | 'fitH' | 'center' | 'top' | 'bottom' | 'left' | 'right') {
    const { width: cw, height: ch } = this.canvasConfig();
    this.elements.update(els => els.map(el => {
      if (el.id !== id) return el;
      switch(type) {
        case 'fill': return { ...el, x: 0, y: 0, width: cw, height: ch };
        case 'fitW': return { ...el, x: 0, width: cw };
        case 'fitH': return { ...el, y: 0, height: ch };
        case 'center': return { ...el, x: (cw - el.width) / 2, y: (ch - el.height) / 2 };
        case 'top': return { ...el, y: 0 };
        case 'bottom': return { ...el, y: ch - el.height };
        case 'left': return { ...el, x: 0 };
        case 'right': return { ...el, x: cw - el.width };
      }
      return el;
    }));
    this.saveStateToHistory();
  }
  
  updatePhpCode() { this.generatedPhpCode.set(this.generatePHP()); }

  private minifyJS(js: string): string {
    return js.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1') // remove comments
             .replace(/\s+/g, ' ') // collapse whitespace
             .trim();
  }

  // Template helper methods
  formatTypeName(type: string): string {
    return type.replace(/-/g, ' ');
  }

  getBestLogo(element: CanvasElement): string | null {
    const logos = element.tmdbData?.images?.logos;
    if (!logos || logos.length === 0) return null;
    const englishLogo = logos.find((l: any) => l.iso_639_1 === 'en');
    return 'https://image.tmdb.org/t/p/w500' + (englishLogo?.file_path || logos[0].file_path);
  }

  getCollectionBackdrops(element: CanvasElement | undefined): string[] {
    if (!element?.tmdbData?.results) return [];
    return element.tmdbData.results
      .map((movie: any) => movie.backdrop_path)
      .filter(Boolean)
      .slice(0, 20); // Limit to 20 to avoid performance issues
  }

  updateGradientProperty(property: keyof Gradient, value: string | number) {
    const el = this.selectedElement();
    if (!el || !el.styles.backgroundGradient) return;
    const newGradient = { ...el.styles.backgroundGradient, [property]: value };
    this.updateElementStyle('backgroundGradient', newGradient);
  }

  updateBoxShadowProperty(property: keyof Shadow, value: string | number) {
    const el = this.selectedElement();
    if (!el || !el.styles.boxShadow) return;
    const newShadow = { ...el.styles.boxShadow, [property]: value };
    this.updateElementStyle('boxShadow', newShadow);
  }

  generatePHP(): string {
    const apiKey = this.tmdbApiKey();
    if (!apiKey) return '<!-- Enter TMDB API Key to generate code -->';
    const { width, height } = this.canvasConfig();
    const styles = this.elements().filter(el => el.visible).map(el => {
        const s = el.styles;
        let styleString = `position:absolute;top:${el.y}px;left:${el.x}px;width:${el.width}px;height:${el.height}px;z-index:${el.zIndex};background-color:${s.backgroundColor};color:${s.color};font-family:'${s.fontFamily}',sans-serif;font-size:${s.fontSize}px;font-weight:${s.fontWeight};text-align:${s.textAlign};border-radius:${s.borderRadius}px;border:${s.borderWidth}px solid ${s.borderColor};opacity:${s.opacity};box-sizing:border-box;overflow:hidden;`;
        if(s.backgroundGradient) styleString += `background-image:linear-gradient(${s.backgroundGradient.angle}deg,${s.backgroundGradient.from},${s.backgroundGradient.to});`;
        if(s.boxShadow) styleString += `box-shadow:${s.boxShadow.x}px ${s.boxShadow.y}px ${s.boxShadow.blur}px ${s.boxShadow.color};`;
        if(s.textShadow) styleString += `text-shadow:${s.textShadow.x}px ${s.textShadow.y}px ${s.textShadow.blur}px ${s.textShadow.color};`;
        const filters = [];
        if(s.filterBlur > 0) filters.push(`blur(${s.filterBlur}px)`);
        if(s.filterGrayscale > 0) filters.push(`grayscale(${s.filterGrayscale * 100}%)`);
        if(filters.length > 0) styleString += `backdrop-filter:${filters.join(' ')};-webkit-backdrop-filter:${filters.join(' ')};`;
        return `#${el.id}{${styleString}}`;
    }).join('');

    const bodyHtml = this.elements().filter(el => el.visible).map(el => {
      let dataAttrs = `data-type="${el.type}"`;
      if (el.tmdbId) dataAttrs += ` data-tmdb-id="${el.tmdbId}"`;
      if (el.tmdbEndpoint) dataAttrs += ` data-tmdb-endpoint="${el.tmdbEndpoint}"`;
      let content = '';
      switch (el.type) {
          case 'text': content = el.content; break;
          case 'image': content = `<img src="${el.content}" style="width:100%;height:100%;object-fit:cover;" alt="User Image">`; break;
      }
      return `<div id="${el.id}" ${dataAttrs}>${content}</div>`;
    }).join('\n        ');

    const jsScript = `const apiKey="<?php echo $apiKey;?>";const baseImgUrl='https://image.tmdb.org/t/p/w500';const baseBackdropUrl='https://image.tmdb.org/t/p/w1280';async function fetchData(url){try{const r=await fetch(url);return r.ok?await r.json():null}catch(e){console.error('Fetch error:',e);return null}}
function getBestLogo(logos){if(!logos||logos.length===0)return null;const englishLogo=logos.find(l=>l.iso_639_1==='en');return baseImgUrl+(englishLogo?.file_path||logos[0].file_path)}
document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('[data-tmdb-id],[data-tmdb-endpoint]').forEach(el=>{const id=el.dataset.tmdbId,endpoint=el.dataset.tmdbEndpoint,type=el.dataset.type;let url;if(id){url=\`https://api.themoviedb.org/3/movie/\${id}?api_key=\${apiKey}&append_to_response=credits,images\`}else if(endpoint){url=\`https://api.themoviedb.org/3/\${endpoint}?api_key=\${apiKey}\`}else return;fetchData(url).then(data=>{if(!data)return;const d=id?data:data.results;switch(type){case'tmdb-poster':el.innerHTML=\`<img src="\${baseImgUrl+d.poster_path}" style="width:100%;height:100%;object-fit:cover;">\`;break;case'tmdb-backdrop':el.innerHTML=\`<img src="\${baseBackdropUrl+d.backdrop_path}" style="width:100%;height:100%;object-fit:cover;">\`;break;case'tmdb-logo':const logoUrl=getBestLogo(d.images?.logos);if(logoUrl){el.innerHTML=\`<img src="\${logoUrl}" style="width:100%;height:100%;object-fit:contain;">\`}break;case'tmdb-title':el.innerText=d.title;break;case'tmdb-overview':el.innerText=d.overview;break;case'tmdb-tagline':el.innerText=d.tagline;break;case'tmdb-release-date':el.innerText=d.release_date;break;case'tmdb-runtime':el.innerText=\`\${d.runtime} min\`;break;case'tmdb-rating':const r=Math.round(d.vote_average/2);el.innerHTML=Array(5).fill(0).map((_,i)=>i<r?'★':'☆').join('');break;case'tmdb-genres':el.innerHTML=d.genres.map(g=>\`<span style="background:rgba(255,255,255,0.2);padding:2px 8px;border-radius:99px;margin-right:4px;font-size:0.8em;">\${g.name}</span>\`).join('');break;case'tmdb-poster-scroll':el.style.cssText='overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scroll-snap-type:x mandatory;padding:5px;';d.forEach(m=>{el.innerHTML+=\`<img src="\${baseImgUrl+m.poster_path}" style="height:95%;width:auto;margin-right:10px;display:inline-block;scroll-snap-align:start;border-radius:4px;">\`});break;case'tmdb-cast':el.style.cssText='overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;scroll-snap-type:x mandatory;padding:5px;';d.credits.cast.slice(0,15).forEach(c=>{if(c.profile_path)el.innerHTML+=\`<div style="display:inline-block;width:80px;text-align:center;margin-right:10px;vertical-align:top;"><img src="\${baseImgUrl+c.profile_path}" style="width:100%;height:auto;border-radius:4px;"><p style="font-size:0.7em;margin:4px 0 0 0;white-space:normal;">\${c.name}</p></div>\`});break;case'tmdb-backdrop-slideshow':const backdrops=d.map(m=>m.backdrop_path).filter(Boolean);if(backdrops.length>0){let i=0;const b=backdrops.map(p=>baseBackdropUrl+p);el.style.backgroundImage=\`url(\${b[0]})\`;el.style.backgroundSize='cover';el.style.backgroundPosition='center';el.style.transition='background-image 1s ease-in-out';if(b.length>1)setInterval(()=>{i=(i+1)%b.length;el.style.backgroundImage=\`url(\${b[i]})\`},5000)}break}})})});`;

    return `<?php $apiKey = "${apiKey}"; ?>
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no"><title>TMDB Dynamic Layout</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;700&family=Montserrat:wght@400;500;600;700&family=Lato:wght@400;700&family=Oswald:wght@400;500;600;700&display=swap');body{margin:0;background-color:#0f172a;}#canvas{position:relative;width:${width}px;height:${height}px;margin:auto;overflow:hidden;}#canvas::-webkit-scrollbar{display:none;}${styles}</style>
</head><body><div id="canvas">${bodyHtml}</div><script>${this.minifyJS(jsScript)}</script></body></html>`;
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