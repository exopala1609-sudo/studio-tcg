// Interface : icônes, menus, historique (bouton Retour), PWA, classeur, mobile

// =====================================================================
//  ICÔNES (Lucide) : <i data-lucide> dans le HTML, icon('nom') dans le JS
// =====================================================================
function icon(name, size = 16) {
    const key = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
    const node = window.lucide?.icons?.[key];
    if (!node) return '';
    return window.lucide.createElement(node, { width: size, height: size, 'aria-hidden': 'true', class: `lucide lucide-${name}` }).outerHTML;
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Menus déroulants (Outils, Exporter) ----------
function toggleDropdown(id, event) {
    event?.stopPropagation();
    const dd = document.getElementById(id);
    const open = !dd.classList.contains('open');
    closeAllDropdowns();
    dd.classList.toggle('open', open);
    dd.querySelector('[aria-haspopup]')?.setAttribute('aria-expanded', open);
}

function closeAllDropdowns() {
    document.querySelectorAll('.dropdown.open').forEach(d => {
        d.classList.remove('open');
        d.querySelector('[aria-haspopup]')?.setAttribute('aria-expanded', 'false');
    });
}

document.addEventListener('click', e => { if (!e.target.closest('.dropdown-menu')) closeAllDropdowns(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllDropdowns(); });

// ---------- Historique : le geste Retour d'Android ferme la couche ouverte ----------
// Chaque couche (vue hors Studio, classeur, modale, éditeur de deck, partie, sélection…)
// ajoute une entrée d'historique. Retour = fermer la couche du dessus, sans quitter l'app.
const navLayers = [];
let pendingBacks = 0;        // retours déclenchés par nous-mêmes (fermeture par un bouton)
const queuedPushes = [];     // entrées à ajouter une fois ces retours traités

function hasLayer(name) {
    return navLayers.some(l => l.name === name);
}

function pushLayer(name, onClose) {
    if (hasLayer(name)) return;
    navLayers.push({ name, onClose });
    if (pendingBacks) queuedPushes.push(name);
    else history.pushState({ tcgbpLayer: name }, '');
}

// Ferme une couche ouverte : l'interface change tout de suite, l'historique suit
function closeLayer(name) {
    const idx = navLayers.map(l => l.name).lastIndexOf(name);
    if (idx === -1) return false;
    const [layer] = navLayers.splice(idx, 1);
    const queued = queuedPushes.indexOf(name);
    if (queued !== -1) queuedPushes.splice(queued, 1);
    else if (idx === navLayers.length) {
        pendingBacks++;
        history.back();
    }
    layer.onClose();
    return true;
}

window.addEventListener('popstate', () => {
    if (pendingBacks) {
        pendingBacks--;
    } else {
        const layer = navLayers.pop();
        if (layer) layer.onClose();
    }
    while (!pendingBacks && queuedPushes.length) history.pushState({ tcgbpLayer: queuedPushes.shift() }, '');
});

// ---------- Application installable (PWA) ----------
let installPromptEvent = null;

function initPwa() {
    // Le Service Worker ne fonctionne qu'en http(s) (pas en ouvrant le fichier en double-clic)
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service Worker :', err));
    }
    // Android/Chrome propose l'installation : on garde l'événement pour notre bouton
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        installPromptEvent = e;
        document.getElementById('installBtn').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
        installPromptEvent = null;
        document.getElementById('installBtn').hidden = true;
    });
}

async function installApp() {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    installPromptEvent = null;
    document.getElementById('installBtn').hidden = true;
}

// ---------- Classeur de collection (plein écran) ----------
let ownerTab = '';   // '' = toutes, 'mine' = mes cartes, sinon id du joueur

function isBinderOpen() {
    return !document.getElementById('binderOverlay').hidden;
}

function openBinder() {
    document.getElementById('binderOverlay').hidden = false;
    pushLayer('binder', hideBinder);
    renderCollection();
    refreshNavHighlight();
}

function closeBinder() {
    if (!closeLayer('binder')) hideBinder();
}

function hideBinder() {
    document.getElementById('binderOverlay').hidden = true;
    refreshNavHighlight();
}

// ---------- Mobile : barre d'onglets en bas d'écran ----------
// Mobile : bascule Carte / Éditer à l'intérieur du Studio
function setMobileTab(tab) {
    document.body.dataset.mtab = tab;
    document.querySelectorAll('.studio-switch button').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
    document.querySelector('main').scrollTop = 0;
}

function highlightMobileTab() {
    refreshNavHighlight();
}

// Sur mobile, la carte (375px) est réduite pour tenir dans la largeur de l'écran
function updateCardZoom() {
    const zoom = Math.min(1, (document.documentElement.clientWidth - 24) / 375);
    document.documentElement.style.setProperty('--card-zoom', zoom.toFixed(3));
}
window.addEventListener('resize', updateCardZoom);

function isMobileLayout() {
    return window.matchMedia('(max-width: 767px)').matches;
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isBinderOpen()) closeBinder();
});

function setOwnerTab(tab) {
    ownerTab = tab;
    renderCollection();
}

// Onglets "Toutes", "Mes cartes" et un par joueur, avec compteurs
function renderOwnerTabs() {
    const tabs = [{ key: '', label: 'Toutes', icon: 'library', count: collection.length }];
    if (isCloudActive()) {
        tabs.push({ key: 'mine', label: 'Mes cartes', icon: 'user-round', count: collection.filter(isOwnCard).length });
        const owners = new Map();
        collection.forEach(c => {
            if (isOwnCard(c)) return;
            const o = owners.get(c.ownerId) || { label: c.ownerName || 'Anonyme', icon: 'users', count: 0 };
            o.count++;
            owners.set(c.ownerId, o);
        });
        owners.forEach((o, key) => tabs.push({ key, ...o }));
    }
    if (!tabs.some(t => t.key === ownerTab)) ownerTab = '';

    const container = document.getElementById('collectionOwnerTabs');
    container.replaceChildren(...tabs.map(t => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = t.key === ownerTab ? 'active' : '';
        b.innerHTML = icon(t.icon, 14);
        b.appendChild(document.createTextNode(t.label));
        const count = document.createElement('span');
        count.className = 'tab-count';
        count.textContent = t.count;
        b.appendChild(count);
        b.onclick = () => setOwnerTab(t.key);
        return b;
    }));
}

function renderCollection() {
    document.getElementById('collectionCount').textContent = collection.length;
    document.getElementById('headerCollectionCount').textContent = collection.length;
    document.getElementById('tabCollectionCount').textContent = collection.length;
    if (!isBinderOpen()) return;   // les miniatures ne sont dessinées que classeur ouvert

    const grid = document.getElementById('collectionGrid');
    const search = document.getElementById('collectionSearch').value.trim().toLowerCase();
    const typeFilter = document.getElementById('collectionTypeFilter').value;
    renderOwnerTabs();
    grid.innerHTML = '';

    const visible = collection.filter(c =>
        (!typeFilter || c.type === typeFilter) &&
        (!ownerTab || (ownerTab === 'mine' ? isOwnCard(c) : c.ownerId === ownerTab)) &&
        (!search || `${c.name} ${c.subtype} ${c.ability} ${c.setName || ''} ${c.ownerName || ''}`.toLowerCase().includes(search))
    );

    if (visible.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.85rem;">${collection.length ? 'Aucune carte ne correspond au filtre.' : 'Aucune carte enregistrée. Créez une carte puis cliquez sur « Ajouter à la collection ».'}</div>`;
        return;
    }

    visible.forEach(card => {
        const mine = isOwnCard(card);
        const item = document.createElement('div');
        item.className = 'collection-item' + (card.id === currentCardId ? ' active' : '') + (isCloudActive() && mine ? ' is-mine' : '');
        item.onclick = () => { loadCardIntoForm(card); closeBinder(); };

        if (isCloudActive()) {
            const badge = document.createElement('span');
            badge.className = 'owner-badge ' + (mine ? 'mine' : 'friend');
            badge.innerHTML = icon(mine ? 'user-round' : 'users', 11);
            badge.appendChild(document.createTextNode(mine ? 'Moi' : (card.ownerName || 'Anonyme')));
            item.appendChild(badge);
        }

        item.appendChild(makeMiniCard(card, isMobileLayout() ? 0.36 : 0.45));

        const title = document.createElement('div');
        title.className = 'collection-title';
        title.textContent = card.name || 'Sans nom';
        item.appendChild(title);

        const actions = document.createElement('div');
        actions.className = 'collection-item-actions';
        const typeLabel = document.createElement('span');
        typeLabel.textContent = `${TYPES[card.type] || card.type} · ${RARITIES[card.rarity] || ''}`;
        actions.appendChild(typeLabel);
        if (mine) {
            const del = document.createElement('button');
            del.className = 'delete-card-btn';
            del.textContent = 'Supprimer';
            del.onclick = e => deleteCard(card.id, e);
            actions.appendChild(del);
        }
        item.appendChild(actions);

        grid.appendChild(item);
    });
}

// Stockage du navigateur : utilisé uniquement hors ligne
function saveCollectionToStorage() {
    try {
        localStorage.setItem('tcg_collection', JSON.stringify(collection));
    } catch (e) {
        alert("Stockage du navigateur plein : exportez votre deck en JSON pour ne rien perdre.");
    }
}

function readLocalCollection() {
    try {
        const saved = localStorage.getItem('tcg_collection');
        return saved ? JSON.parse(saved).map(normalizeCard) : [];
    } catch (e) {
        return [];
    }
}
