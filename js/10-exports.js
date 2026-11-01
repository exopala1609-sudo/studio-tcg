// Imports / exports : JSON, PNG, Tabletop Simulator, galerie, planches A4

// ---------- Export/Import Fichiers JSON (Partage amis) ----------
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportSingleCardJSON() {
    const card = readForm();
    downloadJSON(card, `${(card.name || 'carte').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_carte.json`);
}

function importSingleCard(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            loadCardIntoForm(JSON.parse(e.target.result), false);
            alert("Carte importée avec succès !");
        } catch(err) {
            alert("Erreur lors de l'importation du fichier JSON.");
        }
    };
    reader.readAsText(file);
    event.target.value = "";
}

function exportDeck() {
    if (collection.length === 0) {
        alert("Votre collection est vide.");
        return;
    }
    downloadJSON(collection, `mon_deck_tcg_${Date.now()}.json`);
}

function importDeck(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(e) {
        let imported;
        try {
            imported = JSON.parse(e.target.result);
        } catch(err) {
            return alert("Erreur lors de l'importation du deck.");
        }
        if (!Array.isArray(imported)) return alert("Le fichier ne contient pas un deck valide.");

        if (isCloudActive()) {
            try {
                await insertCardsInCloud(imported.map(normalizeCard));
                await reloadCollection();
            } catch (err) {
                setCloudIdle();
                return cloudError("L'import du deck dans le cloud a échoué", err);
            }
        } else {
            const ids = new Set(collection.map(c => c.id));
            collection = [...collection, ...imported.map(c => normalizeCard({ ...c, id: ids.has(c.id) ? null : c.id }))];
            saveCollectionToStorage();
            renderCollection();
        }
        alert(`${imported.length} cartes ont été ajoutées à votre collection !`);
    };
    reader.readAsText(file);
    event.target.value = "";
}

// ---------- Export Image HD de la carte courante ----------
// Les PNG partent toujours d'un clone neuf rendu hors écran : ni la vue 3D,
// ni le défilement de la page ne peuvent déformer l'export
async function downloadCardImage() {
    const d = readForm({ preview: true });
    await getImageRatio(d.imageSrc || DEFAULT_ART);
    await downloadClone(makeCardClone(d), d.name || 'carte_tcg');
}

function downloadBackImage() {
    return downloadClone(makeBackClone(), 'verso_tcgbp');
}

async function downloadClone(clone, name) {
    await document.fonts.ready;
    const canvas = await renderOffscreen(clone, 3, null);
    const link = document.createElement('a');
    link.download = `${name}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

// ---------- Export Tabletop Simulator (ZIP) ----------
const TTS_MAX_PER_SHEET = 69;   // TTS : 10x7 cases, la dernière est réservée à la carte "cachée"
const TTS_COLS = 10;

function slugify(s) {
    return (s || 'carte').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'carte';
}

function waitForImages(el) {
    return Promise.all([...el.querySelectorAll('img')].map(img =>
        img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })
    ));
}

// Rend un élément hors écran (il doit être dans le DOM pour html2canvas)
async function renderOffscreen(el, scale, backgroundColor = '#111111') {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-20000px;top:0;';
    el.style.boxShadow = 'none';
    host.appendChild(el);
    document.body.appendChild(host);
    try {
        await waitForImages(el);
        return await html2canvas(el, { scale, useCORS: true, backgroundColor });
    } finally {
        host.remove();
    }
}

const canvasToBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

async function exportTabletopZip() {
    if (typeof JSZip === 'undefined') {
        alert("La librairie ZIP n'a pas pu être chargée (connexion internet nécessaire).");
        return;
    }
    const cards = collection.length ? collection : [readForm({ preview: true })];
    const btn = document.getElementById('ttsExportBtn');
    const label = btn.innerHTML;
    btn.disabled = true;

    try {
        await document.fonts.ready;
        const SCALE = 1.5;
        const zip = new JSZip();
        const canvases = [];

        for (let i = 0; i < cards.length; i++) {
            btn.textContent = `Carte ${i + 1}/${cards.length}…`;
            await getImageRatio(cards[i].imageSrc || DEFAULT_ART);
            const canvas = await renderOffscreen(makeCardClone(cards[i]), SCALE);
            canvases.push(canvas);
            zip.file(`cartes/${String(i + 1).padStart(3, '0')}_${slugify(cards[i].name)}.png`, await canvasToBlob(canvas));
        }

        btn.textContent = 'Verso et planches…';
        const backCanvas = await renderOffscreen(makeBackClone(), SCALE);
        zip.file('tabletop/verso.png', await canvasToBlob(backCanvas));

        const cw = canvases[0].width, ch = canvases[0].height;
        const sheetInfos = [];
        for (let s = 0; s * TTS_MAX_PER_SHEET < canvases.length; s++) {
            const chunk = canvases.slice(s * TTS_MAX_PER_SHEET, (s + 1) * TTS_MAX_PER_SHEET);
            const cols = Math.min(TTS_COLS, chunk.length);
            const rows = Math.ceil(chunk.length / cols);
            const sheet = document.createElement('canvas');
            sheet.width = cols * cw;
            sheet.height = rows * ch;
            const ctx = sheet.getContext('2d');
            chunk.forEach((c, k) => ctx.drawImage(c, (k % cols) * cw, Math.floor(k / cols) * ch, cw, ch));
            const file = `planche_${s + 1}.png`;
            zip.file(`tabletop/${file}`, await canvasToBlob(sheet));
            sheetInfos.push({ file, cols, rows, count: chunk.length });
        }

        zip.file('LISEZMOI.txt', [
            'IMPORT DANS TABLETOP SIMULATOR',
            '================================',
            '',
            '1. Dans TTS : Objets > Composants > Personnalisé > Deck (Objects > Components > Custom > Deck).',
            '2. Cliquez sur la table pour poser le deck, la fenêtre d\'import s\'ouvre.',
            '3. Pour chaque planche ci-dessous, créez un deck avec :',
            '   - Face : le fichier de la planche (dossier "tabletop")',
            '   - Dos  : tabletop/verso.png  (ne cochez pas "Dos uniques")',
            '   - Largeur / Hauteur / Nombre : voir ci-dessous',
            '4. Au moment d\'importer les images, choisissez "Envoyer vers le Steam Cloud" (Upload)',
            '   pour que vos amis voient les cartes en multijoueur.',
            '',
            ...sheetInfos.map(s => `- ${s.file} : Largeur ${s.cols}, Hauteur ${s.rows}, Nombre ${s.count}`),
            '',
            'Le dossier "cartes" contient aussi chaque carte en PNG individuel.'
        ].join('\r\n'));

        btn.textContent = 'Compression…';
        const blob = await zip.generateAsync({ type: 'blob' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `deck_tabletop_${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    } catch (err) {
        alert("Erreur pendant l'export Tabletop Simulator : " + err.message);
    } finally {
        btn.innerHTML = label;
        btn.disabled = false;
    }
}

// ---------- Galerie des bordures ----------
function openBorderGallery() {
    const base = readForm({ preview: true });
    const grid = document.getElementById('galleryGrid');
    grid.innerHTML = '<div></div>';

    Object.values(RARITIES).forEach(label => {
        const h = document.createElement('div');
        h.className = 'gallery-label';
        h.textContent = label;
        grid.appendChild(h);
    });

    Object.entries(TYPES).forEach(([type, typeLabel]) => {
        const rowLabel = document.createElement('div');
        rowLabel.className = 'gallery-label';
        rowLabel.textContent = typeLabel;
        grid.appendChild(rowLabel);

        Object.keys(RARITIES).forEach(rarity => {
            const cell = document.createElement('div');
            cell.className = 'gallery-cell';
            cell.title = `${typeLabel} · ${RARITIES[rarity]} — cliquer pour appliquer`;
            cell.appendChild(makeMiniCard({ ...base, type, rarity }, 0.38));
            cell.onclick = () => {
                document.getElementById('cardTypeInput').value = type;
                document.getElementById('rarityInput').value = rarity;
                updateCard();
                closeModal('galleryModal');
            };
            grid.appendChild(cell);
        });
    });

    openModal('galleryModal');
}

// ---------- Planches A4 ----------
function openPrintModal() {
    renderPrintSheets();
    openModal('printModal');
}

function renderPrintSheets() {
    const container = document.getElementById('printSheetContainer');
    const withBacks = document.getElementById('printBacksCheck').checked;
    container.innerHTML = '';

    // On imprime la collection (ou la carte active si collection vide), 9 cartes par page
    const cardsToPrint = collection.length ? collection : [readForm({ preview: true })];
    for (let i = 0; i < cardsToPrint.length; i += 9) {
        const page = cardsToPrint.slice(i, i + 9);
        const sheet = document.createElement('div');
        sheet.className = 'print-sheet';
        page.forEach(card => {
            const slot = document.createElement('div');
            slot.className = 'print-card-slot';
            slot.appendChild(makeCardClone(card));
            sheet.appendChild(slot);
        });
        container.appendChild(sheet);

        if (withBacks) {
            // Verso : colonnes inversées pour tomber pile derrière chaque recto (retournement bord long)
            const backSheet = document.createElement('div');
            backSheet.className = 'print-sheet';
            for (let k = 0; k < 9; k++) {
                const mirrored = Math.floor(k / 3) * 3 + (2 - k % 3);
                const slot = document.createElement('div');
                slot.className = 'print-card-slot';
                if (mirrored < page.length) slot.appendChild(makeBackClone());
                else slot.style.visibility = 'hidden';
                backSheet.appendChild(slot);
            }
            container.appendChild(backSheet);
        }
    }
}

function openModal(id) {
    const el = document.getElementById(id);
    el.style.display = 'flex';
    pushLayer(id, () => { el.style.display = 'none'; });
}

function closeModal(id) {
    if (!closeLayer(id)) document.getElementById(id).style.display = 'none';
}
