// Carte : visuels SVG, données, rendu, proportions des images

// ---------- Visuels SVG (sans id => clonables sans conflit) ----------
function manaSVG(p) {
    return `<svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="50" fill="${p.b}" opacity=".18"/>
        <circle cx="50" cy="50" r="43" fill="${p.l}" opacity=".22"/>
        <polygon points="50,6 86,28 86,72 50,94 14,72 14,28" fill="none" stroke="${p.d}" stroke-width="8" stroke-linejoin="round"/>
        <polygon points="14,28 50,6 50,30 32,40" fill="${p.hi}"/>
        <polygon points="50,6 86,28 68,40 50,30" fill="${p.l}"/>
        <polygon points="86,28 86,72 68,60 68,40" fill="${p.b}"/>
        <polygon points="86,72 50,94 50,70 68,60" fill="${p.d}"/>
        <polygon points="50,94 14,72 32,60 50,70" fill="${p.d}"/>
        <polygon points="14,72 14,28 32,40 32,60" fill="${p.l}"/>
        <polygon points="50,30 68,40 68,60 50,70 32,60 32,40" fill="${p.b}"/>
        <polygon points="50,6 86,28 86,72 50,94 14,72 14,28" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round" opacity=".9"/>
        <polygon points="24,27 46,13 46,24" fill="#fff" opacity=".55"/>
    </svg>`;
}

// Verso de base : illustration du fût TCGBP, intégrée pour que la page reste autonome
const DEFAULT_BACK = 'assets/verso-tcgbp.webp';
let backImageSrc = '';

// ---------- Données ----------
function normalizeCard(c) {
    return {
        id: c.id || newId(),
        name: c.name ?? '',
        mana: c.mana ?? 0,
        manaColor: c.manaColor || 'light',
        type: TYPES[c.type] ? c.type : (LEGACY_TYPES[c.type] || 'hero'),
        rarity: RARITIES[c.rarity] ? c.rarity : 'common',
        element: c.element || c.theme || 'neutral',
        subtype: c.subtype ?? '',
        titleFont: c.titleFont || 'Merienda',
        setName: c.setName ?? '',
        hp: c.hp ?? '',
        spells: [0, 1].map(i => {
            const s = (Array.isArray(c.spells) && c.spells[i]) || {};
            return { name: s.name ?? '', dmg: s.dmg ?? '', text: s.text ?? '' };
        }),
        ability: c.ability ?? '',
        flavor: c.flavor ?? '',
        isFullArt: !!c.isFullArt,
        zoom: Number(c.zoom) || 100,
        offsetX: Number(c.offsetX) || 0,
        offsetY: Number(c.offsetY) || 0,
        artHeight: Number(c.artHeight) || 0,
        cardNum: c.cardNum ?? '001',
        totalSet: c.totalSet ?? '050',
        artist: c.artist ?? '',
        imageSrc: c.imageSrc || '',
        ownerId: c.ownerId || null,
        ownerName: c.ownerName || ''
    };
}

function newId() {
    return 'card_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

// Carte d'exemple : affichée (et en placeholder) tant que le formulaire d'une nouvelle carte est vierge
const DEMO_TEXT = {
    cardNameInput: 'Dragon Ancien',
    cardSubtypeInput: 'Dragon',
    cardHpInput: '120',
    cardAbilityInput: 'Vol, Piétinement.',
    spell1Name: 'Souffle ardent',
    spell1Dmg: '60',
    spell1Text: 'Inflige 20 dégâts supplémentaires si la cible est un Héros.',
    spell2Name: 'Coup de queue',
    spell2Dmg: '30',
    cardFlavorInput: 'Il régna sur les pics incandescents durant des millénaires.',
    cardSetNameInput: 'Édition de base',
    cardArtistInput: 'Studio TCG'
};
const TEXT_FIELDS = [...Object.keys(DEMO_TEXT), 'spell2Text'];

function isFormBlank() {
    return TEXT_FIELDS.every(id => !document.getElementById(id).value.trim());
}

// Exemples affichés dans les champs vides (préférence mémorisée sur l'appareil)
let demoTextEnabled = (() => { try { return localStorage.getItem('tcgbp_demo_text') !== '0'; } catch (e) { return true; } })();

function setDemoTextEnabled(on) {
    demoTextEnabled = on;
    try { localStorage.setItem('tcgbp_demo_text', on ? '1' : '0'); } catch (e) {}
    updateCard();
}

// preview: true = valeurs d'exemple pour les champs encore vides (affichage uniquement, jamais enregistrées)
function readForm({ preview = false } = {}) {
    const demoOn = preview && !currentCardId && demoTextEnabled;
    const raw = id => document.getElementById(id).value;
    // Un sort dont le joueur a saisi le nom n'hérite pas des dégâts / du texte d'exemple
    const ownSpell = { 1: !!raw('spell1Name').trim(), 2: !!raw('spell2Name').trim() };
    const v = id => {
        const val = raw(id);
        if (!demoOn || val.trim() || !(id in DEMO_TEXT)) return val;
        const spellField = id.match(/^spell(\d)(Dmg|Text)$/);
        if (spellField && ownSpell[spellField[1]]) return val;
        return DEMO_TEXT[id];
    };
    return {
        name: v('cardNameInput'),
        mana: v('cardManaInput'),
        manaColor: v('manaColorInput'),
        type: v('cardTypeInput'),
        rarity: v('rarityInput'),
        element: v('elementInput'),
        subtype: v('cardSubtypeInput'),
        titleFont: v('titleFontInput'),
        setName: v('cardSetNameInput'),
        hp: v('cardHpInput'),
        spells: [1, 2].map(i => ({ name: v(`spell${i}Name`), dmg: v(`spell${i}Dmg`), text: v(`spell${i}Text`) })),
        ability: v('cardAbilityInput'),
        flavor: v('cardFlavorInput'),
        isFullArt: document.getElementById('fullArtCheck').checked,
        zoom: Number(v('zoomRange')),
        offsetX: Number(v('offsetXRange')),
        offsetY: Number(v('offsetYRange')),
        // Le cran le plus à gauche du curseur (120) = hauteur automatique
        artHeight: Number(v('artHeightRange')) <= ART_HEIGHT_AUTO ? 0 : Number(v('artHeightRange')),
        cardNum: v('cardNumInput'),
        totalSet: v('cardTotalSetInput'),
        artist: v('cardArtistInput'),
        imageSrc: currentImageSrc
    };
}

// ---------- Rendu d'une carte (aperçu, mini-cartes, impression) ----------
function applyCardData(cardEl, d) {
    const q = sel => cardEl.querySelector(sel);
    cardEl.classList.remove(...[...cardEl.classList].filter(c => /^(type|rarity|elem)-|^(full-art|art-fixed)$/.test(c)));
    cardEl.classList.add('tcg-card', `type-${d.type}`, `rarity-${d.rarity}`, `elem-${d.element}`);
    if (d.isFullArt) cardEl.classList.add('full-art');
    if (d.artHeight > 0) {
        cardEl.classList.add('art-fixed');
        cardEl.style.setProperty('--art-h', `${d.artHeight}px`);
    }
    q('.card-title').textContent = d.name || 'Sans nom';

    const mana = q('.card-mana');
    mana.innerHTML = manaSVG(MANA_PALETTES[d.manaColor] || MANA_PALETTES.light) + '<span class="mana-value"></span>';
    mana.querySelector('.mana-value').textContent = d.mana;

    q('.card-type-text').textContent = (TYPES[d.type] || d.type) + (d.subtype ? ' — ' + d.subtype : '');
    q('.card-hp-text').textContent = d.hp ? `PV ${d.hp}` : '';
    const ability = q('.card-ability');
    ability.textContent = d.ability;
    ability.style.display = d.ability ? '' : 'none';

    // Sorts (nom + dégâts) ; les Terrains ont des effets, sans dégâts
    const isLand = d.type === 'land';
    const spellsEl = q('.card-spells');
    spellsEl.innerHTML = '';
    (d.spells || []).filter(s => s && (s.name || s.text)).forEach(s => {
        const row = document.createElement('div');
        row.className = 'card-spell';
        const head = document.createElement('div');
        head.className = 'spell-head';
        const name = document.createElement('span');
        name.className = 'spell-name';
        name.textContent = s.name;
        head.appendChild(name);
        if (!isLand && s.dmg) {
            const dmg = document.createElement('span');
            dmg.className = 'spell-dmg';
            dmg.textContent = s.dmg;
            head.appendChild(dmg);
        }
        row.appendChild(head);
        if (s.text) {
            const text = document.createElement('div');
            text.className = 'spell-text';
            text.textContent = s.text;
            row.appendChild(text);
        }
        spellsEl.appendChild(row);
    });
    const flavor = q('.card-flavor');
    flavor.textContent = d.flavor;
    flavor.style.display = d.flavor ? '' : 'none';

    const numbering = (d.cardNum || d.totalSet) ? `${d.cardNum}/${d.totalSet}` : '';
    const meta = [d.artist, [d.setName, numbering].filter(Boolean).join(' ')].filter(Boolean).join(' • ');
    q('.card-meta-text').textContent = meta;

    cardEl.style.setProperty('--title-font', `'${d.titleFont || 'Merienda'}'`);
    cardEl.dataset.titleFont = d.titleFont || 'Merienda';

    const img = q('.card-art-img');
    const src = d.imageSrc || DEFAULT_ART;
    if (img.dataset.src !== src) {
        img.dataset.src = src;
        img.style.backgroundImage = `url("${src}")`;
    }
    // Proportions réelles de l'image ; si encore inconnues, on les mesure puis on ré-applique
    const ratio = imageRatioCache.get(src);
    img.style.setProperty('--img-ratio', ratio || 1);
    if (!ratio) getImageRatio(src).then(() => { if (img.dataset.src === src) applyCardData(cardEl, d); });
    // -50 % = centrage dans la fenêtre, puis décalage choisi (en % de la taille de l'image)
    img.style.transform = `translate(${(d.offsetX || 0) - 50}%, ${(d.offsetY || 0) - 50}%) scale(${(d.zoom || 100) / 100})`;
}

// ---------- Proportions des images (largeur / hauteur) ----------
const imageRatioCache = new Map();
const imageRatioPending = new Map();

function getImageRatio(src) {
    if (imageRatioCache.has(src)) return Promise.resolve(imageRatioCache.get(src));
    if (!imageRatioPending.has(src)) {
        imageRatioPending.set(src, new Promise(resolve => {
            const probe = new Image();
            probe.onload = () => {
                const r = probe.naturalWidth && probe.naturalHeight ? probe.naturalWidth / probe.naturalHeight : 1;
                imageRatioCache.set(src, r);
                resolve(r);
            };
            probe.onerror = () => { imageRatioCache.set(src, 1); resolve(1); };
            probe.src = src;
        }));
    }
    return imageRatioPending.get(src);
}

function makeCardClone(d) {
    const clone = document.getElementById('renderCard').cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.remove('dragging');
    applyCardData(clone, d);
    return clone;
}

function makeMiniCard(d, scale) {
    const wrap = document.createElement('div');
    wrap.className = 'mini-card';
    wrap.style.width = (375 * scale) + 'px';
    wrap.style.height = (523 * scale) + 'px';
    const clone = makeCardClone(d);
    clone.style.transform = `scale(${scale})`;
    wrap.appendChild(clone);
    return wrap;
}

function updateCard() {
    const d = readForm({ preview: true });
    applyCardData(document.getElementById('renderCard'), d);
    schedule3d();

    document.getElementById('zoomVal').textContent = d.zoom;
    document.getElementById('offsetXVal').textContent = d.offsetX;
    document.getElementById('offsetYVal').textContent = d.offsetY;
    document.getElementById('artHeightVal').textContent = d.artHeight ? `${d.artHeight}px` : 'Auto';
    document.getElementById('artHeightGroup').style.display = d.isFullArt ? 'none' : '';
    const textbox = document.querySelector('#renderCard .card-textbox');
    document.getElementById('textOverflowHint').style.display = textbox.scrollHeight > textbox.clientHeight + 1 ? '' : 'none';

    const isLand = d.type === 'land';
    document.getElementById('spellsTitle').textContent = isLand ? 'Effets du terrain (2 maximum)' : 'Sorts (2 maximum)';
    document.querySelectorAll('.spell-label').forEach((l, i) => l.textContent = `${isLand ? 'Effet' : 'Sort'} ${i + 1} — Nom`);
    document.querySelectorAll('.dmg-group').forEach(g => g.style.display = isLand ? 'none' : '');
}
