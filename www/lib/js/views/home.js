const formatTime = (value) => {
    if (!value) return "Bientot";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Bientot";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const escapeHtml = (value) => {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
};

export const renderHome = (root, { state }) => {
    root.innerHTML = `
        <div class="home-container">
            <!-- Hero Section -->
            <section class="hero">
                <div class="hero-orb orb-1"></div>
                <div class="hero-orb orb-2"></div>
                <div class="hero-orb orb-3"></div>
                <div class="hero-shape"></div>

                <div class="hero-content">
                    <div class="hero-brand">Central E</div>
                    <h1>L'admin <span class="highlight">deteste</span><br>ce site</h1>
                    <p class="hero-subtitle">
                        Bienvenue sur le meilleur myefrei. Consultez votre emploi du temps, vos prochains cours,
                        retrouvez toutes vos taches Moodle et Teams au meme endroit. Pariez sur des evenements
                        du campus, gagnez des points virtuels et echangez-les contre de l'aide aux devoirs,
                        des credits IA et des avantages exclusifs.
                    </p>
                    <div class="hero-actions">
                        <a class="btn primary large" href="/signup" data-link>Commencer</a>
                        <a class="btn ghost large" href="#markets">Voir les paris</a>
                    </div>

                    <div class="hero-stats">
                        <div class="stat">
                            <span class="stat-value">1000</span>
                            <span class="stat-label">Points de depart gratuits</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">0</span>
                            <span class="stat-label">Moderation</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">Proposez</span>
                            <span class="stat-label">Vos propres paris</span>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Features Section -->
            <section class="features-section">
                <div class="section-header">
                    <span class="section-badge">Comment ca marche</span>
                    <h2>Simple, Fun, Gratifiant</h2>
                    <p>Pas d'argent reel. Juste de la competition entre etudiants.</p>
                </div>

                <div class="features-grid">
                    <div class="feature-card">
                        <div class="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                <line x1="16" y1="2" x2="16" y2="6"/>
                                <line x1="8" y1="2" x2="8" y2="6"/>
                                <line x1="3" y1="10" x2="21" y2="10"/>
                            </svg>
                        </div>
                        <h3>Emploi du temps</h3>
                        <p>Consultez votre prochain cours avec salle, batiment et professeur. Tout en un clin d'oeil.</p>
                    </div>
                    <div class="feature-card">
                        <div class="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                                <line x1="16" y1="13" x2="8" y2="13"/>
                                <line x1="16" y1="17" x2="8" y2="17"/>
                            </svg>
                        </div>
                        <h3>Taches unifiees</h3>
                        <p>Moodle, Teams... Toutes vos taches et devoirs reunis au meme endroit avec leurs echeances.</p>
                    </div>
                    <div class="feature-card">
                        <div class="feature-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="8" r="7"/>
                                <polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>
                            </svg>
                        </div>
                        <h3>Gagnez des recompenses</h3>
                        <p>Echangez vos points contre de l'aide aux devoirs, des credits IA et bien plus encore.</p>
                    </div>
                </div>
            </section>

            <!-- Markets Section -->
            <section class="markets-section" id="markets">
                <div class="markets-header">
                    <div class="markets-title">
                        <h2>Paris en direct</h2>
                        <p>Cotes en temps reel sur les evenements du campus</p>
                    </div>
                    <span class="status-pill" data-odds-status>Hors ligne</span>
                </div>

                <div class="markets-layout">
                    <div class="odds-grid" data-odds-grid></div>

                    <aside class="bet-slip">
                        <div class="bet-slip-header">
                            <h3>Bulletin de pari</h3>
                            <span class="badge" data-slip-count>0</span>
                        </div>
                        <div class="bet-slip-list" data-slip-list></div>
                        <div class="bet-slip-summary">
                            <label class="field">
                                <span>Mise (points)</span>
                                <input type="number" min="1" value="10" placeholder="Entrez votre mise" data-stake>
                            </label>
                            <div class="summary-row">
                                <span>Gain potentiel</span>
                                <strong data-return>0 pts</strong>
                            </div>
                            <button class="btn primary" type="button" data-place-bet disabled>Placer le pari</button>
                            <button class="btn ghost" type="button" data-clear-slip>Vider</button>
                            <div class="form-status" role="status" aria-live="polite" data-slip-status></div>
                        </div>
                    </aside>
                </div>
            </section>
        </div>
    `;

    const oddsGrid = root.querySelector("[data-odds-grid]");
    const statusPill = root.querySelector("[data-odds-status]");
    const slipList = root.querySelector("[data-slip-list]");
    const slipCount = root.querySelector("[data-slip-count]");
    const stakeInput = root.querySelector("[data-stake]");
    const returnValue = root.querySelector("[data-return]");
    const placeBetButton = root.querySelector("[data-place-bet]");
    const clearSlipButton = root.querySelector("[data-clear-slip]");
    const slipStatus = root.querySelector("[data-slip-status]");

    const renderOdds = (snapshot) => {
        const selectedIds = new Set(snapshot.betslip.map((item) => item.id));
        if (!snapshot.odds.length) {
            oddsGrid.innerHTML = `<div class="empty">En attente des cotes en direct...</div>`;
            return;
        }

        oddsGrid.innerHTML = snapshot.odds
            .map((event) => {
                const selections = event.markets
                    .map((selection) => {
                        const selected = selectedIds.has(selection.id) ? "selected" : "";
                        const selectionId = escapeHtml(selection.id);
                        const eventId = escapeHtml(event.id);
                        const label = escapeHtml(selection.label);
                        return `
                            <button class="selection ${selected}" type="button" data-selection-id="${selectionId}" data-event-id="${eventId}" data-label="${label}" data-price="${selection.price}">
                                <span>${label}</span>
                                <strong>${selection.price.toFixed(2)}</strong>
                            </button>
                        `;
                    })
                    .join("");

                const league = escapeHtml(event.league);
                const home = escapeHtml(event.home);
                const away = escapeHtml(event.away);
                return `
                    <article class="event-card">
                        <div class="event-meta">
                            <span class="event-league">${league}</span>
                            <span class="event-time">${formatTime(event.startsAt)}</span>
                        </div>
                        <div class="event-teams">
                            <span>${home}</span>
                            <span class="versus">vs</span>
                            <span>${away}</span>
                        </div>
                        <div class="event-selections">
                            ${selections}
                        </div>
                    </article>
                `;
            })
            .join("");
    };

    const renderSlip = (snapshot) => {
        slipCount.textContent = snapshot.betslip.length;
        if (!snapshot.betslip.length) {
            slipList.innerHTML = `<div class="empty">Aucune selection</div>`;
            placeBetButton.disabled = true;
            returnValue.textContent = "0 pts";
            return;
        }

        slipList.innerHTML = snapshot.betslip
            .map((item) => {
                const label = escapeHtml(item.label);
                return `
                    <div class="slip-item">
                        <div>
                            <span class="slip-label">${label}</span>
                            <span class="slip-odds">${item.price.toFixed(2)}</span>
                        </div>
                        <button class="slip-remove" type="button" data-slip-remove="${item.id}">Retirer</button>
                    </div>
                `;
            })
            .join("");

        const stake = Number(stakeInput.value || 0);
        const combinedOdds = snapshot.betslip.reduce((total, item) => total * item.price, 1);
        const potential = stake > 0 ? stake * combinedOdds : 0;
        returnValue.textContent = `${Math.round(potential)} pts`;
        placeBetButton.disabled = false;
    };

    const renderStatus = (snapshot) => {
        const statusMap = {
            connecting: "Connexion...",
            connected: "En direct",
            disconnected: "Deconnecte",
            error: "Erreur",
            closed: "Ferme",
            offline: "Hors ligne"
        };
        statusPill.textContent = statusMap[snapshot.oddsStatus] || "Hors ligne";
        statusPill.dataset.status = snapshot.oddsStatus;
    };

    const handleClick = (event) => {
        const selection = event.target.closest("[data-selection-id]");
        if (selection) {
            const selectionId = selection.dataset.selectionId;
            if (state.betslip.some((item) => item.id === selectionId)) {
                state.removeSlip(selectionId);
                return;
            }
            const payload = {
                id: selectionId,
                eventId: selection.dataset.eventId,
                label: selection.dataset.label,
                price: Number(selection.dataset.price)
            };
            state.addSlip(payload);
            return;
        }

        const remove = event.target.closest("[data-slip-remove]");
        if (remove) {
            state.removeSlip(remove.dataset.slipRemove);
            return;
        }
    };

    const handleStakeChange = () => {
        const snapshot = {
            odds: state.odds,
            betslip: state.betslip,
            oddsStatus: state.oddsStatus
        };
        renderSlip(snapshot);
    };

    const handlePlaceBet = () => {
        slipStatus.textContent = "Pari place avec succes!";
        slipStatus.classList.remove("error");
        slipStatus.classList.add("success");
        state.clearSlip();
    };

    const handleClearSlip = () => {
        state.clearSlip();
        slipStatus.textContent = "Bulletin vide";
        slipStatus.classList.remove("error");
        slipStatus.classList.add("success");
    };

    // Smooth scroll for anchor links
    const handleAnchorClick = (event) => {
        const link = event.target.closest('a[href^="#"]');
        if (link) {
            event.preventDefault();
            const targetId = link.getAttribute("href").slice(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                targetElement.scrollIntoView({ behavior: "smooth" });
            }
        }
    };

    root.addEventListener("click", handleClick);
    root.addEventListener("click", handleAnchorClick);
    stakeInput.addEventListener("input", handleStakeChange);
    placeBetButton.addEventListener("click", handlePlaceBet);
    clearSlipButton.addEventListener("click", handleClearSlip);

    const unsubscribe = state.subscribe((snapshot) => {
        renderStatus(snapshot);
        renderOdds(snapshot);
        renderSlip(snapshot);
    });

    return () => {
        root.removeEventListener("click", handleClick);
        root.removeEventListener("click", handleAnchorClick);
        stakeInput.removeEventListener("input", handleStakeChange);
        placeBetButton.removeEventListener("click", handlePlaceBet);
        clearSlipButton.removeEventListener("click", handleClearSlip);
        unsubscribe();
    };
};
