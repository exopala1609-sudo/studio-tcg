// Filtres photo : appliqués aux pixels de l'image (canvas), pour qu'ils apparaissent aussi
// dans les exports PNG / Tabletop (html2canvas ignore les filtres CSS). La photo d'origine
// n'est jamais modifiée : la carte ne garde que les réglages du filtre.

const FILTER_PRESETS = {
    none:      { label: 'Aucun' },
    taverne:   { label: 'Taverne' },
    ambre:     { label: 'Ambre' },
    gravure:   { label: 'Gravure' },
    parchemin: { label: 'Parchemin' },
    nuit:      { label: 'Nuit' },
    vif:       { label: 'Vif' }
};

const DEFAULT_FILTER = { preset: 'none', strength: 100, brightness: 0, contrast: 0, saturation: 0 };

let currentFilter = null;   // réglages de la carte en cours ; null = filtre par défaut du set

const filteredCache = new Map();   // clé -> image traitée (data URL)
const filterPending = new Map();
let filterQueue = Promise.resolve();

// ---------- Réglages ----------
function normalizeFilter(f) {
    if (!f || typeof f !== 'object' || !FILTER_PRESETS[f.preset]) return null;
    const num = (v, min, max, def) => Number.isFinite(+v) ? Math.max(min, Math.min(max, +v)) : def;
    return {
        preset: f.preset,
        strength: num(f.strength, 0, 100, 100),
        brightness: num(f.brightness, -50, 50, 0),
        contrast: num(f.contrast, -50, 50, 0),
        saturation: num(f.saturation, -100, 100, 0)
    };
}

function isNeutralFilter(f) {
    return !f || (f.preset === 'none' && !f.brightness && !f.contrast && !f.saturation);
}

// Filtre réellement appliqué : celui de la carte, sinon celui de son set
function effectiveFilter(card) {
    const own = normalizeFilter(card.photoFilter);
    if (own) return isNeutralFilter(own) ? null : own;
    const setFilter = findSetForCard(card)?.filter;
    return setFilter && setFilter !== 'none' ? { ...DEFAULT_FILTER, preset: setFilter } : null;
}

function filterKey(src, f) {
    // Les images en base64 sont longues : on n'en garde qu'une empreinte pour la clé
    const id = src.length > 200 ? `${src.length}:${src.slice(-64)}` : src;
    return `${id}|${f.preset}|${f.strength}|${f.brightness}|${f.contrast}|${f.saturation}`;
}

// ---------- Traitement des pixels ----------
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
const lerp = (a, b, t) => a + (b - a) * t;

// Bruit fixe (même résultat sur tous les appareils et à chaque export)
function grainAt(i) {
    let x = (i * 2654435761) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
    return (x & 0xffff) / 0xffff - 0.5;
}

// Dégradé bichromie pour "Ambre" : brun profond -> cuivre -> ambre clair
const AMBER_STOPS = [[32, 15, 8], [160, 82, 30], [247, 205, 128]];

function applyPreset(preset, r, g, b, i, vig) {
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    switch (preset) {
        case 'taverne': {
            // sépia chaud, contraste marqué, coins assombris
            const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
            r = lerp(r, sr, 0.75); g = lerp(g, sg, 0.75); b = lerp(b, sb, 0.75);
            r = (r - 128) * 1.15 + 128; g = (g - 128) * 1.15 + 128; b = (b - 128) * 1.15 + 128;
            const v = 1 - 0.38 * vig;
            return [r * v, g * v, b * v];
        }
        case 'ambre': {
            let t = L / 255;
            t = t * t * (3 - 2 * t);   // courbe en S : plus de relief
            const [a, m, c] = AMBER_STOPS;
            const col = t < 0.5 ? [0, 1, 2].map(k => lerp(a[k], m[k], t * 2)) : [0, 1, 2].map(k => lerp(m[k], c[k], (t - 0.5) * 2));
            const v = 1 - 0.25 * vig;
            return [col[0] * v, col[1] * v, col[2] * v];
        }
        case 'gravure': {
            const y = clamp255((L - 128) * 1.6 + 128 + grainAt(i) * 36);
            return [y, y, y];
        }
        case 'parchemin': {
            const d = 0.65;
            r = lerp(r, L, d) + 18; g = lerp(g, L, d) + 8; b = lerp(b, L, d) - 14;
            r = (r - 128) * 0.88 + 140; g = (g - 128) * 0.88 + 136; b = (b - 128) * 0.88 + 124;
            const n = grainAt(i) * 16, v = 1 - 0.45 * vig;
            return [(r + n) * v, (g + n) * v, (b + n) * v];
        }
        case 'nuit': {
            const d = 0.55;
            r = lerp(r, L, d) * 0.72; g = lerp(g, L, d) * 0.84; b = lerp(b, L, d) * 1.08 + 12;
            r = (r - 110) * 1.12 + 105; g = (g - 110) * 1.12 + 105; b = (b - 110) * 1.12 + 110;
            const v = 1 - 0.3 * vig;
            return [r * v, g * v, b * v];
        }
        case 'vif': {
            r = lerp(L, r, 1.4); g = lerp(L, g, 1.4); b = lerp(L, b, 1.4);
            return [(r - 128) * 1.1 + 128, (g - 128) * 1.1 + 128, (b - 128) * 1.1 + 128];
        }
        default:
            return [r, g, b];
    }
}

function processPixels(imageData, f) {
    const { data, width, height } = imageData;
    const strength = f.strength / 100;
    const bright = f.brightness * 1.6;
    const contrast = 1 + f.contrast / 100;
    const sat = 1 + f.saturation / 100;
    const cx = width / 2, cy = height / 2, maxD = cx * cx + cy * cy;
    for (let y = 0, i = 0; y < height; y++) {
        const dy = (y - cy) * (y - cy);
        for (let x = 0; x < width; x++, i += 4) {
            const vig = ((x - cx) * (x - cx) + dy) / maxD;   // 0 au centre, 1 dans les coins
            let r = data[i], g = data[i + 1], b = data[i + 2];
            if (f.preset !== 'none' && strength > 0) {
                const [pr, pg, pb] = applyPreset(f.preset, r, g, b, i >> 2, vig);
                r = lerp(r, pr, strength); g = lerp(g, pg, strength); b = lerp(b, pb, strength);
            }
            if (sat !== 1) { const L = 0.299 * r + 0.587 * g + 0.114 * b; r = lerp(L, r, sat); g = lerp(L, g, sat); b = lerp(L, b, sat); }
            if (contrast !== 1) { r = (r - 128) * contrast + 128; g = (g - 128) * contrast + 128; b = (b - 128) * contrast + 128; }
            data[i] = clamp255(r + bright); data[i + 1] = clamp255(g + bright); data[i + 2] = clamp255(b + bright);
        }
    }
    return imageData;
}

function loadImageForCanvas(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';   // images Supabase (autorisées en CORS)
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function renderFiltered(src, f, maxSize = 1100) {
    const img = await loadImageForCanvas(src);
    const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.putImageData(processPixels(ctx.getImageData(0, 0, canvas.width, canvas.height), f), 0, 0);
    return canvas.toDataURL('image/jpeg', 0.9);
}

// Image filtrée en cache ; les calculs passent un par un pour ne pas figer l'écran
function requestFiltered(src, f) {
    const key = filterKey(src, f);
    if (filteredCache.has(key)) return Promise.resolve(filteredCache.get(key));
    if (!filterPending.has(key)) {
        const job = filterQueue.then(async () => {
            let out;
            try {
                out = await renderFiltered(src, f);
                // même proportions que l'originale
                if (imageRatioCache.has(src)) imageRatioCache.set(out, imageRatioCache.get(src));
            } catch (err) {
                console.warn('Filtre photo impossible, image d\'origine utilisée :', err);
                out = src;   // pas de boucle : on mémorise l'échec
            }
            if (filteredCache.size > 60) filteredCache.delete(filteredCache.keys().next().value);
            filteredCache.set(key, out);
            filterPending.delete(key);
            return out;
        });
        filterPending.set(key, job);
        filterQueue = job.catch(() => {});
    }
    return filterPending.get(key);
}

// Avant un export : l'image filtrée doit être prête
async function prepareCardImage(card) {
    if (!card.imageSrc) return;
    await getImageRatio(card.imageSrc);
    const f = effectiveFilter(card);
    if (f) await requestFiltered(card.imageSrc, f);
}

// ---------- Panneau "Filtre photo" du Studio ----------
let filterSliderTimer = null;
const thumbCache = new Map();   // aperçus miniatures : clé -> data URL

function renderFilterPanel() {
    const grid = document.getElementById('filterPresetGrid');
    if (!grid) return;
    const set = selectedSet();
    const setFilter = set?.filter && set.filter !== 'none' ? set.filter : null;
    const own = normalizeFilter(currentFilter);
    const activePreset = own ? own.preset : (setFilter ? '__set__' : 'none');

    grid.innerHTML = '';
    const options = [];
    if (setFilter) options.push({ value: '__set__', label: `Filtre du set`, sub: FILTER_PRESETS[setFilter].label, preset: setFilter });
    Object.entries(FILTER_PRESETS).forEach(([value, p]) => options.push({ value, label: p.label, preset: value }));

    options.forEach(opt => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'filter-chip' + (opt.value === activePreset ? ' selected' : '');
        b.setAttribute('aria-pressed', opt.value === activePreset);
        const thumb = document.createElement('span');
        thumb.className = 'filter-thumb';
        const label = document.createElement('span');
        label.className = 'filter-label';
        label.textContent = opt.sub ? `${opt.label} (${opt.sub})` : opt.label;
        b.append(thumb, label);
        b.onclick = () => chooseFilterPreset(opt.value);
        grid.appendChild(b);
        paintThumb(thumb, opt.preset);
    });

    // Réglages fins : visibles dès qu'un filtre propre à la carte est choisi
    const adv = document.getElementById('filterAdvanced');
    adv.hidden = !own;
    if (own) {
        ['strength', 'brightness', 'contrast', 'saturation'].forEach(k => {
            document.getElementById(`filter_${k}`).value = own[k];
            document.getElementById(`filter_${k}_val`).textContent = k === 'strength' ? `${own[k]} %` : (own[k] > 0 ? `+${own[k]}` : own[k]);
        });
        document.getElementById('filter_strength').disabled = own.preset === 'none';
    }
}

// Aperçu miniature de la photo avec chaque filtre
async function paintThumb(el, preset) {
    const src = currentImageSrc;
    if (!src) { el.classList.add(`thumb-${preset}`); return; }
    const key = `${src.length}:${src.slice(-48)}|${preset}`;
    if (!thumbCache.has(key)) {
        try {
            thumbCache.set(key, await renderFiltered(src, { ...DEFAULT_FILTER, preset }, 96));
        } catch (e) {
            thumbCache.set(key, src);
        }
    }
    if (src === currentImageSrc) el.style.backgroundImage = `url("${thumbCache.get(key)}")`;
}

function chooseFilterPreset(value) {
    if (value === '__set__') currentFilter = null;
    else {
        const base = normalizeFilter(currentFilter) || { ...DEFAULT_FILTER };
        currentFilter = { ...base, preset: value };
        // "Aucun" sans réglage : on garde explicitement "aucun filtre", même si le set en a un
    }
    renderFilterPanel();
    updateCard();
}

function onFilterSlider(key, el) {
    const base = normalizeFilter(currentFilter) || { ...DEFAULT_FILTER };
    currentFilter = { ...base, [key]: Number(el.value) };
    const v = Number(el.value);
    document.getElementById(`filter_${key}_val`).textContent = key === 'strength' ? `${v} %` : (v > 0 ? `+${v}` : v);
    // Le calcul de l'image se fait quand le curseur se pose (fluide même sur téléphone)
    clearTimeout(filterSliderTimer);
    filterSliderTimer = setTimeout(updateCard, 140);
}

function resetFilterAdjustments() {
    const base = normalizeFilter(currentFilter) || { ...DEFAULT_FILTER };
    currentFilter = { ...DEFAULT_FILTER, preset: base.preset };
    renderFilterPanel();
    updateCard();
}
