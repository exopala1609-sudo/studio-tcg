// Sets : extensions partagées par le groupe (nom, code, symbole, numérotation)

const SET_SYMBOLS = [
    'beer', 'crown', 'flame', 'droplets', 'leaf', 'tree-pine', 'sun', 'moon', 'star', 'zap',
    'snowflake', 'mountain', 'castle', 'shield', 'sword', 'skull', 'ghost', 'gem', 'key', 'eye',
    'feather', 'bird', 'flower-2', 'anchor', 'compass', 'hourglass', 'scroll', 'flag'
];

// Couleur du symbole selon la rareté. Écrite en dur dans le SVG : indispensable pour l'export PNG.
const RARITY_SYMBOL_COLORS = {
    common: '#a1a1aa', uncommon: '#e2e8f0', rare: '#f5c451', epic: '#c9a0ff', legendary: '#fff1c2'
};

let sets = [];
let setsTableMissing = false;
let setsChannel = null;
let setEditorState = null;   // { id, symbol, assignToCard }

const padNum = n => String(n).padStart(3, '0');

// ---------- Données ----------
function rowToSet(row) {
    return {
        id: row.id,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        code: row.code,
        name: row.name,
        symbol: row.data?.symbol || 'star',
        total: Number(row.data?.total) || 0,
        description: row.data?.description || '',
        filter: row.data?.filter || 'none'
    };
}

function setToRow(set) {
    return { code: set.code, name: set.name, data: { symbol: set.symbol, total: set.total, description: set.description, filter: set.filter || 'none' } };
}

function readLocalSets() {
    try { return JSON.parse(localStorage.getItem('tcg_sets') || '[]'); } catch (e) { return []; }
}

function writeLocalSets() {
    try { localStorage.setItem('tcg_sets', JSON.stringify(sets)); } catch (e) {}
}

function isOwnSet(set) {
    return !isCloudActive() || set.ownerId === currentUser.id;
}

async function reloadSets() {
    if (isCloudActive()) {
        const { data, error } = await sb.from('sets').select('*').order('created_at');
        if (error) {
            sets = [];
            setsTableMissing = error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message);
            if (setsTableMissing) toast("Les sets ne sont pas encore activés : lancez le script SQL des sets dans Supabase.", { tone: 'warning', duration: 9000 });
            else cloudError('Impossible de charger les sets', error);
        } else {
            setsTableMissing = false;
            sets = data.map(rowToSet);
            startSetsRealtime();
        }
    } else {
        sets = readLocalSets();
    }
    refreshSetUI();
}

// Canal séparé : tant que la table n'existe pas, le temps réel des cartes n'est pas perturbé
function startSetsRealtime() {
    if (setsChannel || !isCloudActive()) return;
    setsChannel = sb.channel('studio-sets')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sets' }, () => reloadSets())
        .subscribe();
}

function stopSetsRealtime() {
    if (setsChannel) sb.removeChannel(setsChannel);
    setsChannel = null;
}

// Set d'une carte : par identifiant, ou pour les anciennes cartes, par nom de set
function findSetForCard(card) {
    if (card?.setId) {
        const byId = sets.find(s => s.id === card.setId);
        if (byId) return byId;
    }
    const name = card?.setName?.trim().toLowerCase();
    return name ? sets.find(s => s.name.toLowerCase() === name) || null : null;
}

function cardsInSet(set) {
    return collection.filter(c => findSetForCard(c)?.id === set.id);
}

function usedNumbers(set, exceptCardId) {
    return new Set(cardsInSet(set)
        .filter(c => c.id !== exceptCardId)
        .map(c => parseInt(c.cardNum, 10))
        .filter(Number.isFinite));
}

function nextFreeNumber(set, exceptCardId) {
    const used = usedNumbers(set, exceptCardId);
    let n = 1;
    while (used.has(n)) n++;
    return n;
}

function missingNumbers(set) {
    if (!set.total) return [];
    const used = usedNumbers(set);
    const missing = [];
    for (let n = 1; n <= set.total; n++) if (!used.has(n)) missing.push(n);
    return missing;
}

// [1,2,3,7,9,10] -> "1–3, 7, 9–10"
function compressRanges(nums) {
    const parts = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        parts.push(j > i ? `${nums[i]}–${nums[j]}` : `${nums[i]}`);
        i = j;
    }
    return parts.join(', ');
}

function setSymbolSvg(symbol, rarity = 'rare', size = 13) {
    const key = symbol.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
    const node = window.lucide?.icons?.[key] || window.lucide?.icons?.Star;
    if (!node) return '';
    return window.lucide.createElement(node, {
        width: size, height: size, stroke: RARITY_SYMBOL_COLORS[rarity] || RARITY_SYMBOL_COLORS.common,
        'stroke-width': 2.4, 'aria-hidden': 'true', class: 'set-symbol-svg'
    }).outerHTML;
}

// ---------- Studio : choix du set et numérotation ----------
function selectedSet() {
    return sets.find(s => s.id === document.getElementById('cardSetSelect').value) || null;
}

function renderSetSelect() {
    const select = document.getElementById('cardSetSelect');
    const previous = select.value;
    select.innerHTML = '';
    const add = (value, label) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    };
    add('', 'Aucun set');
    sets.forEach(s => add(s.id, `${s.code} — ${s.name}`));
    if (!setsTableMissing) add('__new__', '+ Créer un nouveau set…');
    select.value = sets.some(s => s.id === previous) ? previous : '';
    syncSetFields();
}

// Le total vient du set choisi (non modifiable) ; sans set, il reste libre
function syncSetFields() {
    const set = selectedSet();
    const total = document.getElementById('cardTotalSetInput');
    total.readOnly = !!set;
    if (set) {
        total.value = set.total ? padNum(set.total) : '';
        document.getElementById('cardSetNameInput').value = set.name;
    }
}

function onCardSetChange() {
    const select = document.getElementById('cardSetSelect');
    if (select.value === '__new__') {
        select.value = '';
        syncSetFields();
        return openSetEditor(null, { assignToCard: true });
    }
    const set = selectedSet();
    if (!set) document.getElementById('cardSetNameInput').value = '';
    syncSetFields();
    // Numéro attribué automatiquement s'il est vide ou déjà pris dans ce set
    const num = parseInt(document.getElementById('cardNumInput').value, 10);
    if (set && (!Number.isFinite(num) || usedNumbers(set, currentCardId).has(num))) autoNumber();
    renderFilterPanel();
    updateCard();
}

function autoNumber() {
    const set = selectedSet();
    if (!set) return toast('Choisissez un set pour numéroter automatiquement.');
    document.getElementById('cardNumInput').value = padNum(nextFreeNumber(set, currentCardId));
    updateCard();
}

// Avertissements : numéro déjà pris, ancien nom de set pas encore créé
function refreshSetHints() {
    const set = selectedSet();
    const conflict = document.getElementById('numConflictHint');
    const num = parseInt(document.getElementById('cardNumInput').value, 10);
    const other = set && Number.isFinite(num)
        ? cardsInSet(set).find(c => c.id !== currentCardId && parseInt(c.cardNum, 10) === num)
        : null;
    conflict.hidden = !other;
    if (other) conflict.querySelector('span').textContent = `Le n° ${padNum(num)} est déjà pris par « ${other.name || 'Sans nom'} ».`;

    const legacy = document.getElementById('legacySetHint');
    const legacyName = document.getElementById('cardSetNameInput').value.trim();
    legacy.hidden = !!set || !legacyName || setsTableMissing;
    if (!legacy.hidden) legacy.querySelector('span').textContent = `Set « ${legacyName} » pas encore créé.`;
}

// ---------- Fenêtre : créer / modifier un set ----------
function openSetEditor(setId, { assignToCard = false, presetName = '' } = {}) {
    if (setsTableMissing) return toast("Lancez d'abord le script SQL des sets dans Supabase.", { tone: 'warning' });
    const set = sets.find(s => s.id === setId);
    if (set && !isOwnSet(set)) return toast(`Seul(e) ${set.ownerName || 'son créateur'} peut modifier ce set.`, { tone: 'warning' });
    setEditorState = { id: set?.id || null, symbol: set?.symbol || 'beer', assignToCard };
    document.getElementById('setEditorTitle').textContent = set ? `Modifier « ${set.name} »` : 'Nouveau set';
    document.getElementById('setNameInput').value = set?.name || presetName;
    const codeInput = document.getElementById('setCodeInput');
    codeInput.value = set?.code || suggestSetCode(presetName);
    // Set existant : le code ne suit plus le nom automatiquement
    if (set) codeInput.dataset.touched = '1'; else delete codeInput.dataset.touched;
    document.getElementById('setTotalInput').value = set?.total || 50;
    document.getElementById('setDescInput').value = set?.description || '';
    document.getElementById('setFilterSelect').value = set?.filter || 'none';
    document.getElementById('setDeleteBtn').hidden = !set;
    renderSymbolGrid();
    openModal('setEditorModal');
    document.getElementById('setNameInput').focus();
}

// "Édition de base" -> "EDB" ; "Dragons" -> "DRA"
function suggestSetCode(name) {
    const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().match(/[A-Z0-9]+/g) || [];
    if (words.length > 1) return words.map(w => w[0]).join('').slice(0, 4);
    return (words[0] || '').slice(0, 3);
}

function onSetNameInput() {
    // Le code suit le nom tant que l'utilisateur ne l'a pas modifié lui-même
    const code = document.getElementById('setCodeInput');
    if (!code.dataset.touched) code.value = suggestSetCode(document.getElementById('setNameInput').value).slice(0, 4);
}

function onSetCodeInput(el) {
    el.dataset.touched = '1';
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

function renderSymbolGrid() {
    const grid = document.getElementById('setSymbolGrid');
    grid.innerHTML = '';
    SET_SYMBOLS.forEach(sym => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'symbol-btn' + (sym === setEditorState.symbol ? ' selected' : '');
        b.title = sym;
        b.innerHTML = setSymbolSvg(sym, 'rare', 22);
        b.onclick = () => { setEditorState.symbol = sym; renderSymbolGrid(); };
        grid.appendChild(b);
    });
    // Aperçu du symbole dans les 5 couleurs de rareté
    document.getElementById('setSymbolPreview').innerHTML =
        Object.keys(RARITY_SYMBOL_COLORS).map(r => `<span title="${RARITIES[r]}">${setSymbolSvg(setEditorState.symbol, r, 20)}</span>`).join('');
}

async function saveSetFromEditor() {
    const name = document.getElementById('setNameInput').value.trim();
    const code = document.getElementById('setCodeInput').value.trim().toUpperCase();
    const total = parseInt(document.getElementById('setTotalInput').value, 10);
    if (!name) return toast('Donnez un nom au set.', { tone: 'warning' });
    if (code.length < 2) return toast('Le code doit faire 2 à 4 lettres ou chiffres.', { tone: 'warning' });
    if (sets.some(s => s.code.toUpperCase() === code && s.id !== setEditorState.id)) return toast(`Le code ${code} est déjà utilisé par un autre set.`, { tone: 'warning' });
    if (!Number.isFinite(total) || total < 1 || total > 999) return toast('Le nombre de cartes prévu doit être entre 1 et 999.', { tone: 'warning' });

    const set = { code, name, total, symbol: setEditorState.symbol, description: document.getElementById('setDescInput').value.trim(), filter: document.getElementById('setFilterSelect').value };
    let savedId = setEditorState.id;
    if (isCloudActive()) {
        const query = savedId
            ? sb.from('sets').update(setToRow(set)).eq('id', savedId)
            : sb.from('sets').insert({ ...setToRow(set), owner_name: displayName(currentUser) });
        const { data, error } = await query.select().single();
        if (error) {
            if (error.code === '23505') return toast(`Le code ${code} est déjà utilisé par un autre set.`, { tone: 'warning' });
            return cloudError("Le set n'a pas pu être enregistré", error);
        }
        savedId = data.id;
        const idx = sets.findIndex(s => s.id === savedId);
        if (idx === -1) sets.push(rowToSet(data)); else sets[idx] = rowToSet(data);
    } else {
        if (!savedId) savedId = 'set_' + Date.now();
        const idx = sets.findIndex(s => s.id === savedId);
        const local = { id: savedId, ownerId: null, ownerName: '', ...set };
        if (idx === -1) sets.push(local); else sets[idx] = local;
        writeLocalSets();
    }

    const assign = setEditorState.assignToCard;
    closeModal('setEditorModal');
    toast(`Set « ${name} » enregistré.`, { tone: 'success' });
    refreshSetUI();
    if (assign) {
        document.getElementById('cardSetSelect').value = savedId;
        onCardSetChange();
    }
}

async function deleteSetFromEditor() {
    const set = sets.find(s => s.id === setEditorState?.id);
    if (!set) return;
    const count = cardsInSet(set).length;
    const ok = await tcgConfirm(
        count ? `Les ${count} carte(s) de ce set garderont son nom en texte, mais ne seront plus reliées au set.` : 'Ce set ne contient aucune carte.',
        { title: `Supprimer le set « ${set.name} » ?`, confirmLabel: 'Supprimer', danger: true });
    if (!ok) return;
    if (isCloudActive()) {
        const { error } = await sb.from('sets').delete().eq('id', set.id);
        if (error) return cloudError("Le set n'a pas pu être supprimé", error);
    }
    sets = sets.filter(s => s.id !== set.id);
    if (!isCloudActive()) writeLocalSets();
    closeModal('setEditorModal');
    refreshSetUI();
}

// ---------- Fenêtre : liste des sets ----------
function openSetList() {
    renderSetList();
    openModal('setListModal');
}

function renderSetList() {
    const list = document.getElementById('setList');
    list.innerHTML = '';
    if (setsTableMissing) {
        list.innerHTML = '<div class="empty-state">Les sets ne sont pas encore activés : lancez le script SQL des sets dans Supabase.</div>';
        return;
    }
    if (!sets.length) list.innerHTML = '<div class="empty-state">Aucun set pour l\'instant. Créez le premier pour numéroter vos cartes.</div>';

    sets.forEach(set => {
        const cards = cardsInSet(set);
        const missing = missingNumbers(set);
        const item = document.createElement('article');
        item.className = 'set-item';
        const pct = set.total ? Math.min(100, Math.round(cards.length / set.total * 100)) : 0;
        item.innerHTML = `
            <div class="set-item-symbol">${setSymbolSvg(set.symbol, 'rare', 30)}</div>
            <div class="set-item-info">
                <h3><span class="set-code"></span><span class="set-name"></span></h3>
                <p class="set-owner"></p>
                <p class="set-desc"></p>
                <div class="set-progress"><div style="width:${pct}%"></div></div>
                <p class="set-stats"></p>
            </div>
            <div class="set-item-actions"></div>`;
        item.querySelector('.set-code').textContent = set.code;
        item.querySelector('.set-name').textContent = set.name;
        item.querySelector('.set-owner').textContent = isCloudActive() ? `par ${isOwnSet(set) ? 'vous' : (set.ownerName || 'un ami')}` : '';
        item.querySelector('.set-desc').textContent = set.description;
        // Plages de numéros libres, regroupées puis raccourcies si la liste est longue
        let free = compressRanges(missing);
        if (free.length > 90) free = free.slice(0, free.lastIndexOf(',', 90)) + '…';
        item.querySelector('.set-stats').textContent =
            `${cards.length} / ${set.total || '?'} cartes` +
            (missing.length && missing.length < set.total ? ` · numéros libres : ${free}` : '');
        const actions = item.querySelector('.set-item-actions');
        actions.append(sheetButton('Voir les cartes', () => showSetInBinder(set.id), 'btn-secondary', 'library'));
        if (isOwnSet(set)) actions.append(sheetButton('Modifier', () => openSetEditor(set.id), 'btn-secondary', 'pencil'));
        list.appendChild(item);
    });

    // Noms de set tapés à la main (anciennes cartes) qui n'ont pas encore de set
    const orphanNames = new Map();
    collection.forEach(c => {
        const name = c.setName?.trim();
        if (name && !findSetForCard(c)) orphanNames.set(name, (orphanNames.get(name) || 0) + 1);
    });
    if (orphanNames.size) {
        const box = document.createElement('div');
        box.className = 'set-orphans';
        const title = document.createElement('h4');
        title.textContent = 'Noms de set trouvés sur des cartes, sans set créé';
        box.appendChild(title);
        orphanNames.forEach((count, name) => {
            const row = document.createElement('div');
            row.className = 'set-orphan';
            const label = document.createElement('span');
            label.textContent = `« ${name} » · ${count} carte${count > 1 ? 's' : ''}`;
            row.append(label, sheetButton('Créer ce set', () => openSetEditor(null, { presetName: name }), 'btn-small', 'plus'));
            box.appendChild(row);
        });
        list.appendChild(box);
    }
}

function showSetInBinder(setId) {
    closeModal('setListModal');
    setMainView('collection');
    document.getElementById('collectionSetFilter').value = setId;
    renderCollection();
}

// ---------- Classeur : filtre par set ----------
function renderCollectionSetFilter() {
    const select = document.getElementById('collectionSetFilter');
    const previous = select.value;
    select.innerHTML = '<option value="">Tous les sets</option>';
    sets.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.code} — ${s.name}`;
        select.appendChild(opt);
    });
    const none = document.createElement('option');
    none.value = '__none__';
    none.textContent = 'Sans set';
    select.appendChild(none);
    select.value = [...select.options].some(o => o.value === previous) ? previous : '';
}

function matchesSetFilter(card) {
    const filter = document.getElementById('collectionSetFilter').value;
    if (!filter) return true;
    const set = findSetForCard(card);
    return filter === '__none__' ? !set : set?.id === filter;
}

function refreshSetUI() {
    renderSetSelect();
    renderFilterPanel();
    renderCollectionSetFilter();
    updateCard();
    if (document.getElementById('setListModal').style.display === 'flex') renderSetList();
    if (isBinderOpen()) renderCollection();
}
