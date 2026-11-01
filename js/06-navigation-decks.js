// Navigation principale et vue Decks

// =====================================================================
//  NAVIGATION PRINCIPALE : Créateur / Collection / Table de Jeu
// =====================================================================
function setMainView(view) {
    closeAllDropdowns();
    if (view === 'collection') {
        openBinder();
        return;
    }
    if (isBinderOpen()) closeBinder();
    applyView(view);
    // Le Studio est la "page d'accueil" : le bouton Retour d'Android y ramène
    if (view === 'creator') closeLayer('view');
    else pushLayer('view', () => applyView('creator'));
}

function applyView(view) {
    document.body.dataset.view = view;
    if (view === 'arena') {
        refreshLobby();
        if (game) renderBoard();
    }
    if (view === 'decks') renderDecksView();
    refreshNavHighlight();
}

function refreshNavHighlight() {
    const view = isBinderOpen() ? 'collection' : document.body.dataset.view;
    document.querySelectorAll('.main-tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('#bottomTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === view));
}

// =====================================================================
//  DECKS : sauvegardés dans le profil Supabase (user_metadata.decks),
//  donc synchronisés PC <-> Android, avec copie localStorage hors ligne
// =====================================================================
let myDecks = [];   // [{ id, name, cardIds: [] }]

function readLocalDecks() {
    try { return JSON.parse(localStorage.getItem('tcg_decks') || '[]'); } catch (e) { return []; }
}

// Relit le profil sur le serveur : les decks modifiés sur un autre appareil arrivent ici
async function loadDecks() {
    if (isCloudActive()) {
        const { data } = await sb.auth.getUser();
        if (data?.user) currentUser = data.user;
    }
    const cloudDecks = isCloudActive() ? currentUser.user_metadata?.decks : undefined;
    if (Array.isArray(cloudDecks)) {
        myDecks = cloudDecks;
        try { localStorage.setItem('tcg_decks', JSON.stringify(myDecks)); } catch (e) {}
    } else {
        myDecks = readLocalDecks();
        // Decks créés hors ligne : envoyés dans le profil à la première connexion
        if (isCloudActive() && myDecks.length) saveDecks();
    }
    renderDeckSelect();
    if (document.body.dataset.view === 'decks' && !deckEditorState) renderDeckGrid();
}

async function saveDecks() {
    try { localStorage.setItem('tcg_decks', JSON.stringify(myDecks)); } catch (e) {}
    if (!isCloudActive()) return;
    const { data, error } = await sb.auth.updateUser({ data: { decks: myDecks } });
    if (error) return cloudError('Deck enregistré sur cet appareil seulement (synchronisation impossible)', error);
    if (data?.user) currentUser = data.user;
}

function renderDeckSelect() {
    const select = document.getElementById('deckSelect');
    const previous = select.value;
    select.innerHTML = myDecks.length ? '' : '<option value="">— Aucun deck : cliquez sur « Nouveau » —</option>';
    myDecks.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.name} (${d.cardIds.length} cartes)`;
        select.appendChild(opt);
    });
    if (myDecks.some(d => d.id === previous)) select.value = previous;
}

let deckBuilderState = null;   // { id, selected: Set }

// ---------- Vue Decks ----------
let deckEditorState = null;   // { id, cardIds: [], dirty }

function renderDecksView() {
    const note = document.getElementById('decksSyncNote');
    note.textContent = isCloudActive()
        ? 'Synchronisés entre vos appareils (PC, Android).'
        : 'Hors ligne : enregistrés sur cet appareil uniquement.';
    renderDeckGrid();
    loadDecks();
}

function renderDeckGrid() {
    const grid = document.getElementById('deckGrid');
    grid.innerHTML = '';
    if (!myDecks.length) {
        grid.innerHTML = '<div class="empty-state">Aucun deck pour l\'instant. Créez-en un pour l\'utiliser dans l\'Arène.</div>';
        return;
    }
    myDecks.forEach(deck => {
        const box = document.createElement('article');
        box.className = 'deck-box';
        const cover = document.createElement('div');
        cover.className = 'deck-cover';
        const first = deck.cardIds.map(id => collection.find(c => c.id === id)).find(Boolean);
        cover.appendChild(first ? makeMiniCard(first, 0.3) : makeBackMini(0.3));
        const info = document.createElement('div');
        info.className = 'deck-info';
        const name = document.createElement('h3');
        name.textContent = deck.name;
        const count = document.createElement('span');
        const missing = deck.cardIds.filter(id => !collection.some(c => c.id === id)).length;
        count.textContent = `${deck.cardIds.length} carte${deck.cardIds.length > 1 ? 's' : ''}${missing ? ` (${missing} introuvable${missing > 1 ? 's' : ''})` : ''}`;
        const actions = document.createElement('div');
        actions.className = 'deck-actions';
        actions.append(
            sheetButton('Modifier', () => openDeckEditor(deck.id), 'btn-secondary', 'pencil'),
            sheetButton('Dupliquer', () => duplicateDeck(deck.id), 'btn-secondary', 'copy'),
            sheetButton('Supprimer', () => deleteDeck(deck.id), 'btn-danger', 'trash-2')
        );
        info.append(name, count, actions);
        box.append(cover, info);
        grid.appendChild(box);
    });
}

function openDeckEditor(deckId) {
    const deck = myDecks.find(d => d.id === deckId);
    deckEditorState = { id: deck?.id || null, cardIds: [...(deck?.cardIds || [])], dirty: false };
    document.getElementById('deckNameInput').value = deck?.name || '';
    document.getElementById('deckSearchInput').value = '';
    document.getElementById('decksListView').hidden = true;
    document.getElementById('deckEditor').hidden = false;
    pushLayer('deckEditor', hideDeckEditor);
    renderDeckPool();
    renderDeckContents();
}

async function closeDeckEditor() {
    if (deckEditorState?.dirty && !(await tcgConfirm('Les modifications de ce deck ne sont pas enregistrées.', { title: "Quitter l'éditeur ?", confirmLabel: 'Quitter sans enregistrer', danger: true }))) return;
    if (!closeLayer('deckEditor')) hideDeckEditor();
}

function hideDeckEditor() {
    deckEditorState = null;
    document.getElementById('deckEditor').hidden = true;
    document.getElementById('decksListView').hidden = false;
    renderDeckGrid();
}

function deckCopies(cardId) {
    return deckEditorState.cardIds.filter(id => id === cardId).length;
}

function renderDeckPool() {
    const pool = document.getElementById('deckPool');
    const search = document.getElementById('deckSearchInput').value.trim().toLowerCase();
    const type = document.getElementById('deckTypeFilter').value;
    pool.innerHTML = '';
    const cards = collection.filter(c =>
        (!type || c.type === type) &&
        (!search || `${c.name} ${c.subtype} ${c.ownerName || ''}`.toLowerCase().includes(search)));
    if (!cards.length) {
        pool.innerHTML = '<div class="empty-state">Aucune carte ne correspond.</div>';
        return;
    }
    cards.forEach(card => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'pool-tile';
        tile.dataset.id = card.id;
        tile.title = 'Ajouter au deck';
        tile.appendChild(makeMiniCard(card, isMobileLayout() ? 0.24 : 0.28));
        const badge = document.createElement('span');
        badge.className = 'pool-count';
        tile.appendChild(badge);
        tile.onclick = () => { deckEditorState.cardIds.push(card.id); deckEditorState.dirty = true; renderDeckContents(); };
        pool.appendChild(tile);
    });
    refreshPoolCounts();
}

function refreshPoolCounts() {
    document.querySelectorAll('#deckPool .pool-tile').forEach(tile => {
        const n = deckCopies(tile.dataset.id);
        const badge = tile.querySelector('.pool-count');
        badge.textContent = n ? `×${n}` : '';
        tile.classList.toggle('in-deck', n > 0);
    });
}

function renderDeckContents() {
    const list = document.getElementById('deckContents');
    list.innerHTML = '';
    const total = deckEditorState.cardIds.length;
    document.getElementById('deckEditorCount').textContent = `${total} carte${total > 1 ? 's' : ''}`;
    const ids = [...new Set(deckEditorState.cardIds)];
    if (!ids.length) list.innerHTML = '<div class="empty-state">Deck vide : touchez des cartes de la collection pour les ajouter.</div>';
    ids.forEach(id => {
        const card = collection.find(c => c.id === id);
        const row = document.createElement('div');
        row.className = 'deck-line' + (card ? '' : ' missing');
        if (card) row.appendChild(makeMiniCard(card, 0.1));
        const info = document.createElement('div');
        info.className = 'deck-line-info';
        const name = document.createElement('strong');
        name.textContent = card ? (card.name || 'Sans nom') : 'Carte supprimée';
        const meta = document.createElement('span');
        meta.textContent = card ? `${TYPES[card.type] || ''} · coût ${card.mana}` : 'Retirez-la du deck';
        info.append(name, meta);
        const qty = document.createElement('div');
        qty.className = 'qty';
        const n = document.createElement('span');
        n.textContent = `×${deckCopies(id)}`;
        qty.append(
            sheetButton('', () => { const i = deckEditorState.cardIds.lastIndexOf(id); deckEditorState.cardIds.splice(i, 1); deckEditorState.dirty = true; renderDeckContents(); }, 'btn-secondary btn-icon', 'minus'),
            n,
            sheetButton('', () => { if (!card) return; deckEditorState.cardIds.push(id); deckEditorState.dirty = true; renderDeckContents(); }, 'btn-secondary btn-icon', 'plus')
        );
        row.append(info, qty);
        list.appendChild(row);
    });
    refreshPoolCounts();
}

async function saveDeckFromEditor() {
    const name = document.getElementById('deckNameInput').value.trim();
    if (!name) return toast('Donnez un nom à votre deck.', { tone: 'warning' });
    if (!deckEditorState.cardIds.length) return toast('Ajoutez au moins une carte au deck.', { tone: 'warning' });
    const deck = { id: deckEditorState.id || 'deck_' + Date.now(), name, cardIds: [...deckEditorState.cardIds] };
    const idx = myDecks.findIndex(d => d.id === deck.id);
    if (idx === -1) myDecks.push(deck); else myDecks[idx] = deck;
    deckEditorState.dirty = false;
    renderDeckSelect();
    closeDeckEditor();
    await saveDecks();
}

async function duplicateDeck(id) {
    const deck = myDecks.find(d => d.id === id);
    if (!deck) return;
    myDecks.push({ id: 'deck_' + Date.now(), name: `${deck.name} (copie)`, cardIds: [...deck.cardIds] });
    renderDeckGrid();
    renderDeckSelect();
    await saveDecks();
}

async function deleteDeck(id) {
    const deck = myDecks.find(d => d.id === id);
    if (!deck || !(await tcgConfirm(`Le deck « ${deck.name} » sera supprimé de tous vos appareils.`, { title: 'Supprimer le deck ?', confirmLabel: 'Supprimer', danger: true }))) return;
    myDecks = myDecks.filter(d => d.id !== id);
    renderDeckGrid();
    renderDeckSelect();
    await saveDecks();
}
