const formatTime = (value) => {
    if (!value) return "Soon";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Soon";
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
                    <div class="hero-badge">Campus Betting Platform</div>
                    <h1>Bet on <span class="highlight">Campus</span><br>Win Rewards</h1>
                    <p class="hero-subtitle">
                        Place bets on campus events with virtual points. Win real rewards like homework help, AI credits, and exclusive perks.
                    </p>
                    <div class="hero-actions">
                        <a class="btn primary large" href="/signup" data-link>Start Betting</a>
                        <a class="btn ghost large" href="#markets">View Markets</a>
                    </div>

                    <div class="hero-stats">
                        <div class="stat">
                            <span class="stat-value">1000</span>
                            <span class="stat-label">Starting Points</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">0%</span>
                            <span class="stat-label">Real Money</span>
                        </div>
                        <div class="stat">
                            <span class="stat-value">Live</span>
                            <span class="stat-label">Updates</span>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Features Section -->
            <section class="features-section">
                <div class="section-header">
                    <span class="section-badge">How It Works</span>
                    <h2>Simple, Fun, Rewarding</h2>
                    <p>No real money involved. Just pure campus competition.</p>
                </div>

                <div class="features-grid">
                    <div class="feature-card">
                        <div class="feature-icon">+</div>
                        <h3>Get Free Points</h3>
                        <p>Start with 1000 points for free. No deposit required, no credit card needed.</p>
                    </div>
                    <div class="feature-card">
                        <div class="feature-icon">*</div>
                        <h3>Bet on Events</h3>
                        <p>From exam results to campus happenings - bet on what matters to students.</p>
                    </div>
                    <div class="feature-card">
                        <div class="feature-icon">></div>
                        <h3>Win Rewards</h3>
                        <p>Exchange points for homework help, AI queries, priority support, and more.</p>
                    </div>
                </div>
            </section>

            <!-- Markets Section -->
            <section class="markets-section" id="markets">
                <div class="markets-header">
                    <div class="markets-title">
                        <h2>Live Markets</h2>
                        <p>Real-time odds on campus events</p>
                    </div>
                    <span class="status-pill" data-odds-status>Offline</span>
                </div>

                <div class="markets-layout">
                    <div class="odds-grid" data-odds-grid></div>

                    <aside class="bet-slip">
                        <div class="bet-slip-header">
                            <h3>Bet Slip</h3>
                            <span class="badge" data-slip-count>0</span>
                        </div>
                        <div class="bet-slip-list" data-slip-list></div>
                        <div class="bet-slip-summary">
                            <label class="field">
                                <span>Stake (points)</span>
                                <input type="number" min="1" value="10" placeholder="Enter stake" data-stake>
                            </label>
                            <div class="summary-row">
                                <span>Potential Return</span>
                                <strong data-return>0 pts</strong>
                            </div>
                            <button class="btn primary" type="button" data-place-bet disabled>Place Bet</button>
                            <button class="btn ghost" type="button" data-clear-slip>Clear Slip</button>
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
            oddsGrid.innerHTML = `<div class="empty">Waiting for live odds...</div>`;
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
            slipList.innerHTML = `<div class="empty">No selections yet</div>`;
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
                        <button class="slip-remove" type="button" data-slip-remove="${item.id}">Remove</button>
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
            connecting: "Connecting",
            connected: "Live",
            disconnected: "Disconnected",
            error: "Error",
            closed: "Closed",
            offline: "Offline"
        };
        statusPill.textContent = statusMap[snapshot.oddsStatus] || "Offline";
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
        slipStatus.textContent = "Bet placed successfully!";
        slipStatus.classList.remove("error");
        slipStatus.classList.add("success");
        state.clearSlip();
    };

    const handleClearSlip = () => {
        state.clearSlip();
        slipStatus.textContent = "Slip cleared";
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
