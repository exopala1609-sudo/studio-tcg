// Animation « Quoi de neuf »

// =====================================================================
//  QUOI DE NEUF : animation d'accueil, une fois par version et par joueur
//  (mémorisé dans le profil Supabase + localStorage, donc PC et téléphone)
// =====================================================================
const WN_INTRO_MS = 2100;
const WN_FILTERS = ['none', 'taverne', 'ambre', 'gravure', 'nuit'];
let wnIndex = 0;
let wnTimer = null;

// Illustration de démonstration quand la carte en cours n'a pas encore de photo :
// un coucher de soleil sur les collines, avec une chope au premier plan
function wnDemoArt() {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 340;
    const x = c.getContext('2d');
    const sky = x.createLinearGradient(0, 0, 0, 340);
    sky.addColorStop(0, '#3d6fa8');
    sky.addColorStop(0.55, '#f2a65a');
    sky.addColorStop(1, '#f7d48a');
    x.fillStyle = sky;
    x.fillRect(0, 0, 480, 340);
    x.fillStyle = '#fff2c4';
    x.beginPath();
    x.arc(330, 170, 46, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = '#4f7a2c';
    x.beginPath();
    x.moveTo(0, 260);
    x.quadraticCurveTo(140, 190, 270, 250);
    x.quadraticCurveTo(380, 300, 480, 230);
    x.lineTo(480, 340);
    x.lineTo(0, 340);
    x.fill();
    x.fillStyle = '#7a4a22';
    x.fillRect(90, 190, 74, 100);
    x.strokeStyle = '#7a4a22';
    x.lineWidth = 12;
    x.beginPath();
    x.arc(166, 238, 24, -Math.PI / 2, Math.PI / 2);
    x.stroke();
    x.fillStyle = '#fbf3e0';
    x.beginPath();
    x.ellipse(127, 190, 46, 18, 0, 0, Math.PI * 2);
    x.fill();
    return c.toDataURL('image/jpeg', 0.85);
}

function buildWhatsNewVisuals() {
    // Intro : un sachet « Mise à jour », en deux morceaux pour la déchirure
    const update = { name: `Mise à jour ${APP_VERSION}`, color: 'ambre', slots: DEFAULT_SLOTS, cardIds: [] };
    const introPack = document.getElementById('wnIntroPack');
    introPack.innerHTML = '';
    ['wn-pack-body', 'wn-pack-top'].forEach(cls => {
        const pack = makePackVisual(update, 200);
        pack.classList.add(cls);
        pack.querySelector('.pack-window').innerHTML = icon('sparkles', 46);
        pack.querySelector('.pack-count').textContent = `${document.querySelectorAll('#wnTrack .wn-slide').length} nouveautés`;
        introPack.appendChild(pack);
    });

    // Sets : le même symbole, teinté de la commune à la légendaire
    document.getElementById('wnSetSymbols').innerHTML = RARITY_ORDER
        .map((r, i) => `<span style="--i:${i}" title="${RARITIES[r]}">${setSymbolSvg('beer', r, 40)}</span>`).join('');

    // Filtres : la carte en cours (ou une illustration de démo) passe d'un filtre à l'autre
    const base = readForm({ preview: true });
    if (!base.imageSrc) base.imageSrc = wnDemoArt();
    const scale = isMobileLayout() ? 0.24 : 0.3;   // carte + nom du filtre tiennent dans la zone visuelle
    const cards = document.getElementById('wnFilterCards');
    cards.style.width = `${375 * scale}px`;
    cards.style.height = `${523 * scale}px`;
    cards.replaceChildren(...WN_FILTERS.map((preset, i) => {
        const mini = makeMiniCard({ ...base, photoFilter: { ...DEFAULT_FILTER, preset } }, scale);
        mini.style.setProperty('--i', i);
        return mini;
    }));
    document.getElementById('wnFilterLabels').innerHTML = WN_FILTERS
        .map((p, i) => `<span style="--i:${i}">${p === 'none' ? 'Photo d\'origine' : FILTER_PRESETS[p].label}</span>`).join('');

    // Boosters : un sachet d'où s'échappent trois cartes, la dernière en or
    const booster = document.getElementById('wnBooster');
    const fans = [0, 1, 2].map(i => {
        const back = makeBackMini(0.2);
        back.className += ` wn-fan wn-fan-${i}`;
        return back;
    });
    const pack = makePackVisual({ name: 'Cuvée des Fondateurs', color: 'cuivre', slots: DEFAULT_SLOTS, cardIds: [] }, 92);
    pack.querySelector('.pack-window').innerHTML = icon('beer', 30);
    pack.classList.add('wn-booster-pack');
    booster.replaceChildren(...fans, pack);
}

// Bouton d'une slide : ferme l'animation puis ouvre la vue concernée
function whatsNewGoTo(view) {
    closeWhatsNew();
    setMainView(view);
}

function hasSeenWhatsNew() {
    let local = null;
    try { local = localStorage.getItem('tcgbp_seen_version'); } catch (e) {}
    return local === APP_VERSION || currentUser?.user_metadata?.seen_version === APP_VERSION;
}

async function maybeShowWhatsNew() {
    if (isCloudActive()) {
        // Profil relu sur le serveur : vu sur PC => pas relancé sur le téléphone
        const { data } = await sb.auth.getUser();
        if (data?.user) currentUser = data.user;
    }
    if (!hasSeenWhatsNew()) showWhatsNewModal();
}

function showWhatsNewModal() {
    const overlay = document.getElementById('whatsNew');
    if (!overlay.hidden) return;
    document.querySelectorAll('.wn-version').forEach(el => el.textContent = APP_VERSION);
    document.getElementById('wnIntroBack').style.backgroundImage = `url("${backImageSrc || DEFAULT_BACK}")`;

    // Bulles de bière à positions / tailles / vitesses variées
    const bubbles = document.getElementById('wnBubbles');
    bubbles.innerHTML = '';
    for (let i = 0; i < 18; i++) {
        const b = document.createElement('span');
        b.style.setProperty('--x', `${Math.random() * 100}%`);
        b.style.setProperty('--s', `${6 + Math.random() * 18}px`);
        b.style.setProperty('--d', `${6 + Math.random() * 7}s`);
        b.style.setProperty('--delay', `${-Math.random() * 8}s`);
        bubbles.appendChild(b);
    }

    buildWhatsNewVisuals();

    // Dernière slide : bouton d'installation direct si Android le propose
    document.getElementById('wnInstallBtn').hidden = !installPromptEvent;
    document.getElementById('wnInstallHint').hidden = !!installPromptEvent;

    const dots = document.getElementById('wnDots');
    dots.innerHTML = '';
    document.querySelectorAll('#wnTrack .wn-slide').forEach((_, i) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.setAttribute('aria-label', `Nouveauté ${i + 1}`);
        d.onclick = () => goToWhatsNew(i);
        dots.appendChild(d);
    });

    // Intro (carte qui tremble, flash, retournement) puis carrousel
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const intro = document.getElementById('wnIntro');
    const panel = document.getElementById('wnPanel');
    intro.hidden = reduced;
    panel.hidden = !reduced;
    // Relance les animations CSS de l'intro à chaque ouverture
    intro.querySelectorAll('.wn-intro-card, .wn-intro-pack, .wn-intro-pack .booster-pack, .wn-flash').forEach(el => {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
    });

    overlay.classList.remove('closing');
    overlay.hidden = false;
    pushLayer('whatsnew', finishWhatsNew);
    goToWhatsNew(0);
    clearTimeout(wnTimer);
    if (!reduced) {
        wnTimer = setTimeout(() => {
            intro.hidden = true;
            panel.hidden = false;
            document.getElementById('wnNext').focus();
        }, WN_INTRO_MS + 150);
    }
}

function goToWhatsNew(i) {
    const slides = document.querySelectorAll('#wnTrack .wn-slide');
    wnIndex = Math.max(0, Math.min(slides.length - 1, i));
    document.getElementById('wnTrack').style.transform = `translateX(-${wnIndex * 100}%)`;
    document.querySelectorAll('#wnDots button').forEach((d, k) => d.classList.toggle('active', k === wnIndex));
    const last = wnIndex === slides.length - 1;
    const next = document.getElementById('wnNext');
    next.innerHTML = last ? icon('beer', 18) + 'Entrer dans la Taverne' : 'Suivant' + icon('arrow-right', 16);
    next.classList.toggle('final', last);
}

function whatsNewNext() {
    const count = document.querySelectorAll('#wnTrack .wn-slide').length;
    if (wnIndex >= count - 1) closeWhatsNew();
    else goToWhatsNew(wnIndex + 1);
}

function closeWhatsNew() {
    if (!closeLayer('whatsnew')) finishWhatsNew();
}

async function finishWhatsNew() {
    const overlay = document.getElementById('whatsNew');
    if (overlay.hidden) return;
    clearTimeout(wnTimer);
    overlay.classList.add('closing');
    setTimeout(() => { overlay.hidden = true; overlay.classList.remove('closing'); }, 300);

    try { localStorage.setItem('tcgbp_seen_version', APP_VERSION); } catch (e) {}
    if (isCloudActive() && currentUser?.user_metadata?.seen_version !== APP_VERSION) {
        const { data, error } = await sb.auth.updateUser({ data: { seen_version: APP_VERSION } });
        if (error) console.warn('Nouveautés : version vue non synchronisée', error);
        else if (data?.user) currentUser = data.user;
    }
}

async function installFromWhatsNew() {
    await installApp();
    document.getElementById('wnInstallBtn').hidden = true;
}

// Clavier (flèches, Échap) et balayage au doigt dans le carrousel
document.addEventListener('keydown', e => {
    if (document.getElementById('whatsNew').hidden) return;
    if (e.key === 'Escape') closeWhatsNew();
    else if (e.key === 'ArrowRight') whatsNewNext();
    else if (e.key === 'ArrowLeft') goToWhatsNew(wnIndex - 1);
});

(() => {
    const track = document.getElementById('wnTrack');
    let startX = null;
    track.addEventListener('pointerdown', e => { startX = e.clientX; });
    track.addEventListener('pointerup', e => {
        if (startX === null) return;
        const dx = e.clientX - startX;
        startX = null;
        if (Math.abs(dx) < 50) return;
        if (dx < 0) whatsNewNext();
        else goToWhatsNew(wnIndex - 1);
    });
})();
