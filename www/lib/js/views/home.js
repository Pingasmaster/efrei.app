const formatTime = (value) => {
    if (!value) return "Soon";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Soon";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const renderHome = (root, { state }) => {
    root.innerHTML = `
        <div class="home-container">
            <div class="home-hero">
                <p class="hero-eyebrow">Efrei Betting Platform</p>
                <h1>BET ON<br>CAMPUS<br>LIFE</h1>
                <p class="lead">
                    Place bets on what happens at Efrei with points. Win rewards like homework help, AI credits, and exclusive perks. No real money, just pure fun.
                </p>
                <div class="hero-actions">
                    <a class="btn primary" href="/signup" data-link>Start Betting</a>
                    <a class="btn ghost" href="/login" data-link>Sign In</a>
                </div>
            </div>

            <div class="home-sidebar">
                <div class="sidebar-stats">
                    <div class="stat-item">
                        <span class="stat-value">Points System</span>
                        <span class="stat-label">Bet safely with virtual points, not real money</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">Real Rewards</span>
                        <span class="stat-label">Exchange points for homework help & AI queries</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">Live Updates</span>
                        <span class="stat-label">Real-time odds on campus events</span>
                    </div>
                </div>
            </div>
        </div>

        <section class="markets-section">
            <div class="markets">
                <div class="markets-header">
                    <div>
                        <span class="eyebrow">Live Markets</span>
                        <h2>Campus Events</h2>
                    </div>
                    <span class="status-pill" data-odds-status>Offline</span>
                </div>
                <div class="odds-grid" data-odds-grid></div>
            </div>

            <aside class="bet-slip">
                <div class="bet-slip-header">
                    <h3>Bet Slip</h3>
                    <span class="badge" data-slip-count>0</span>
                </div>
                <div class="bet-slip-list" data-slip-list></div>
                <div class="bet-slip-summary">
                    <label class="field">
                        <span>Stake</span>
                        <input type="number" min="1" value="10" data-stake>
                    </label>
                    <div class="summary-row">
                        <span>Potential Return</span>
                        <strong data-return>€0.00</strong>
                    </div>
                    <button class="btn primary" type="button" data-place-bet disabled>Place Bet</button>
                    <button class="btn ghost" type="button" data-clear-slip>Clear Slip</button>
                    <div class="form-status" role="status" aria-live="polite" data-slip-status></div>
                </div>
            </aside>
        </section>
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
                        return `
                            <button class="selection ${selected}" type="button" data-selection-id="${selection.id}" data-event-id="${event.id}" data-label="${selection.label}" data-price="${selection.price}">
                                <span>${selection.label}</span>
                                <strong>${selection.price.toFixed(2)}</strong>
                            </button>
                        `;
                    })
                    .join("");

                return `
                    <article class="event-card">
                        <div class="event-meta">
                            <span class="event-league">${event.league}</span>
                            <span class="event-time">${formatTime(event.startsAt)}</span>
                        </div>
                        <div class="event-teams">
                            <span>${event.home}</span>
                            <span class="versus">vs</span>
                            <span>${event.away}</span>
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
            slipList.innerHTML = `<div class="empty">No selections yet.</div>`;
            placeBetButton.disabled = true;
            returnValue.textContent = "€0.00";
            return;
        }

        slipList.innerHTML = snapshot.betslip
            .map((item) => {
                return `
                    <div class="slip-item">
                        <div>
                            <span class="slip-label">${item.label}</span>
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
        returnValue.textContent = `€${potential.toFixed(2)}`;
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
        slipStatus.textContent = "Bet placed (stub).";
        slipStatus.classList.remove("error");
        slipStatus.classList.add("success");
        state.clearSlip();
    };

    const handleClearSlip = () => {
        state.clearSlip();
        slipStatus.textContent = "Slip cleared.";
        slipStatus.classList.remove("error");
        slipStatus.classList.add("success");
    };

    root.addEventListener("click", handleClick);
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
        stakeInput.removeEventListener("input", handleStakeChange);
        placeBetButton.removeEventListener("click", handlePlaceBet);
        clearSlipButton.removeEventListener("click", handleClearSlip);
        unsubscribe();
    };
};
