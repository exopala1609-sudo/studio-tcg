// Boîtes de dialogue et notifications aux couleurs de la taverne (remplacent alert / confirm du navigateur)

const DIALOG_ICONS = { info: 'info', success: 'circle-check', warning: 'triangle-alert', error: 'circle-alert', danger: 'trash-2' };

// ---------- Notification discrète, qui disparaît seule ----------
function toast(message, { tone = 'info', duration } = {}) {
    let stack = document.getElementById('toastStack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toastStack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${tone}`;
    el.innerHTML = icon(DIALOG_ICONS[tone] || 'info', 18);
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fermer');
    close.innerHTML = icon('x', 16);
    el.append(text, close);
    stack.appendChild(el);
    while (stack.children.length > 3) stack.firstElementChild.remove();

    let timer = null;
    const dismiss = () => {
        clearTimeout(timer);
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 230);
    };
    close.onclick = dismiss;
    timer = setTimeout(dismiss, duration ?? (tone === 'error' ? 6500 : 3800));
}

// ---------- Boîte de dialogue (bloquante) : renvoie une promesse ----------
let dialogSeq = 0;

function openDialog({ title, message, tone = 'info', buttons, cancelValue }) {
    return new Promise(resolve => {
        const id = `dialog-${++dialogSeq}`;
        const overlay = document.createElement('div');
        overlay.className = 'tcg-dialog-overlay';

        const box = document.createElement('div');
        box.className = `tcg-dialog ${tone}`;
        box.setAttribute('role', 'alertdialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-labelledby', `${id}-title`);
        box.setAttribute('aria-describedby', `${id}-text`);

        const body = document.createElement('div');
        body.className = 'tcg-dialog-body';
        const iconWrap = document.createElement('div');
        iconWrap.className = 'tcg-dialog-icon';
        iconWrap.innerHTML = icon(DIALOG_ICONS[tone] || 'info', 22);
        const textWrap = document.createElement('div');
        const h = document.createElement('h2');
        h.id = `${id}-title`;
        h.textContent = title;
        const p = document.createElement('p');
        p.id = `${id}-text`;
        p.textContent = message;
        textWrap.append(h, p);
        body.append(iconWrap, textWrap);

        const actions = document.createElement('div');
        actions.className = 'tcg-dialog-actions';
        let chosen;
        let closed = false;
        const finish = value => {
            if (closed) return;
            closed = true;
            overlay.remove();
            resolve(value);
        };
        // Le bouton Retour d'Android ferme la boîte comme « Annuler »
        pushLayer(id, () => finish(chosen !== undefined ? chosen : cancelValue));
        const choose = value => {
            chosen = value;
            if (!closeLayer(id)) finish(value);
        };

        let primaryBtn = null;
        buttons.forEach(btnDef => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `btn ${btnDef.className || ''}`;
            if (btnDef.icon) b.innerHTML = icon(btnDef.icon, 16);
            b.appendChild(document.createTextNode(btnDef.label));
            b.onclick = () => choose(btnDef.value);
            if (btnDef.primary) primaryBtn = b;
            actions.appendChild(b);
        });

        overlay.addEventListener('click', e => { if (e.target === overlay) choose(cancelValue); });
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') { e.stopPropagation(); choose(cancelValue); }
        });

        box.append(body, actions);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        (primaryBtn || actions.lastElementChild)?.focus();
    });
}

// Information importante à lire avant de continuer
function tcgAlert(message, { title = 'Information', tone = 'info', okLabel = 'Compris' } = {}) {
    return openDialog({
        title, message, tone, cancelValue: true,
        buttons: [{ label: okLabel, value: true, primary: true }]
    });
}

// Demande de confirmation : résout true (confirmé) ou false (annulé)
function tcgConfirm(message, { title = 'Confirmer', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false, tone } = {}) {
    return openDialog({
        title, message, tone: tone || (danger ? 'danger' : 'warning'), cancelValue: false,
        buttons: [
            { label: cancelLabel, value: false, className: 'btn-secondary' },
            { label: confirmLabel, value: true, primary: true, className: danger ? 'btn-confirm-danger' : '' }
        ]
    });
}
