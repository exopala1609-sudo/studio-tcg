// Studio : verso, vue 3D, import et déplacement de l'image, formulaire

// ---------- Verso ----------
function applyBack() {
    document.querySelector('#backCard .card-back-img').style.backgroundImage = `url("${backImageSrc || DEFAULT_BACK}")`;
    schedule3d();
}

// ---------- Vue 3D interactive (inclinaison, reflet holo, retournement) ----------
// Elle n'affiche que des clones : les exports (html2canvas) partent toujours de clones
// neufs rendus hors écran, jamais de ces éléments transformés en 3D.
let previewMode = 'edit';
let render3dFrame = null;

function setPreviewMode(mode) {
    previewMode = mode;
    document.getElementById('viewEditBtn').classList.toggle('active', mode === 'edit');
    document.getElementById('view3dBtn').classList.toggle('active', mode === '3d');
    document.getElementById('previewEdit').hidden = mode === '3d';
    document.getElementById('preview3d').hidden = mode !== '3d';
    if (mode === '3d') rebuild3d();
    else updateCard();
}

function schedule3d() {
    if (previewMode !== '3d') return;
    cancelAnimationFrame(render3dFrame);
    render3dFrame = requestAnimationFrame(rebuild3d);
}

function withShine(cardEl) {
    const holo = document.createElement('div');
    holo.className = 'holo3d';
    const glare = document.createElement('div');
    glare.className = 'glare3d';
    cardEl.append(holo, glare);
    return cardEl;
}

function rebuild3d() {
    if (previewMode !== '3d') return;
    document.getElementById('face3dFront').replaceChildren(withShine(makeCardClone(readForm({ preview: true }))));
    document.getElementById('face3dBack').replaceChildren(withShine(makeBackClone()));
}

function flip3d() {
    document.getElementById('flipper3d').classList.toggle('flipped');
}

function init3dTilt() {
    const scene = document.getElementById('scene3d');
    const MAX_TILT = 15;
    scene.addEventListener('pointermove', e => {
        const r = scene.getBoundingClientRect();
        const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        scene.classList.remove('resting');
        scene.style.setProperty('--ry', `${(px - 0.5) * 2 * MAX_TILT}deg`);
        scene.style.setProperty('--rx', `${(0.5 - py) * 2 * MAX_TILT}deg`);
        scene.style.setProperty('--gx', `${px * 100}%`);
        scene.style.setProperty('--gy', `${py * 100}%`);
        scene.style.setProperty('--glare', 1);
    });
    scene.addEventListener('pointerleave', () => {
        scene.classList.add('resting');
        scene.style.setProperty('--rx', '0deg');
        scene.style.setProperty('--ry', '0deg');
        scene.style.setProperty('--glare', 0);
    });
}

function handleBackUpload(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    readImageFile(file, async src => {
        setBackImage(await uploadIfCloud(src, 'shared'));
    });
}

function resetBack() {
    setBackImage('');
}

// Le verso est commun à tout le groupe : en mode cloud il est partagé via studio_settings
async function setBackImage(src) {
    backImageSrc = src;
    try { localStorage.setItem('tcg_back', src); } catch (e) { alert("Stockage plein : le verso ne sera pas mémorisé."); }
    applyBack();
    if (!isCloudActive()) return;
    const { error } = await sb.from('studio_settings').upsert({ key: 'back_image', value: src });
    if (error) {
        console.error('Verso :', error);
        alert("Le verso n'a pas pu être partagé avec le groupe : " + error.message);
    }
}

// Récupère le verso partagé ('' = verso de base). Sans réglage partagé, on garde le verso local.
async function loadSharedBack() {
    const { data, error } = await sb.from('studio_settings').select('value').eq('key', 'back_image').maybeSingle();
    if (error) { console.error('Verso :', error); return; }
    if (!data) return;
    backImageSrc = data.value || '';
    try { localStorage.setItem('tcg_back', backImageSrc); } catch (e) {}
    applyBack();
}

function makeBackClone() {
    const clone = document.getElementById('backCard').cloneNode(true);
    clone.removeAttribute('id');
    return clone;
}

// ---------- Image : import, déplacement, zoom ----------
function handleImageUpload(event) {
    const file = event.target.files[0];
    if (file) loadImageFile(file);
    event.target.value = '';
}

// Redimensionne/compresse l'image, puis l'envoie dans le cloud si on est connecté
function loadImageFile(file) {
    readImageFile(file, async src => {
        currentImageSrc = await uploadIfCloud(src, currentUser?.id);
        resetArtPosition();
    });
}

// ---------- Images dans Supabase Storage ----------
function isCloudActive() {
    return !!(sb && currentUser && !offlineMode);
}

// Envoie une image (data URL) dans le bucket et renvoie son URL publique
async function uploadImage(dataUrl, folder) {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${folder}/${crypto.randomUUID()}.jpg`;
    const { error } = await sb.storage.from(CARD_IMAGES_BUCKET).upload(path, blob, {
        contentType: blob.type || 'image/jpeg',
        cacheControl: '31536000',   // le fichier ne change jamais (nom unique) : cache 1 an
        upsert: false
    });
    if (error) throw error;
    const url = sb.storage.from(CARD_IMAGES_BUCKET).getPublicUrl(path).data.publicUrl;
    if (imageRatioCache.has(dataUrl)) imageRatioCache.set(url, imageRatioCache.get(dataUrl));
    return url;
}

// En mode cloud, renvoie l'URL publique ; hors ligne (ou si l'envoi échoue), garde l'image locale
async function uploadIfCloud(dataUrl, folder) {
    if (!isCloudActive()) return dataUrl;
    setCloudStatus("Envoi de l'image…");
    try {
        return await uploadImage(dataUrl, folder);
    } catch (err) {
        console.error('Upload :', err);
        alert("L'envoi de l'image dans le cloud a échoué : elle est gardée dans ce navigateur.\n" + (err.message || ''));
        return dataUrl;
    } finally {
        setCloudIdle();
    }
}

function readImageFile(file, onDone) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => {
            const MAX = 1100;
            const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * ratio);
            canvas.height = Math.round(img.height * ratio);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#111';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const src = canvas.toDataURL('image/jpeg', 0.88);
            imageRatioCache.set(src, canvas.width / canvas.height);
            onDone(src);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function resetArtPosition() {
    document.getElementById('zoomRange').value = 100;
    document.getElementById('offsetXRange').value = 0;
    document.getElementById('offsetYRange').value = 0;
    updateCard();
}

// Zoom "contain" : toute l'image visible dans la fenêtre (hauteur entière pour une photo verticale)
async function fitWholeImage() {
    if (previewMode !== 'edit') setPreviewMode('edit');   // la mesure se fait sur la carte d'édition
    await getImageRatio(currentImageSrc || DEFAULT_ART);
    updateCard();
    const container = document.querySelector('#renderCard .card-art-container');
    const img = container.querySelector('.card-art-img');
    const fit = Math.min(container.clientWidth / img.offsetWidth, container.clientHeight / img.offsetHeight) * 100;
    document.getElementById('zoomRange').value = Math.max(ZOOM_MIN, Math.floor(fit));
    document.getElementById('offsetXRange').value = 0;
    document.getElementById('offsetYRange').value = 0;
    updateCard();
}

function initArtInteractions() {
    const card = document.getElementById('renderCard');
    const zoomEl = document.getElementById('zoomRange');
    const xEl = document.getElementById('offsetXRange');
    const yEl = document.getElementById('offsetYRange');
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    let drag = null;

    const startDrag = (x, y) => {
        const img = card.querySelector('.card-art-img');
        drag = { x, y, ox: +xEl.value, oy: +yEl.value, w: img.offsetWidth, h: img.offsetHeight };
        card.classList.add('dragging');
    };
    const moveDrag = (x, y) => {
        xEl.value = clamp(Math.round(drag.ox + (x - drag.x) / drag.w * 100), -100, 100);
        yEl.value = clamp(Math.round(drag.oy + (y - drag.y) / drag.h * 100), -100, 100);
        updateCard();
    };
    const endDrag = () => { drag = null; card.classList.remove('dragging', 'drag-armed'); };

    // Souris / stylet : on glisse directement
    card.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch' || e.button !== 0) return;
        startDrag(e.clientX, e.clientY);
        card.setPointerCapture(e.pointerId);
    });
    card.addEventListener('pointermove', e => {
        if (e.pointerType === 'touch' || !drag) return;
        moveDrag(e.clientX, e.clientY);
    });
    card.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') endDrag(); });
    card.addEventListener('pointercancel', e => { if (e.pointerType !== 'touch') endDrag(); });

    // Doigt : un glissé normal fait défiler la page. Pour déplacer l'image, on garde
    // le doigt immobile un instant (la carte s'entoure d'or), puis on glisse.
    const HOLD_MS = 280, MOVE_TOLERANCE = 10;
    let touch = null;
    const cancelTouch = () => {
        if (touch) clearTimeout(touch.timer);
        touch = null;
        endDrag();
    };
    card.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return cancelTouch();
        const t = e.touches[0];
        touch = { x: t.clientX, y: t.clientY, active: false };
        touch.timer = setTimeout(() => {
            if (!touch) return;
            touch.active = true;
            startDrag(touch.x, touch.y);
            card.classList.add('drag-armed');
            navigator.vibrate?.(12);
        }, HOLD_MS);
    }, { passive: true });
    card.addEventListener('touchmove', e => {
        if (!touch) return;
        const t = e.touches[0];
        if (!touch.active) {
            // Le doigt bouge avant la fin de l'appui : c'est un défilement, on laisse faire
            if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) > MOVE_TOLERANCE) cancelTouch();
            return;
        }
        e.preventDefault();   // glissé de l'image en cours : pas de défilement
        moveDrag(t.clientX, t.clientY);
    }, { passive: false });
    card.addEventListener('touchend', cancelTouch);
    card.addEventListener('touchcancel', cancelTouch);
    // Appui long : pas de menu contextuel du navigateur
    card.addEventListener('contextmenu', e => { if (touch || drag) e.preventDefault(); });

    card.addEventListener('wheel', e => {
        e.preventDefault();
        zoomEl.value = clamp(+zoomEl.value + (e.deltaY < 0 ? 5 : -5), ZOOM_MIN, ZOOM_MAX);
        updateCard();
    }, { passive: false });

    // Glisser-déposer un fichier image sur la carte
    card.addEventListener('dragover', e => e.preventDefault());
    card.addEventListener('drop', e => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) loadImageFile(file);
    });
}

// ---------- Formulaire <-> carte ----------
function loadCardIntoForm(rawCard, keepId = true) {
    const card = normalizeCard(rawCard);
    const set = (id, val) => document.getElementById(id).value = val;
    set('cardNameInput', card.name);
    set('cardManaInput', card.mana);
    set('manaColorInput', card.manaColor);
    set('cardTypeInput', card.type);
    set('rarityInput', card.rarity);
    set('elementInput', card.element);
    set('cardSubtypeInput', card.subtype);
    set('titleFontInput', card.titleFont);
    set('cardSetNameInput', card.setName);
    set('cardHpInput', card.hp);
    card.spells.forEach((s, i) => {
        set(`spell${i + 1}Name`, s.name);
        set(`spell${i + 1}Dmg`, s.dmg);
        set(`spell${i + 1}Text`, s.text);
    });
    set('cardAbilityInput', card.ability);
    set('cardFlavorInput', card.flavor);
    document.getElementById('fullArtCheck').checked = card.isFullArt;
    set('zoomRange', card.zoom);
    set('offsetXRange', card.offsetX);
    set('offsetYRange', card.offsetY);
    set('artHeightRange', card.artHeight || ART_HEIGHT_AUTO);
    set('cardNumInput', card.cardNum);
    set('cardTotalSetInput', card.totalSet);
    set('cardArtistInput', card.artist);
    currentImageSrc = card.imageSrc;
    setCurrentCard(keepId ? rawCard.id : null);
    updateCard();
}

function setCurrentCard(id) {
    currentCardId = id && collection.some(c => c.id === id) ? id : null;
    const current = collection.find(c => c.id === currentCardId);
    // Carte d'un ami : lecture seule, l'enregistrement crée une copie à mon nom
    const locked = !!current && !isOwnCard(current);
    const btn = document.getElementById('updateCardBtn');
    btn.disabled = !current;
    btn.innerHTML = locked ? icon('copy') + 'Dupliquer à mon nom' : icon('save') + 'Mettre à jour';
    document.getElementById('editingBadge').textContent = !current ? ''
        : locked ? `Carte de ${current.ownerName || 'un ami'} — toute sauvegarde créera une copie à votre nom`
        : `Édition de « ${current.name || 'Sans nom'} »`;
    document.getElementById('editingBadge').classList.toggle('locked', locked);
    renderCollection();
}

// Le formulaire diffère-t-il de la carte chargée (ou, pour une nouvelle carte, contient-il quelque chose) ?
function hasUnsavedChanges() {
    const current = collection.find(c => c.id === currentCardId);
    if (!current) return !isFormBlank() || !!currentImageSrc;
    const form = normalizeCard({ ...readForm(), id: current.id, ownerId: current.ownerId, ownerName: current.ownerName });
    return stableStringify(form) !== stableStringify(normalizeCard(current));
}

function resetToNewCard() {
    if (hasUnsavedChanges() && !confirm('Abandonner les modifications non enregistrées de la carte en cours ?')) return;
    const set = (id, val) => document.getElementById(id).value = val;
    TEXT_FIELDS.forEach(id => set(id, ''));
    set('cardManaInput', 5);
    set('manaColorInput', 'light');
    set('cardTypeInput', 'hero');
    set('rarityInput', 'rare');
    set('elementInput', 'neutral');
    set('titleFontInput', 'Merienda');
    document.getElementById('fullArtCheck').checked = false;
    set('zoomRange', 100);
    set('offsetXRange', 0);
    set('offsetYRange', 0);
    set('artHeightRange', ART_HEIGHT_AUTO);
    currentImageSrc = '';
    setCurrentCard(null);
    updateCard();
    document.getElementById('cardNameInput').focus();
}
