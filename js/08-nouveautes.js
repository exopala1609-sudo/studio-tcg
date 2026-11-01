// Animation « Quoi de neuf »

// =====================================================================
//  QUOI DE NEUF : animation d'accueil, une fois par version et par joueur
//  (mémorisé dans le profil Supabase + localStorage, donc PC et téléphone)
// =====================================================================
const WN_INTRO_MS = 1200;
let wnIndex = 0;
let wnTimer = null;

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

    // Slide 1 : la carte en cours d'édition, qui oscille en 3D avec reflet holo
    document.getElementById('wnCardSpin').replaceChildren(withShine(makeMiniCard(readForm({ preview: true }), 0.42)));

    // Slide 4 : bouton d'installation direct si Android le propose
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
    const card = document.getElementById('wnIntroCard');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

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
