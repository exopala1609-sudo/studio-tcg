// Collection (Supabase ou navigateur) et temps réel

// ---------- Collection : table Supabase "cards" (connecté) ou navigateur (hors ligne) ----------
let collectionOwnerKey = null;   // id de l'utilisateur dont la collection est chargée, 'local' hors ligne

// Ligne de la table "cards" <-> carte du Studio
function rowToCard(row) {
    return normalizeCard({ ...row.data, id: row.id, imageSrc: row.image_url || '', ownerId: row.owner_id, ownerName: row.owner_name });
}

function cardToRow(card) {
    const { id, imageSrc, ownerId, ownerName, ...data } = card;
    return { data, image_url: imageSrc || null };
}

// Une carte encore en base64 (ancienne carte, envoi raté...) voit son image envoyée dans le bucket
async function ensureCloudImage(card) {
    if (!card.imageSrc || !card.imageSrc.startsWith('data:')) return card;
    return { ...card, imageSrc: await uploadImage(card.imageSrc, currentUser.id) };
}

async function withCloudStatus(label, fn) {
    setCloudStatus(label);
    try {
        return await fn();
    } finally {
        setCloudIdle();
    }
}

function cloudError(message, err) {
    console.error(message, err);
    toast(`${message} : ${err?.message || err}`, { tone: 'error' });
}

function isOwnCard(card) {
    return !isCloudActive() || card.ownerId === currentUser.id;
}

async function reloadCollection() {
    if (isCloudActive()) {
        const { data, error } = await sb.from('cards').select('*').order('created_at');
        if (error) return cloudError('Impossible de charger les cartes du cloud', error);
        collection = data.map(rowToCard);
    } else {
        collection = readLocalCollection();
    }
    setCurrentCard(currentCardId);
    updateMigrationButton();
    refreshSetUI();
}

function clearLoadedCollection() {
    collection = [];
    setCurrentCard(null);
    updateMigrationButton();
}

// ---------- Temps réel : les changements des autres joueurs arrivent sans recharger ----------
let realtimeChannel = null;
let realtimeLive = false;
let realtimeHadError = false;
let renderTimer = null;

function setCloudIdle() {
    setCloudStatus('En ligne', 'ok');
    document.getElementById('cloudStatus').title = realtimeLive ? 'Synchronisation en temps réel active' : 'Connecté au cloud';
}

// Regroupe les rafraîchissements (un import de 30 cartes = 30 événements, 1 seul affichage)
function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => setCurrentCard(currentCardId), 120);
}

// Comparaison indépendante de l'ordre des clés (Postgres réordonne les objets JSON)
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function handleCardChange(payload) {
    if (payload.eventType === 'DELETE') {
        const id = payload.old?.id;
        if (!collection.some(c => c.id === id)) return;
        collection = collection.filter(c => c.id !== id);
        if (id === currentCardId) {
            currentCardId = null;
            setTimeout(() => tcgAlert("Son auteur vient de la supprimer. Vous pouvez l'enregistrer comme nouvelle carte avec « Ajouter à la collection ».", { title: 'Carte supprimée', tone: 'warning' }), 0);
        }
        scheduleRender();
        return;
    }

    const card = rowToCard(payload.new);
    const idx = collection.findIndex(c => c.id === card.id);
    if (idx === -1) collection.push(card);
    else collection[idx] = card;

    // Quelqu'un d'autre a modifié la carte ouverte dans l'éditeur : on ne touche pas au formulaire
    const changedUnderMe = card.id === currentCardId && payload.eventType === 'UPDATE' &&
        stableStringify(normalizeCard({ ...readForm(), id: card.id, ownerId: card.ownerId, ownerName: card.ownerName })) !== stableStringify(card);
    scheduleRender();
    if (changedUnderMe) {
        setTimeout(() => {
            document.getElementById('editingBadge').textContent =
                `« ${card.name || 'Sans nom'} » vient d'être modifiée par un autre joueur. Cliquez sur la carte dans la collection pour voir sa version, ou « Mettre à jour » pour garder la vôtre.`;
        }, 150);
    }
}

function handleSettingChange(payload) {
    if (payload.new?.key !== 'back_image') return;
    backImageSrc = payload.new.value || '';
    try { localStorage.setItem('tcg_back', backImageSrc); } catch (e) {}
    applyBack();
}

function startRealtime() {
    stopRealtime();
    realtimeChannel = sb.channel('studio-tcg')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, handleCardChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'studio_settings' }, handleSettingChange)
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                realtimeLive = true;
                setCloudIdle();
                // Après une coupure (wifi, mise en veille...), on recharge pour récupérer ce qu'on a manqué
                if (realtimeHadError) {
                    realtimeHadError = false;
                    reloadCollection();
                    loadSharedBack();
                }
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                realtimeLive = false;
                realtimeHadError = true;
                setCloudStatus('Reconnexion…', 'error');
            }
        });
}

function stopRealtime() {
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
    realtimeLive = false;
    realtimeHadError = false;
}

async function saveAsNewCard() {
    if (!isCloudActive()) {
        const card = { ...readForm(), id: newId() };
        collection.push(card);
        saveCollectionToStorage();
        setCurrentCard(card.id);
        return;
    }
    try {
        const card = await withCloudStatus('Enregistrement…', async () => {
            const ready = await ensureCloudImage(readForm());
            const { data, error } = await sb.from('cards')
                .insert({ ...cardToRow(ready), owner_name: displayName(currentUser) })
                .select().single();
            if (error) throw error;
            return rowToCard(data);
        });
        // L'événement temps réel de notre propre ajout a pu arriver avant la réponse
        if (!collection.some(c => c.id === card.id)) collection.push(card);
        currentImageSrc = card.imageSrc;
        setCurrentCard(card.id);
    } catch (err) {
        cloudError("L'enregistrement de la carte a échoué", err);
    }
}

async function updateCurrentCard() {
    const idx = collection.findIndex(c => c.id === currentCardId);
    if (idx === -1) return;
    // Jamais d'écrasement de la carte d'un ami : on en fait une copie à mon nom
    if (!isOwnCard(collection[idx])) return saveAsNewCard();
    if (!isCloudActive()) {
        collection[idx] = { ...readForm(), id: currentCardId };
        saveCollectionToStorage();
        setCurrentCard(currentCardId);
        return;
    }
    try {
        const card = await withCloudStatus('Enregistrement…', async () => {
            const ready = await ensureCloudImage(readForm());
            const { data, error } = await sb.from('cards')
                .update(cardToRow(ready))
                .eq('id', currentCardId)
                .select().single();
            if (error) throw error;
            return rowToCard(data);
        });
        collection[idx] = card;
        currentImageSrc = card.imageSrc;
        setCurrentCard(card.id);
    } catch (err) {
        cloudError('La mise à jour de la carte a échoué', err);
    }
}

// Supprime du bucket les images qui ne sont plus utilisées par aucune carte
async function removeUnusedImages(cards) {
    const marker = `/object/public/${CARD_IMAGES_BUCKET}/`;
    const stillUsed = new Set(collection.map(c => c.imageSrc));
    const paths = [...new Set(cards.map(c => c.imageSrc))]
        .filter(url => url && url.includes(marker) && !stillUsed.has(url))
        .map(url => decodeURIComponent(url.split(marker)[1]));
    if (!paths.length) return;
    const { error } = await sb.storage.from(CARD_IMAGES_BUCKET).remove(paths);
    if (error) console.warn('Nettoyage des images :', error);
}

async function deleteCard(id, event) {
    event.stopPropagation();
    const card = collection.find(c => c.id === id);
    if (!card) return;
    if (!isOwnCard(card)) {
        toast(`Seul(e) ${card.ownerName || "l'auteur"} peut supprimer cette carte.`, { tone: 'warning' });
        return;
    }
    if (!(await tcgConfirm(`« ${card.name || 'Sans nom'} » sera supprimée définitivement.`, { title: 'Supprimer la carte ?', confirmLabel: 'Supprimer', danger: true }))) return;

    if (isCloudActive()) {
        try {
            await withCloudStatus('Suppression…', async () => {
                const { error } = await sb.from('cards').delete().eq('id', id);
                if (error) throw error;
            });
        } catch (err) {
            return cloudError('La suppression a échoué', err);
        }
    }
    collection = collection.filter(c => c.id !== id);
    if (isCloudActive()) removeUnusedImages([card]);
    else saveCollectionToStorage();
    setCurrentCard(currentCardId === id ? null : currentCardId);
}

async function clearCollection() {
    if (!isCloudActive()) {
        if (await tcgConfirm("Toutes les cartes enregistrées sur cet appareil seront supprimées.", { title: 'Vider la collection ?', confirmLabel: 'Tout supprimer', danger: true })) {
            collection = [];
            saveCollectionToStorage();
            setCurrentCard(null);
        }
        return;
    }
    const mine = collection.filter(isOwnCard);
    if (!mine.length) return toast("Vous n'avez aucune carte à supprimer.");
    if (!(await tcgConfirm(`Vos ${mine.length} cartes seront supprimées du cloud. Les cartes de vos amis ne sont pas touchées.`, { title: 'Vider votre collection ?', confirmLabel: 'Supprimer mes cartes', danger: true }))) return;
    try {
        await withCloudStatus('Suppression…', async () => {
            const { error } = await sb.from('cards').delete().eq('owner_id', currentUser.id);
            if (error) throw error;
        });
    } catch (err) {
        return cloudError('La suppression a échoué', err);
    }
    collection = collection.filter(c => !isOwnCard(c));
    removeUnusedImages(mine);
    setCurrentCard(null);
}

// Insère plusieurs cartes d'un coup (import de deck, migration des cartes locales)
async function insertCardsInCloud(cards) {
    const rows = [];
    for (let i = 0; i < cards.length; i++) {
        setCloudStatus(`Envoi ${i + 1}/${cards.length}…`);
        const ready = await ensureCloudImage(cards[i]);
        rows.push({ ...cardToRow(ready), owner_name: displayName(currentUser) });
    }
    const { error } = await sb.from('cards').insert(rows);
    setCloudIdle();
    if (error) throw error;
}

// Cartes créées avant le passage au cloud, encore dans ce navigateur
function updateMigrationButton() {
    const btn = document.getElementById('migrateBtn');
    const count = isCloudActive() ? readLocalCollection().length : 0;
    btn.hidden = count === 0;
    btn.innerHTML = icon('cloud-upload') + `Envoyer mes ${count} carte(s) locale(s) dans le cloud`;
}

async function migrateLocalCards() {
    const local = readLocalCollection();
    if (!local.length || !(await tcgConfirm(`Vos ${local.length} carte(s) enregistrée(s) sur cet appareil vont rejoindre la collection partagée.`, { title: 'Envoyer dans le cloud ?', confirmLabel: 'Envoyer', tone: 'info' }))) return;
    const btn = document.getElementById('migrateBtn');
    btn.disabled = true;
    try {
        await insertCardsInCloud(local);
        // Copie de sécurité gardée dans le navigateur, au cas où
        localStorage.setItem('tcg_collection_backup', localStorage.getItem('tcg_collection'));
        localStorage.removeItem('tcg_collection');
        toast(`${local.length} carte(s) envoyée(s) dans le cloud.`, { tone: 'success' });
        await reloadCollection();
    } catch (err) {
        setCloudIdle();
        cloudError("L'envoi des cartes locales a échoué (rien n'a été effacé)", err);
    } finally {
        btn.disabled = false;
    }
}
